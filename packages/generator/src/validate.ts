import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
// Shared schema + Spec 2 §10 invariants live in docs/schema until `packages/schema` is split out.
// @ts-ignore untyped .mjs
import { check } from "../../../docs/schema/check-codemap.mjs";

const schemaDir = new URL("../../../docs/schema/", import.meta.url);
const load = (f: string) => JSON.parse(readFileSync(new URL(f, schemaDir), "utf8"));
// CJS packages: require() avoids default-export interop differences
const req = createRequire(import.meta.url);
const ajv = new (req("ajv/dist/2020"))({ allErrors: true, strict: false });
req("ajv-formats")(ajv);
const validateDoc = ajv.compile(load("codemap.schema.json"));
export const validateConfig = ajv.compile(load("codemap.config.schema.json"));

const absolute = (p: unknown) => typeof p === "string" && (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.includes("\\"));

/** JSON Schema + Spec 2 §10 invariants + "no absolute paths" (Spec 1 §8). Returns error messages. */
export function validateCodemap(doc: any): string[] {
  const errors: string[] = [];
  if (!validateDoc(doc)) for (const e of validateDoc.errors ?? []) errors.push(`schema ${e.instancePath || "/"} ${e.message}`);
  errors.push(...check(doc));
  for (const n of doc?.nodes ?? []) if (absolute(n.path)) errors.push(`${n.id}: absolute path ${n.path}`);
  for (const e of doc?.edges ?? []) for (const a of e.at ?? []) if (absolute(a.path)) errors.push(`edge ${e.from}: absolute path ${a.path}`);
  return errors;
}

/** A manifest and its shards: each shard's hash and counts, then the merged document against every invariant. */
export function validateSharded(manifestPath: string, manifest: any): string[] {
  const errors = validateCodemap(manifest);
  const nodes = [...manifest.nodes], edges = [...(manifest.edges ?? [])];
  for (const s of manifest.shards ?? []) {
    let text: string;
    try { text = readFileSync(join(dirname(manifestPath), s.path), "utf8"); } catch { errors.push(`shard ${s.id}: cannot read ${s.path}`); continue; }
    if (s.hash && s.hash !== `sha256:${createHash("sha256").update(text).digest("hex")}`) errors.push(`shard ${s.id}: hash differs from the manifest`);
    const doc = JSON.parse(text);
    if (doc.nodes.length !== s.nodes || doc.edges.length !== s.edges) errors.push(`shard ${s.id}: counts differ from the manifest`);
    nodes.push(...doc.nodes); edges.push(...doc.edges);
  }
  const by = (k: (x: any) => string) => (a: any, b: any) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0);
  const { shards: _s, ...rest } = manifest;
  errors.push(...validateCodemap({ ...rest, nodes: nodes.sort(by((n) => n.id)), edges: edges.sort(by((e) => `${e.from}\0${e.kind}\0${e.to}`)) }).filter((e) => !errors.includes(e)));
  return errors;
}
