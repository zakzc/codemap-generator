import { closeSync, lstatSync, openSync, readFileSync, readdirSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { matchesGlob, posix } from "node:path";
import { gitFiles } from "./git.ts";
import type { Diagnostic } from "../types.ts";

const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", ".git", "vendor"]);
const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock"]);
const SOURCE_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "typescript", ".jsx": "typescript", ".mjs": "typescript", ".cjs": "typescript",
  ".py": "python", ".rs": "rust",
};
const ASSET_EXT = new Set([".css", ".json", ".toml", ".html"]);
// Images, fonts and media: shown as asset nodes (so `import logo from "./logo.png"` resolves) but never read or hashed.
const STATIC_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".bmp", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".wav", ".ogg", ".mp4", ".webm"]);
const ASSET_NAME = /^(requirements.*\.txt|setup\.cfg)$/; // Python manifests, read for package names and dependencies
const MAX_SIZE = 1 << 20;

export type SourceFile = { path: string; lang?: string; size: number; generated: boolean; hash: string; content: string };

function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(posix.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...walk(root, p)); } else if (e.isFile()) out.push(p);
  }
  return out;
}

function isBinary(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(8192);
    return buf.subarray(0, readSync(fd, buf, 0, 8192, 0)).includes(0);
  } finally { closeSync(fd); }
}

/** Source files and assets of the repo, sorted by path. Never throws on one bad file. */
export function discoverFiles(root: string, useGit: boolean, ignore: string[] = []): { files: SourceFile[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const skippedDirs = new Set<string>();
  const skip = (path: string, why: string) => diagnostics.push({ level: "info", code: "skipped-file", path, message: `Skipped: ${why}` });
  const listed = (useGit ? gitFiles(root) : null) ?? walk(root);
  const files: SourceFile[] = [];

  for (const path of [...new Set(listed)].sort()) {
    const segs = path.split("/");
    const bad = segs.slice(0, -1).findIndex((s) => SKIP_DIRS.has(s));
    if (bad >= 0) { skippedDirs.add(segs.slice(0, bad + 1).join("/")); continue; }
    if (SKIP_FILES.has(segs.at(-1)!) || ignore.some((g) => matchesGlob(path, g))) { skip(path, "ignored"); continue; }
    const ext = posix.extname(path);
    const lang = SOURCE_LANG[ext];
    const isStatic = STATIC_EXT.has(ext.toLowerCase());
    if (!lang && !isStatic && !ASSET_EXT.has(ext) && !ASSET_NAME.test(segs.at(-1)!)) continue;
    try {
      const abs = posix.join(root, path);
      const st = lstatSync(abs);
      if (!st.isFile()) continue; // symlinks are never followed (Spec 1 §4.1)
      if (isStatic) { files.push({ path, size: st.size, content: "", generated: false, hash: "" }); continue; }
      if (st.size > MAX_SIZE) { skip(path, "over 1 MB"); continue; }
      if (isBinary(abs)) { skip(path, "binary"); continue; }
      const buf = readFileSync(abs);
      const content = buf.toString("utf8");
      files.push({
        path, lang, size: st.size, content,
        generated: /@generated|DO NOT EDIT/.test(content.slice(0, 1024)),
        hash: `sha256:${createHash("sha256").update(buf).digest("hex")}`,
      });
    } catch (e) {
      diagnostics.push({ level: "warn", code: "skipped-file", path, message: `Unreadable: ${(e as Error).message}` });
    }
  }
  for (const d of skippedDirs) skip(d, "generated/vendor folder");
  return { files, diagnostics };
}
