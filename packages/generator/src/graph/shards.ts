import { createHash } from "node:crypto";
import type { Edge, Node } from "../types.ts";

export const LIMITS = { nodes: 20_000, bytes: 10 * 1024 * 1024 };
type Doc = Record<string, any> & { nodes: Node[]; edges: Edge[] };
export type Shard = { id: string; file: string; text: string; doc: { format: string; shard: string; nodes: Node[]; edges: Edge[] } };

const slug = (s: string) => s.replace(/^(pkg|dir):/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
const KEEP = new Set(["project", "package", "directory", "external"]); // the manifest holds every node down to directory level

/**
 * Sharded form (Spec 2 §8): the manifest keeps project, tools, features, rollups, history and the nodes down to
 * directory level; each package becomes a shard with its files, symbols and the edges that start there. A package whose
 * shard is over `bytes` is split by its top-level folders.
 */
export function shardDocument(doc: Doc, serialize: (d: any) => string, limits = LIMITS): { manifest: Doc; shards: Shard[] } | undefined {
  if (doc.nodes.length <= limits.nodes && Buffer.byteLength(serialize(doc)) <= limits.bytes) return undefined;
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const pkgOf = (n: Node): Node | undefined => { for (let c: Node | undefined = n; c; c = c.parent ? byId.get(c.parent) : undefined) if (c.kind === "package") return c; };

  // group below-directory nodes by package, then split oversized packages by top-level folder
  const rootOf = new Map<string, string>(); // node id → shard root id
  const groups = new Map<string, Node[]>();
  for (const n of doc.nodes) {
    if (KEEP.has(n.kind)) continue;
    const root = pkgOf(n)?.id;
    if (root) (groups.get(root) ?? groups.set(root, []).get(root)!).push(n);
  }
  const edgesFrom = new Map<string, Edge[]>();
  for (const e of doc.edges) (edgesFrom.get(e.from) ?? edgesFrom.set(e.from, []).get(e.from)!).push(e);
  const size = (nodes: Node[]) => nodes.reduce((t, n) => t + JSON.stringify(n).length + (edgesFrom.get(n.id) ?? []).reduce((u, e) => u + JSON.stringify(e).length, 0), 0);

  const parts = new Map<string, Node[]>(); // shard root → nodes
  for (const [root, nodes] of groups) {
    if (size(nodes) <= limits.bytes) { parts.set(root, nodes); continue; }
    const pkgPath = byId.get(root)!.path ?? ".";
    for (const n of nodes) {
      const rel = pkgPath === "." ? n.path ?? "" : (n.path ?? "").slice(pkgPath.length + 1);
      const top = rel.includes("/") ? rel.split("/")[0]! : "";
      const dirId = top ? `dir:${pkgPath === "." ? top : `${pkgPath}/${top}`}` : root;
      const key = byId.has(dirId) ? dirId : root;
      (parts.get(key) ?? parts.set(key, []).get(key)!).push(n);
    }
  }
  const used = new Set<string>();
  const shards: Shard[] = [];
  const rootOfShard = new Map<string, string>();
  for (const [root, nodes] of [...parts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let id = slug(root);
    for (let i = 2; used.has(id); i++) id = `${slug(root)}-${i}`;
    used.add(id);
    rootOfShard.set(id, root);
    for (const n of nodes) rootOf.set(n.id, id);
    const edges = nodes.flatMap((n) => edgesFrom.get(n.id) ?? []);
    const sdoc = { format: "codemap/1", shard: id, nodes, edges };
    shards.push({ id, file: `shards/${id}.json`, text: serialize(sdoc), doc: sdoc });
  }
  const loose = doc.edges.filter((e) => !rootOf.has(e.from)); // edges whose source lives in the manifest
  const manifest: Doc = {
    ...doc,
    nodes: doc.nodes.filter((n) => !rootOf.has(n.id)),
    edges: loose,
    shards: shards.map((s) => ({ id: s.id, path: s.file, root: rootOfShard.get(s.id)!, nodes: s.doc.nodes.length, edges: s.doc.edges.length, hash: `sha256:${createHash("sha256").update(s.text).digest("hex")}` })),
  };
  if (!manifest.edges.length) delete (manifest as Partial<Doc>).edges;
  return { manifest, shards };
}
