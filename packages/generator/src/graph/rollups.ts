import type { Edge, Node } from "../types.ts";

export type Rollup = { from: string; to: string; kind: string; count: number };

/**
 * Edges aggregated between containers (Spec 1 §4.10): package pairs and directory pairs, count = sum of edge counts.
 * Edges inside one container, between a container and its own descendant, and `changes-with` are left out.
 */
export function buildRollups(nodes: Node[], edges: Edge[]): Rollup[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const cache = new Map<string, string[]>();
  const containers = (id: string): string[] => { // package and directory ancestors, nearest first
    const hit = cache.get(id);
    if (hit) return hit;
    const n = byId.get(id);
    const own = n && (n.kind === "package" || n.kind === "directory") ? [id] : [];
    const out = n?.parent ? [...own, ...containers(n.parent)] : own;
    cache.set(id, out);
    return out;
  };
  const acc = new Map<string, Rollup>();
  for (const e of edges) {
    if (e.kind === "changes-with") continue;
    const a = containers(e.from), b = containers(e.to);
    for (const x of a) for (const y of b) {
      if (x === y || x.startsWith("pkg:") !== y.startsWith("pkg:") || nested(x, y, byId)) continue;
      const key = `${x}\0${e.kind}\0${y}`;
      const r = acc.get(key) ?? acc.set(key, { from: x, to: y, kind: e.kind, count: 0 }).get(key)!;
      r.count += e.count ?? 1;
    }
  }
  return [...acc.values()].sort((p, q) => { const k = `${p.from}\0${p.kind}\0${p.to}`, l = `${q.from}\0${q.kind}\0${q.to}`; return k < l ? -1 : k > l ? 1 : 0; });
}

const nested = (x: string, y: string, byId: Map<string, Node>) => {
  const px = byId.get(x)?.path ?? "", py = byId.get(y)?.path ?? "";
  if (px === "." || py === ".") return true; // the root package contains everything
  return px.startsWith(`${py}/`) || py.startsWith(`${px}/`);
};
