import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceFile } from "../discover/files.ts";
import type { FileFacts } from "../types.ts";
import { grammarOf } from "./parse.ts";
import { parseParallel } from "./pool.ts";

export type Stats = { parsed: number; cached: number; historyRead?: number; historyCached?: boolean };
type Entry = { adapter: string; grammar: string; facts: Omit<FileFacts, "path" | "hash"> };

/** Cache entries are tagged with a hash of the adapter sources, so editing an adapter invalidates them by itself. */
const ADAPTER = (() => {
  const h = createHash("sha256");
  for (const f of ["../lang/typescript.ts", "../lang/python.ts", "./parse.ts"]) h.update(readFileSync(new URL(f, import.meta.url)));
  return h.digest("hex").slice(0, 16);
})();

const hex = (f: SourceFile) => f.hash.replace(/^sha256:/, "");

/**
 * Facts for every parseable file: from `<cacheDir>/facts/<sha256>.json` when the content is unchanged (even after a
 * rename), else parsed in the worker pool. Entries not used by this run are deleted. Without `cacheDir`, nothing is read or written.
 */
export async function parseWithCache(files: SourceFile[], opts: { cacheDir?: string; workers?: number; stats?: Stats } = {}): Promise<FileFacts[]> {
  const parseable = files.filter((f) => f.lang === "typescript" || f.lang === "python");
  const dir = opts.cacheDir && join(opts.cacheDir, "facts");
  const facts: FileFacts[] = [];
  const misses: SourceFile[] = [];
  for (const f of parseable) {
    let e: Entry | undefined;
    try { if (dir) e = JSON.parse(readFileSync(join(dir, `${hex(f)}.json`), "utf8")); } catch { /* missing or corrupt: re-parse */ }
    if (e?.adapter === ADAPTER && e.grammar === grammarOf(f.path)) facts.push({ ...e.facts, path: f.path, hash: f.hash });
    else misses.push(f);
  }
  const parsed = await parseParallel(misses, opts.workers);
  facts.push(...parsed);
  if (opts.stats) { opts.stats.parsed = misses.length; opts.stats.cached = parseable.length - misses.length; }

  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      const byPath = new Map(misses.map((f) => [f.path, f]));
      for (const x of parsed) {
        const { path, hash, ...rest } = x;
        writeFileSync(join(dir, `${hex(byPath.get(path)!)}.json`), JSON.stringify({ adapter: ADAPTER, grammar: grammarOf(path), facts: rest } satisfies Entry));
      }
      const used = new Set(parseable.map((f) => `${hex(f)}.json`));
      for (const name of readdirSync(dir)) if (!used.has(name)) rmSync(join(dir, name), { force: true });
    } catch { /* a read-only cache folder must not stop the scan */ }
  }
  return facts.sort((a, b) => (a.path < b.path ? -1 : 1));
}
