import { builtinModules } from "node:module";
import { posix } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

export type Resolved = { kind: "file"; path: string } | { kind: "external"; name: string; eco?: "pip" } | { kind: "drop" } | { kind: "unresolved" };
export type Ctx = { files: Set<string>; read: (path: string) => string | undefined };

const EXTS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
const BUILTINS = new Set(builtinModules);

function probe(base: string, files: Set<string>): string | undefined {
  base = posix.normalize(base);
  if (files.has(base) && posix.extname(base)) return base;
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, ""); // `./a.js` written for `a.ts`
  for (const b of stem === base ? [base] : [base, stem]) {
    for (const e of EXTS) if (files.has(b + e)) return b + e;
    for (const e of EXTS) if (files.has(`${b}/index${e}`)) return `${b}/index${e}`;
  }
}

type TsConfig = { baseUrl?: string; paths: Record<string, string[]> }; // baseUrl is repo-relative

function loadTsConfig(dir: string, ctx: Ctx, seen = new Set<string>()): TsConfig | undefined {
  const file = posix.join(dir, "tsconfig.json");
  if (seen.has(file)) return;
  seen.add(file);
  const text = ctx.read(file);
  if (text === undefined) return;
  const j = parseJsonc(text) ?? {};
  const o = j.compilerOptions ?? {};
  let parent: TsConfig | undefined;
  if (typeof j.extends === "string" && j.extends.startsWith(".")) {
    const ext = posix.normalize(posix.join(dir, j.extends.endsWith(".json") ? j.extends : `${j.extends}.json`));
    parent = loadTsConfig(posix.dirname(ext), { ...ctx, read: (p) => ctx.read(p === posix.join(posix.dirname(ext), "tsconfig.json") ? ext : p) }, seen);
  }
  const baseUrl = typeof o.baseUrl === "string" ? posix.normalize(posix.join(dir, o.baseUrl)) : parent?.baseUrl;
  // `paths` are relative to baseUrl, or to the tsconfig folder when there is none
  const pathsRoot = baseUrl ?? dir;
  const paths: Record<string, string[]> = { ...parent?.paths };
  for (const [k, v] of Object.entries(o.paths ?? {})) if (Array.isArray(v)) paths[k] = v.map((t) => posix.join(pathsRoot, String(t)));
  return { baseUrl, paths };
}

export function makeResolver(ctx: Ctx) {
  const cache = new Map<string, TsConfig | undefined>();
  const configFor = (from: string) => {
    for (let d = posix.dirname(from); ; d = posix.dirname(d)) {
      if (!cache.has(d)) cache.set(d, loadTsConfig(d, ctx));
      if (cache.get(d)) return cache.get(d);
      if (d === ".") return undefined;
    }
  };

  return (rawSpec: string, from: string): Resolved => {
    const spec = rawSpec.replace(/[?#].*$/, ""); // `?url`, `?raw`
    if (spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0]!)) return { kind: "drop" };
    if (spec.startsWith(".")) {
      const hit = probe(posix.join(posix.dirname(from), spec), ctx.files);
      return hit ? { kind: "file", path: hit } : { kind: "unresolved" };
    }
    const cfg = configFor(from);
    if (cfg) {
      for (const [pat, targets] of Object.entries(cfg.paths)) {
        const star = pat.indexOf("*");
        const m = star < 0 ? spec === pat && "" : spec.startsWith(pat.slice(0, star)) && spec.endsWith(pat.slice(star + 1)) && spec.slice(star, spec.length - (pat.length - star - 1));
        if (m === false) continue;
        for (const t of targets) { const hit = probe(t.replace("*", m as string), ctx.files); if (hit) return { kind: "file", path: hit }; }
      }
      if (cfg.baseUrl !== undefined) { const hit = probe(posix.join(cfg.baseUrl, spec), ctx.files); if (hit) return { kind: "file", path: hit }; }
    }
    const parts = spec.split("/");
    return { kind: "external", name: spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]! };
  };
}
