import { posix } from "node:path";
import type { SourceFile } from "../discover/files.ts";
import { packageOf, type Pkg } from "../discover/packages.ts";
import { buildSymbols } from "./symbols.ts";
import type { Resolved } from "../resolve/typescript.ts";
import type { Config, Diagnostic, Edge, FileFacts, Node } from "../types.ts";

type Input = {
  projectName: string; files: SourceFile[]; facts: FileFacts[]; packages: Pkg[]; config: Config;
  resolve: (spec: string, from: string) => Resolved;
  submodules?: (spec: string, from: string, names: string[]) => string[]; // Python `from pkg import module`
};

const by = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const pkgId = (dir: string) => `pkg:${dir}`;
const PROJECT = "project:";

/** Vite-style `<script type="module" src="/src/main.tsx">` in HTML files (Spec 1 §4.2). */
function htmlEntrypoints(files: SourceFile[]): string[] {
  const paths = new Set(files.map((f) => f.path));
  return files.filter((f) => f.path.endsWith(".html")).flatMap((f) =>
    [...f.content.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/g)]
      .map((m) => posix.normalize(posix.join(posix.dirname(f.path), m[1]!.replace(/^\//, ""))))
      .filter((p) => paths.has(p)));
}

export function buildGraph({ projectName, files, facts, packages, config, resolve, submodules }: Input) {
  const diagnostics: Diagnostic[] = [];
  const nodes = new Map<string, Node>();
  const add = (n: Node) => nodes.set(n.id, n);

  // packages: a synthetic root package catches files outside every manifest
  const pkgs = [...packages];
  const pkgDirs = new Set(pkgs.map((p) => p.dir));
  if (!pkgDirs.has(".") && files.some((f) => !packageOf(f.path, pkgDirs))) {
    pkgs.push({ dir: ".", name: projectName, ecosystems: [], deps: {}, entrypoints: [] });
    pkgDirs.add(".");
  }
  const pkgByDir = new Map(pkgs.map((p) => [p.dir, p]));
  add({ id: PROJECT, kind: "project", name: projectName, parent: null });
  for (const p of pkgs) add({ id: pkgId(p.dir), kind: "package", name: p.name || projectName, parent: PROJECT, path: p.dir });

  // directories (only those holding files) and files
  const entryPaths = new Set(pkgs.flatMap((p) => p.entrypoints));
  const fileIds = new Set<string>();
  for (const f of files) {
    const pdir = packageOf(f.path, pkgDirs);
    if (pdir === undefined) continue; // unreachable: a root package exists whenever a file is outside every package
    const dir = posix.dirname(f.path);
    let parent = pkgId(pdir);
    if (dir !== pdir) {
      for (let d = dir, child: string | undefined; d !== pdir && d !== "."; d = posix.dirname(d)) {
        const up = posix.dirname(d);
        const upId = up === pdir || up === "." ? pkgId(pdir) : `dir:${up}`;
        if (!nodes.has(`dir:${d}`)) add({ id: `dir:${d}`, kind: "directory", name: posix.basename(d), parent: upId, path: d });
        child ??= `dir:${d}`;
        if (child === `dir:${d}`) parent = `dir:${d}`;
      }
    }
    const id = `file:${f.path}`;
    fileIds.add(id);
    const tags = entryPaths.has(f.path) ? ["entry"] : undefined;
    add({
      id, kind: f.lang ? "file" : "asset", name: posix.basename(f.path), parent, path: f.path,
      ...(tags && { tags }),
      ...(f.generated && { meta: { generated: true } }),
    });
  }

  // imports → edges
  const edges = new Map<string, Edge>();
  const fanIn = new Map<string, Set<string>>(), fanOut = new Map<string, Set<string>>();
  const loc = new Map(facts.map((f) => [f.path, f.loc]));
  for (const fx of facts) {
    const from = `file:${fx.path}`;
    for (const e of fx.errors.slice(0, 3)) diagnostics.push({ level: "warn", code: "parse-error", path: fx.path, line: e.line, message: e.message });
    const pdir = packageOf(fx.path, pkgDirs);
    for (const imp of fx.imports) {
      const r = resolve(imp.spec, fx.path);
      const targets: string[] = [];
      if (r.kind === "unresolved" || (r.kind === "file" && !fileIds.has(`file:${r.path}`))) {
        diagnostics.push({ level: "warn", code: "unresolved-import", path: fx.path, line: imp.line, message: `Cannot resolve '${imp.spec}'` });
      } else if (r.kind === "file") targets.push(`file:${r.path}`);
      else if (r.kind === "external") {
        const eco = r.eco ?? "npm";
        const to = `ext:${eco}:${r.name}`;
        if (!nodes.has(to)) {
          const version = pdir !== undefined ? pkgByDir.get(pdir)?.deps[eco]?.[r.name] : undefined;
          add({ id: to, kind: "external", name: r.name, parent: PROJECT, ...(version && { meta: { version } }) });
        }
        targets.push(to);
      }
      for (const m of submodules?.(imp.spec, fx.path, imp.names) ?? []) if (fileIds.has(`file:${m}`)) targets.push(`file:${m}`);
      for (const to of targets) {
        if (to === from) continue;
        const key = `${from}\0imports\0${to}`;
        const e = edges.get(key) ?? { from, to, kind: "imports", count: 0, at: [], meta: { dynamic: true } };
        e.count!++;
        e.at!.push({ path: fx.path, line: imp.line });
        const m = e.meta as { dynamic: boolean };
        m.dynamic &&= !!imp.dynamic;
        edges.set(key, e);
        if (to.startsWith("file:")) {
          (fanOut.get(from) ?? fanOut.set(from, new Set()).get(from)!).add(to);
          (fanIn.get(to) ?? fanIn.set(to, new Set()).get(to)!).add(from);
        }
      }
    }
  }
  for (const e of edges.values()) {
    e.at = e.at!.sort(by((a) => `${a.path}\0${String(a.line).padStart(8, "0")}`)).slice(0, 1);
    e.meta = (e.meta as { dynamic: boolean }).dynamic ? { dynamic: true } : {};
    if (e.count === 1) delete e.count;
    if (!Object.keys(e.meta).length) delete e.meta;
  }

  // symbols (components, hooks, stores, functions…) and their edges; detail rule applied inside
  const entryFiles = new Set([...entryPaths, ...(config.entrypoints ?? []).filter((id) => id.startsWith("file:")).map((id) => id.slice(5)), ...htmlEntrypoints(files), ...facts.filter((f) => f.entry).map((f) => f.path)]);
  const full = config.detail?.full ?? [];
  const sym = buildSymbols({ facts, resolve, fullGlobs: full });
  for (const n of sym.nodes) add(n);
  for (const e of entryFiles) { const n = nodes.get(`file:${e}`); if (n && n.kind === "file") n.tags = [...new Set([...(n.tags ?? []), "entry"])].sort(); }

  // metrics, hubs, entrypoints
  const hub = config.hubFanIn ?? 10;
  const entrypoints: string[] = [];
  for (const n of nodes.values()) {
    if (n.kind === "file" || n.kind === "asset") {
      const m: Record<string, number> = {};
      if (loc.has(n.path!)) m.loc = loc.get(n.path!)!;
      if (sym.hidden.get(n.path!)) m.hiddenSymbols = sym.hidden.get(n.path!)!;
      if (n.kind === "file") { m.fanIn = fanIn.get(n.id)?.size ?? 0; m.fanOut = fanOut.get(n.id)?.size ?? 0; }
      if (Object.keys(m).length) n.metrics = m;
      if (m.fanIn! >= hub) n.tags = [...(n.tags ?? []), "hub"];
      if (n.tags?.includes("entry")) entrypoints.push(n.id);
    }
  }
  for (const id of config.entrypoints ?? []) {
    if (nodes.has(id)) { entrypoints.push(id); const n = nodes.get(id)!; n.tags = [...new Set([...(n.tags ?? []), "entry"])].sort(); }
    else diagnostics.push({ level: "warn", code: "stale-override", message: `entrypoint ${id} does not exist` });
  }

  return {
    nodes: [...nodes.values()].sort(by((n) => n.id)),
    edges: [...edges.values(), ...sym.edges].sort(by((e) => `${e.from}\0${e.kind}\0${e.to}`)),
    entrypoints: [...new Set(entrypoints)].sort(), diagnostics,
  };
}
