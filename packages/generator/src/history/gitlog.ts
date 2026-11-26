import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../discover/git.ts";

export type RawCommit = { hash: string; date: string; subject: string; files: { status: string; path: string; old?: string }[] };

/** Commit hash, committer date, subject and changed files; never authors, bodies or diffs (Spec 1 §4.7.1). */
export function readLog(root: string, max: number, range = "HEAD"): RawCommit[] | null {
  const out = run(root, ["log", "--no-merges", "--no-ext-diff", "--no-textconv", "-M", "--name-status", "-n", String(max), "--format=%x01%H%x02%cI%x02%s", range]);
  if (out === null) return null;
  const commits: RawCommit[] = [];
  for (const block of out.split("\x01").slice(1)) {
    const [head, ...rest] = block.split("\n");
    const [hash, date, ...subject] = head!.split("\x02");
    if (!hash || !date) continue;
    const files = rest.filter(Boolean).flatMap((l) => {
      const [status, a, b] = l.split("\t");
      if (!status || !a) return [];
      return status.startsWith("R") && b ? [{ status: "R", path: b, old: a }] : [{ status: status[0]!, path: a }];
    });
    commits.push({ hash, date, subject: subject.join("\x02"), files });
  }
  return commits;
}

export const isShallow = (root: string) => run(root, ["rev-parse", "--is-shallow-repository"])?.trim() === "true";

/**
 * History with a cache keyed by HEAD (Spec 1 §7): same HEAD → reuse; cached HEAD is an ancestor → read only the new
 * commits; anything else → read again. Raw commits are cached; renames and mapping are recomputed every run.
 */
export function readLogCached(root: string, max: number, cacheDir?: string, stats?: { historyRead?: number; historyCached?: boolean }): RawCommit[] | null {
  const head = run(root, ["rev-parse", "HEAD"])?.trim();
  if (!head) return null;
  const file = cacheDir && join(cacheDir, "history.json");
  let cached: { head: string; max: number; commits: RawCommit[] } | undefined;
  try { if (file) cached = JSON.parse(readFileSync(file, "utf8")); } catch { /* missing or corrupt */ }
  let commits: RawCommit[] | null = null;
  if (cached && cached.max === max && Array.isArray(cached.commits)) {
    if (cached.head === head) { commits = cached.commits; if (stats) stats.historyCached = true; }
    else if (run(root, ["merge-base", "--is-ancestor", cached.head, head]) !== null) {
      const fresh = readLog(root, max, `${cached.head}..HEAD`);
      if (fresh) { commits = [...fresh, ...cached.commits].slice(0, max); if (stats) stats.historyRead = fresh.length; }
    }
  }
  if (!commits) { commits = readLog(root, max); if (stats && commits) stats.historyRead = commits.length; }
  if (file && commits) { try { mkdirSync(cacheDir, { recursive: true }); writeFileSync(file, JSON.stringify({ head, max, commits })); } catch { /* cache is optional */ } }
  return commits;
}
