import type { Edge } from "../types.ts";
import type { RawCommit } from "./gitlog.ts";

export type HistoryConfig = { maxCommits: number; bulkFiles: number; coChangeMin: number; refPatterns: string[] };
export const HISTORY_DEFAULTS: HistoryConfig = { maxCommits: 100, bulkFiles: 50, coChangeMin: 3, refPatterns: ["#\\d+", "\\b[A-Z][A-Z0-9]+-\\d+\\b"] };

export type Commit = { hash: string; date: string; subject: string; files: string[]; bulk?: boolean };
/** What commits add to one feature: matched commits and how many of them touched each file. */
export type Grouping = { id: string; name: string; description?: string; created: boolean; commits: string[]; files: Map<string, number>; nonBulk: number };

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const utc = (d: string) => new Date(d).toISOString().replace(/\.\d+Z$/, "Z");

/** Follows renames newest → oldest, keeps only files that are nodes, flags bulk commits. Output is newest first. */
export function mapCommits(raw: RawCommit[], fileIds: Set<string>, cfg: HistoryConfig): Commit[] {
  const current = new Map<string, string>(); // old path → path it has today
  const now = (p: string) => current.get(p) ?? p;
  const out: Commit[] = [];
  for (const c of raw) {
    const files = new Set<string>();
    for (const f of c.files) {
      if (f.status === "D") continue;
      const cur = now(f.path);
      if (f.status === "R" && f.old) current.set(f.old, cur);
      if (fileIds.has(`file:${cur}`)) files.add(`file:${cur}`);
    }
    if (!files.size) continue;
    out.push({ hash: c.hash.slice(0, 12), date: utc(c.date), subject: c.subject.slice(0, 200), files: [...files].sort(), ...(files.size > cfg.bulkFiles && { bulk: true }) });
  }
  return out.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.hash < b.hash ? -1 : 1));
}

/** Files that usually change together: ≥ coChangeMin shared non-bulk commits and ≥ half of the less-changed file's; each file keeps its 10 strongest. */
export function changesWith(commits: Commit[], cfg: HistoryConfig): Edge[] {
  const per = new Map<string, number>(), pair = new Map<string, number>();
  for (const c of commits) {
    if (c.bulk) continue;
    for (const f of c.files) per.set(f, (per.get(f) ?? 0) + 1);
    for (let i = 0; i < c.files.length; i++) for (let j = i + 1; j < c.files.length; j++) {
      const k = `${c.files[i]}\0${c.files[j]}`; // files are sorted, so from < to
      pair.set(k, (pair.get(k) ?? 0) + 1);
    }
  }
  const strong = [...pair].map(([k, n]) => ({ k, n, from: k.split("\0")[0]!, to: k.split("\0")[1]! }))
    .filter((p) => p.n >= cfg.coChangeMin && p.n >= Math.min(per.get(p.from)!, per.get(p.to)!) / 2);
  const rank = (f: string) => new Set(strong.filter((p) => p.from === f || p.to === f).sort((a, b) => b.n - a.n || (a.k < b.k ? -1 : 1)).slice(0, 10).map((p) => p.k));
  const ranks = new Map<string, Set<string>>();
  const top = (f: string) => ranks.get(f) ?? ranks.set(f, rank(f)).get(f)!;
  return strong.filter((p) => top(p.from).has(p.k) && top(p.to).has(p.k))
    .map((p) => ({ from: p.from, to: p.to, kind: "changes-with", confidence: "heuristic", count: p.n }));
}

/** Keyword, conventional-commit scope and reference grouping (literal matching only). */
export function groupCommits(commits: Commit[], existing: { id: string; keywords?: string[] }[], cfg: HistoryConfig): Grouping[] {
  const ids = new Set(existing.map((f) => f.id));
  const groups = new Map<string, Grouping>();
  const ref = cfg.refPatterns.flatMap((p) => { try { return [new RegExp(p, "g")]; } catch { return []; } });
  const get = (id: string, name: string, created: boolean, description?: string) =>
    groups.get(id) ?? groups.set(id, { id, name, created, ...(description && { description }), commits: [], files: new Map(), nonBulk: 0 }).get(id)!;
  const add = (g: Grouping, c: Commit) => {
    if (g.commits.includes(c.hash)) return;
    g.commits.push(c.hash); g.nonBulk++;
    for (const f of c.files) g.files.set(f, (g.files.get(f) ?? 0) + 1);
  };
  for (const c of commits) { // newest first
    if (c.bulk) continue;
    for (const f of existing)
      for (const k of f.keywords ?? [])
        if (new RegExp(`(^|[^\\w])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w])`, "i").test(c.subject)) add(get(f.id, f.id, false), c);
    const scope = c.subject.match(/^\w+\(([^)]+)\)!?:/)?.[1];
    if (scope && slug(scope)) {
      const id = ids.has(`feature:${slug(scope)}`) ? `feature:${slug(scope)}` : `feature:scope-${slug(scope)}`;
      add(get(id, scope, !ids.has(id)), c);
    }
    for (const re of ref) for (const m of c.subject.matchAll(re)) if (slug(m[0])) { const g = get(`feature:ref-${slug(m[0])}`, m[0], true); add(g, c); g.description = c.subject; } // ends as the oldest commit's subject
  }
  return [...groups.values()];
}
