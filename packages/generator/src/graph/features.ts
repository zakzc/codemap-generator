import { matchesGlob } from "node:path";
import type { Grouping } from "../history/history.ts";
import { slug } from "../history/history.ts";
import type { Config, Diagnostic, Edge, Feature, Member, Node } from "../types.ts";

const WALK = new Set(["imports", "renders", "calls", "reads", "writes", "requests"]);
const AUTO_KINDS = new Set(["route", "store", "endpoint", "command"]);
const KEYWORD_KINDS = new Set(["file", "component", "hook", "store", "endpoint", "command", "route"]);
/** `PdfView.tsx` → ["pdf", "view", "tsx"]: keywords match whole words of names and paths. */
const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const ROLE_ORDER = { entry: 0, core: 1, support: 2, shared: 3 } as const;
const humanize = (s: string) => s.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

type Def = { id: string; name: string; description?: string; source: string; seeds: Set<string>; keywords: string[] };

/** Spec 1 §4.7: seeds (config, annotations, auto per route/store/endpoint/command, keywords) → breadth-first walk → roles. */
export function buildFeatures(nodes: Node[], edges: Edge[], config: Config, annotations: { file: string; feature: string; line: number }[], diagnostics: Diagnostic[]): Feature[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const distance = (config.featureDistance as number | undefined) ?? 2;
  const defs = new Map<string, Def>();
  const def = (id: string, name: string, source: string, description?: string) =>
    defs.get(id) ?? defs.set(id, { id, name, source, ...(description && { description }), seeds: new Set(), keywords: [] }).get(id)!;

  for (const n of nodes) if (AUTO_KINDS.has(n.kind)) def(`feature:${n.kind}-${slug(n.name)}`, n.name, n.kind).seeds.add(n.id);

  // config features replace auto features with the same id
  for (const f of (config.features as { id: string; name: string; description?: string; seeds?: string[]; keywords?: string[] }[] | undefined) ?? []) {
    defs.delete(f.id);
    const d = def(f.id, f.name, "config", f.description);
    d.keywords = f.keywords ?? [];
    for (const s of f.seeds ?? []) {
      const ids = byId.has(s) ? [s] : nodes.filter((n) => n.kind === "file" && n.path && matchesGlob(n.path, s)).map((n) => n.id);
      if (!ids.length) diagnostics.push({ level: "warn", code: "stale-override", message: `feature ${f.id}: seed ${s} matches nothing` });
      for (const id of ids) d.seeds.add(id);
    }
  }

  // `@feature x` comments: the symbol declared right below, else the file
  for (const a of annotations) {
    const below = nodes.find((s) => s.parent === `file:${a.file}` && s.range && s.range.start >= a.line && s.range.start <= a.line + 1);
    def(`feature:${a.feature}`, humanize(a.feature), "annotation").seeds.add(below?.id ?? `file:${a.file}`);
  }
  // keywords: names and paths of structural symbols and files
  for (const d of defs.values())
    for (const k of d.keywords)
      for (const n of nodes) if (KEYWORD_KINDS.has(n.kind) && words(`${n.name} ${n.path ?? ""}`).includes(k.toLowerCase())) d.seeds.add(n.id);

  // adjacency: a symbol also reaches what its file imports
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => { (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b); (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a); };
  for (const e of edges) if (WALK.has(e.kind) && byId.has(e.from) && byId.has(e.to) && byId.get(e.to)!.kind !== "external" && byId.get(e.from)!.kind !== "external") link(e.from, e.to);
  const neighbours = (id: string): string[] => {
    const n = byId.get(id)!;
    const out = new Set(adj.get(id));
    if (n.parent?.startsWith("file:")) for (const x of adj.get(n.parent) ?? []) out.add(x);
    out.delete(id);
    return [...out];
  };
  const isHub = (id: string) => byId.get(id)?.tags?.includes("hub") ?? false;

  const features: Feature[] = [];
  for (const d of defs.values()) {
    const seeds = [...d.seeds].sort();
    if (!seeds.length && d.source !== "config") continue; // your own features stay, so commits can still attach
    const dist = new Map<string, number>(seeds.map((s) => [s, 0]));
    let frontier = seeds;
    for (let k = 1; k <= distance && frontier.length; k++) {
      const next: string[] = [];
      for (const id of frontier) for (const m of neighbours(id)) {
        if (dist.has(m)) continue;
        dist.set(m, k);
        if (!isHub(m)) next.push(m); // hubs are members but never walked through
      }
      frontier = next;
    }
    const members: Member[] = [...dist].map(([id, dd]) => {
      const n = byId.get(id)!;
      const role = isHub(id) && dd > 0 ? "shared" : dd === 0 ? (n.kind === "component" || n.kind === "route" ? "entry" : "core") : dd === 1 ? "core" : "support";
      return { node: id, role, distance: dd };
    });
    features.push({ id: d.id, name: d.name, ...(d.description && { description: d.description }), source: d.source, seeds, members: sortMembers(members) });
  }
  return features;
}

export const sortMembers = (m: Member[]): Member[] =>
  m.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.distance ?? 99) - (b.distance ?? 99) || (a.node < b.node ? -1 : 1));

/** Commits add `origin: "history"` members (Spec 1 §4.7.1); existing members only gain `commits`. */
export function mergeHistory(features: Feature[], groups: Grouping[], hubs: Set<string>): Feature[] {
  const out = new Map(features.map((f) => [f.id, f]));
  for (const g of groups) {
    const f = out.get(g.id) ?? { id: g.id, name: g.name, ...(g.description && { description: g.description }), source: "history", members: [] };
    out.set(g.id, f);
    f.commits = g.commits;
    for (const [file, n] of g.files) {
      const m = f.members.find((x) => x.node === file);
      if (m) m.commits = n;
      else f.members.push({ node: file, role: hubs.has(file) ? "shared" : n * 2 >= g.nonBulk ? "core" : "support", origin: "history", commits: n });
    }
    sortMembers(f.members);
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}
