import { posix } from "node:path";
import type { Diagnostic } from "../types.ts";
import type { SourceFile } from "./files.ts";

export type Pkg = {
  dir: string; name: string; ecosystems: string[];
  deps: Record<string, Record<string, string>>; // ecosystem → package → version range
  entrypoints: string[];                        // repo-relative file paths
};

const MANIFESTS = ["package.json", "Cargo.toml", "pyproject.toml", "setup.cfg", "setup.py"];
const rel = (dir: string, p: string) => posix.normalize(posix.join(dir, p));
const reqName = (s: string) => s.trim().match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0]?.toLowerCase();

/** One package per manifest folder; several manifests in one folder merge into one package. */
export async function findPackages(files: SourceFile[], diagnostics: Diagnostic[]): Promise<Pkg[]> {
  // Loaded only when a TOML manifest exists, so TS/JS-only repos do not need smol-toml.
  let toml: typeof import("smol-toml") | undefined;
  const parseToml = async (s: string) => (toml ??= await import("smol-toml")).parse(s);
  const byDir = new Map<string, Pkg>();
  const paths = new Set(files.map((f) => f.path));
  const warn = (path: string, e: unknown) => diagnostics.push({ level: "warn", code: "parse-error", path, message: `Cannot read manifest: ${(e as Error).message}` });

  for (const f of files) {
    const base = posix.basename(f.path);
    const dir = posix.dirname(f.path);
    const isReq = /^requirements.*\.txt$/.test(base);
    if (!MANIFESTS.includes(base) && !isReq) continue;
    let name: string | undefined, eco: string | undefined;
    const deps: Record<string, string> = {};
    const entry: string[] = [];
    try {
      if (base === "package.json") {
        const j = JSON.parse(f.content);
        eco = "npm"; name = j.name;
        for (const k of ["dependencies", "devDependencies", "peerDependencies"]) Object.assign(deps, j[k]);
        for (const e of [j.main, j.module, ...(typeof j.bin === "string" ? [j.bin] : Object.values(j.bin ?? {}))]) if (typeof e === "string") entry.push(rel(dir, e));
      } else if (base === "Cargo.toml") {
        const t = (await parseToml(f.content)) as any;
        if (!t.package) continue; // workspace-only manifest
        eco = "cargo"; name = t.package.name;
        for (const k of ["dependencies", "dev-dependencies"]) for (const [d, v] of Object.entries(t[k] ?? {})) deps[d] = typeof v === "string" ? v : (v as any)?.version ?? "";
        entry.push(rel(dir, "src/main.rs"), ...(t.bin ?? []).map((b: any) => rel(dir, b.path ?? `src/bin/${b.name}.rs`)));
      } else if (base === "pyproject.toml") {
        const t = (await parseToml(f.content)) as any;
        eco = "pip"; name = t.project?.name ?? t.tool?.poetry?.name;
        for (const r of t.project?.dependencies ?? []) { const n = reqName(r); if (n) deps[n] = ""; }
        // `[project.scripts] cli = "pkg.mod:func"` → the module's file
        for (const target of Object.values<string>(t.project?.scripts ?? {})) {
          const mod = String(target).split(":")[0]!.replace(/\./g, "/");
          entry.push(...[`${mod}.py`, `${mod}/__init__.py`, `src/${mod}.py`, `src/${mod}/__init__.py`].map((c) => rel(dir, c)));
        }
      } else if (isReq) {
        eco = "pip";
        for (const l of f.content.split("\n")) { const n = l.startsWith("-") || l.startsWith("#") ? undefined : reqName(l); if (n) deps[n] = ""; }
      } else eco = "pip"; // setup.cfg / setup.py: package marker only, never executed
    } catch (e) { warn(f.path, e); continue; }

    const pkg = byDir.get(dir) ?? { dir, name: "", ecosystems: [], deps: {}, entrypoints: [] };
    pkg.name ||= name ?? "";
    if (!pkg.ecosystems.includes(eco)) pkg.ecosystems.push(eco);
    pkg.deps[eco] = { ...pkg.deps[eco], ...deps };
    pkg.entrypoints.push(...entry.filter((e) => paths.has(e)));
    byDir.set(dir, pkg);
  }
  return [...byDir.values()].map((p) => ({ ...p, name: p.name || posix.basename(p.dir === "." ? "" : p.dir) })).sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

/** Deepest package folder containing `path`, or undefined. */
export function packageOf(path: string, dirs: Set<string>): string | undefined {
  for (let d = posix.dirname(path); ; d = posix.dirname(d)) {
    if (dirs.has(d)) return d;
    if (d === ".") return undefined;
  }
}
