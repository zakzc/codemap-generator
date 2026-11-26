import { posix } from "node:path";
import { PY_STDLIB } from "./stdlib.ts";
import type { Resolved } from "./typescript.ts";

export type PyCtx = {
  files: Set<string>;
  pkgDirOf: (path: string) => string | undefined;     // deepest package folder holding the file
  pipDeps: (pkgDir: string | undefined) => string[];  // requirement names (lowercase) of that package
};

// import name → distribution name, for the usual mismatches (Spec 1 §4.4)
const ALIAS: Record<string, string> = {
  fitz: "pymupdf", yaml: "pyyaml", PIL: "pillow", cv2: "opencv-python", sklearn: "scikit-learn", bs4: "beautifulsoup4",
  dotenv: "python-dotenv", jwt: "pyjwt", dateutil: "python-dateutil", skimage: "scikit-image", Crypto: "pycryptodome", serial: "pyserial", attr: "attrs",
};
const norm = (s: string) => s.toLowerCase().replace(/[_.]/g, "-");

function moduleFile(dir: string, parts: string[], files: Set<string>): string | undefined {
  const base = posix.normalize(posix.join(dir, ...parts));
  if (parts.length && files.has(`${base}.py`)) return `${base}.py`;
  if (files.has(posix.join(base, "__init__.py"))) return posix.join(base, "__init__.py");
}

/** Candidate roots for an import, in order: package folder, its `src/`, the importing file's folder. */
function roots(spec: string, from: string, ctx: PyCtx): { dir: string; parts: string[] }[] {
  const level = spec.match(/^\.*/)![0].length;
  const parts = spec.slice(level).split(".").filter(Boolean);
  if (level) {
    let dir = posix.dirname(from);
    for (let i = 1; i < level; i++) dir = posix.dirname(dir);
    return [{ dir, parts }];
  }
  const pkg = ctx.pkgDirOf(from) ?? ".";
  return [...new Set([pkg, posix.join(pkg, "src"), posix.dirname(from)])].map((dir) => ({ dir, parts }));
}

export function resolvePython(spec: string, from: string, ctx: PyCtx): Resolved {
  const rel = spec.startsWith(".");
  for (const { dir, parts } of roots(spec, from, ctx)) {
    const hit = moduleFile(dir, parts, ctx.files);
    if (hit) return { kind: "file", path: hit };
  }
  if (rel) return spec.replace(/^\.+/, "") === "" ? { kind: "drop" } : { kind: "unresolved" }; // `from . import x`: x is handled as a submodule
  const top = spec.split(".")[0]!;
  if (PY_STDLIB.has(top)) return { kind: "drop" };
  const dist = ALIAS[top] ?? top;
  const declared = ctx.pipDeps(ctx.pkgDirOf(from)).find((d) => norm(d) === norm(dist));
  return { kind: "external", name: declared ?? norm(dist), eco: "pip" };
}

/** `from pkg import name`: files for names that are submodules of `pkg` (e.g. `from . import parse`). */
export function pythonSubmodules(spec: string, from: string, names: string[], ctx: PyCtx): string[] {
  const out: string[] = [];
  for (const { dir, parts } of roots(spec, from, ctx))
    for (const n of names) {
      if (n === "*") continue;
      const hit = moduleFile(dir, [...parts, n], ctx.files);
      if (hit && !out.includes(hit)) out.push(hit);
    }
  return out;
}
