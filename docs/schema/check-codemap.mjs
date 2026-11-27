#!/usr/bin/env node
// Checks the cross-reference invariants of Spec 2 §10 (1–6) that JSON Schema cannot express.
// shortcut: shape checks cover required fields + enums only, not full JSON Schema; use ajv in Spec 1 tests.
// Usage: node check-codemap.mjs <codemap.json>   (exit 1 on errors)
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const schema = JSON.parse(readFileSync(new URL("./codemap.schema.json", import.meta.url), "utf8"));
const enumOf = (name) => new Set(schema.$defs[name]?.enum ?? []);
const NODE_KINDS = enumOf("nodeKind"), EDGE_KINDS = enumOf("edgeKind");

export function check(doc) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (doc?.format !== "codemap/1") err(`format must be "codemap/1", got ${JSON.stringify(doc?.format)}`);
  const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const edges = Array.isArray(doc?.edges) ? doc.edges : [];

  // 1. unique ids + shape
  const byId = new Map();
  for (const n of nodes) {
    if (typeof n?.id !== "string" || !n.id) { err(`node without id: ${JSON.stringify(n)}`); continue; }
    if (byId.has(n.id)) err(`duplicate id ${n.id}`);
    byId.set(n.id, n);
    if (!NODE_KINDS.has(n.kind)) err(`${n.id}: bad kind ${n.kind}`);
    if (typeof n.name !== "string") err(`${n.id}: missing name`);
    if (!("parent" in n)) err(`${n.id}: missing parent`);
  }
  const exists = (id) => byId.has(id);

  // 2. single project root
  const roots = nodes.filter((n) => n?.parent === null);
  if (!doc?.shard && (roots.length !== 1 || roots[0].kind !== "project")) err(`expected exactly one project root, found ${roots.length}`);

  // 3. references resolve (sharded manifests may point into unloaded shards)
  const sharded = Array.isArray(doc?.shards) && doc.shards.length > 0 || !!doc?.shard;
  const ref = (id, where) => { if (!sharded && !exists(id)) err(`${where}: unknown id ${id}`); };
  for (const n of nodes) if (n?.parent != null) ref(n.parent, `${n.id}.parent`);
  for (const e of edges) {
    ref(e?.from, "edge.from"); ref(e?.to, "edge.to");
    if (!EDGE_KINDS.has(e?.kind)) err(`edge ${e?.from}->${e?.to}: bad kind ${e?.kind}`);
  }
  for (const id of doc?.project?.entrypoints ?? []) ref(id, "project.entrypoints");
  for (const t of doc?.tools ?? []) for (const id of t?.nodes ?? []) ref(id, `tools.${t?.category}`);
  for (const f of doc?.features ?? []) {
    for (const m of f?.members ?? []) ref(m?.node, `${f.id}.members`);
  }
  for (const r of doc?.rollups ?? []) { ref(r?.from, "rollup.from"); ref(r?.to, "rollup.to"); }
  const commits = Array.isArray(doc?.history?.commits) ? doc.history.commits : [];
  for (const c of commits) for (const id of c?.files ?? []) ref(id, `history.${c?.hash}`);

  // 4. parent chains terminate
  for (const n of nodes) {
    const seen = new Set();
    for (let cur = n; cur?.parent != null; cur = byId.get(cur.parent)) {
      if (seen.has(cur.id)) { err(`parent cycle at ${n.id}`); break; }
      seen.add(cur.id);
    }
  }

  // 5. no duplicate edges
  const edgeKey = (e) => `${e?.from}\u0000${e?.kind}\u0000${e?.to}`;
  const keys = new Set();
  for (const e of edges) { const k = edgeKey(e); if (keys.has(k)) err(`duplicate edge ${e.from} -${e.kind}-> ${e.to}`); keys.add(k); }

  // 6. sorted for stable diffs
  const sorted = (arr, key) => arr.every((x, i) => i === 0 || key(arr[i - 1]) <= key(x));
  if (!sorted(nodes, (n) => n?.id ?? "")) err("nodes not sorted by id");
  if (!sorted(edges, edgeKey)) err("edges not sorted by from, kind, to");
  const commitKey = (c) => [c?.date ?? "", c?.hash ?? ""];
  if (!commits.every((c, i) => { if (i === 0) return true; const [d0, h0] = commitKey(commits[i - 1]), [d1, h1] = commitKey(c); return d0 > d1 || (d0 === d1 && h0 <= h1); }))
    err("history.commits not sorted newest first");

  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  if (!file) { console.error("usage: check-codemap.mjs <codemap.json>"); process.exit(2); }
  let doc;
  try { doc = JSON.parse(readFileSync(file, "utf8")); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(2); }
  const errors = check(doc);
  for (const e of errors) console.error(`✗ ${e}`);
  console.log(errors.length ? `${errors.length} error(s)` : `✓ ${file} ok (${doc.nodes?.length ?? 0} nodes, ${doc.edges?.length ?? 0} edges)`);
  process.exit(errors.length ? 1 : 0);
}
