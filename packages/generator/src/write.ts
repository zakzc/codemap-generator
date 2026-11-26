import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { LIMITS, shardDocument } from "./graph/shards.ts";
import { join } from "node:path";

const LINE_ARRAYS = new Set(["tools", "nodes", "edges", "rollups", "diagnostics"]);
const line = (x: unknown) => JSON.stringify(x);

/** One feature per block, one member per line. */
function features(list: Record<string, unknown>[]): string {
  const blocks = list.map(({ members, ...rest }) => {
    const props = Object.entries(rest).map(([k, v]) => `      ${line(k)}: ${line(v)}`);
    const ms = (members as unknown[]).map((m) => `        ${line(m)}`).join(",\n");
    return `    {\n${props.join(",\n")},\n      "members": [\n${ms}\n      ]\n    }`;
  });
  return `  "features": [\n${blocks.join(",\n")}\n  ]`;
}

/** 2-space JSON with one node / edge / … per line, so git diffs show one line per change (Spec 1 §4.11). */
export function serialize(doc: Record<string, unknown>): string {
  const parts = Object.entries(doc).filter(([, v]) => v !== undefined).map(([k, v]) => {
    if (k === "features" && Array.isArray(v) && v.length) return features(v);
    if (k === "history" && v && typeof v === "object") {
      const { commits, ...rest } = v as { commits: unknown[] };
      const props = Object.entries(rest).map(([a, b]) => `    ${line(a)}: ${line(b)}`);
      return `  "history": {\n${props.join(",\n")},\n    "commits": [\n${commits.map((c) => `      ${line(c)}`).join(",\n")}\n    ]\n  }`;
    }
    if (LINE_ARRAYS.has(k) && Array.isArray(v) && v.length)
      return `  ${JSON.stringify(k)}: [\n${v.map((x) => `    ${JSON.stringify(x)}`).join(",\n")}\n  ]`;
    return `  ${JSON.stringify(k)}: ${JSON.stringify(v, null, 2).replace(/\n/g, "\n  ")}`;
  });
  return `{\n${parts.join(",\n")}\n}\n`;
}

/** Temp file then rename, so a crash never leaves a half-written codemap. */
export function writeAtomic(dir: string, name: string, text: string) {
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, join(dir, name));
}

/** Single `codemap.json`, or a manifest plus `shards/*.json` above the limits (Spec 2 §8). Leftovers of the other form are removed. */
export function writeCodemap(out: string, doc: Record<string, any>, limits = LIMITS, file = "codemap.json"): { shards: number } {
  const sharded = shardDocument(doc as any, serialize, limits);
  const shardDir = join(out, "shards");
  if (!sharded) {
    writeAtomic(out, file, serialize(doc));
    rmSync(shardDir, { recursive: true, force: true });
    return { shards: 0 };
  }
  for (const s of sharded.shards) writeAtomic(shardDir, s.file.replace("shards/", ""), s.text);
  const keep = new Set(sharded.shards.map((s) => s.file.replace("shards/", "")));
  for (const f of existsSync(shardDir) ? readdirSync(shardDir) : []) if (!keep.has(f)) rmSync(join(shardDir, f), { force: true });
  writeAtomic(out, file, serialize(sharded.manifest));
  return { shards: sharded.shards.length };
}
