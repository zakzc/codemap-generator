import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { type Stats } from "../src/parse/cache.ts";
import { scan } from "../src/scan.ts";
import { validateCodemap, validateSharded } from "../src/validate.ts";
import { serialize, writeCodemap } from "../src/write.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "codemap-"));
const fixture = new URL("./fixtures/ts-react-redux", import.meta.url).pathname;
const put = (root: string, files: Record<string, string>) => { for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), c); } };
const norm = (doc: any) => serialize(doc);

test("incremental: only changed files are re-parsed, output equals a cold run", async () => {
  const repo = tmp(), cacheDir = tmp();
  cpSync(fixture, repo, { recursive: true });
  const run = async (c?: string) => { const stats: Stats = { parsed: 0, cached: 0 }; const doc = await scan(repo, {}, { cacheDir: c, stats }); return { doc, stats }; };

  const cold = await run(cacheDir);
  assert.ok(cold.stats.parsed > 5 && cold.stats.cached === 0);
  const warm = await run(cacheDir);
  assert.deepEqual([warm.stats.parsed, warm.stats.cached], [0, cold.stats.parsed]);
  assert.equal(norm(warm.doc), norm(cold.doc));

  writeFileSync(join(repo, "src/api.ts"), "export async function get(path: string) { return fetch(path + '?x'); }\n");
  const edited = await run(cacheDir);
  assert.equal(edited.stats.parsed, 1);
  assert.equal(norm(edited.doc), norm((await run()).doc), "same as a --no-cache run");

  renameSync(join(repo, "src/Orphan.tsx"), join(repo, "src/Orphan2.tsx")); // content unchanged → still cached
  assert.equal((await run(cacheDir)).stats.parsed, 0);
  rmSync(join(repo, "src/Orphan2.tsx"));
  await run(cacheDir);
  assert.equal(readdirSync(join(cacheDir, "facts")).length, cold.stats.parsed - 1, "unused entries are deleted");
});

test("worker pool gives the same result as parsing in-process", async () => {
  const repo = tmp();
  const files: Record<string, string> = {};
  for (let i = 0; i < 80; i++) files[`src/m${i}.ts`] = `import { f${Math.max(0, i - 1)} } from "./m${Math.max(0, i - 1)}";\nexport function f${i}() { return f${Math.max(0, i - 1)}(); }\n`;
  put(repo, files);
  const stats: Stats = { parsed: 0, cached: 0 };
  const pooled = await scan(repo, {}, { workers: 3, stats });
  assert.equal(stats.parsed, 80);
  assert.equal(norm(pooled), norm(await scan(repo, {}, { workers: 1 })));
});

test("rollups: edges aggregated between sibling directories", async () => {
  const repo = tmp();
  put(repo, { "app/a.ts": 'import { y } from "../lib/y";\nimport { z } from "../lib/z";\nexport const a = [y, z];\n', "app/b.ts": 'import { y } from "../lib/y";\nexport const b = y;\n', "lib/y.ts": "export const y = 1;\n", "lib/z.ts": "export const z = 1;\n" });
  const doc: any = await scan(repo);
  assert.deepEqual(doc.rollups.filter((r: any) => r.from === "dir:app"), [{ from: "dir:app", to: "dir:lib", kind: "imports", count: 3 }]);
  assert.deepEqual(validateCodemap(doc), []);
});

test("sharding: manifest + shards validate, split by folder, and switch back to one file", async () => {
  const repo = tmp(), out = tmp();
  const files: Record<string, string> = { "package.json": '{"name":"root"}', "pkg2/package.json": '{"name":"two"}', "pkg2/x.ts": "export const x = 1;\n" };
  for (const d of ["alpha", "beta", "gamma"]) for (let i = 0; i < 4; i++) files[`${d}/f${i}.ts`] = `export function g${i}() { return ${i}; }\n${i ? `import { g0 } from "./f0";\n` : ""}`;
  put(repo, files);
  const doc: any = await scan(repo);
  assert.deepEqual(validateCodemap(doc), []);

  assert.deepEqual(writeCodemap(out, doc), { shards: 0 }); // far below the limits
  assert.ok(!existsSync(join(out, "shards")));

  const n = writeCodemap(out, doc, { nodes: 10, bytes: 1e9 }).shards;
  assert.equal(n, 2, "one shard per package");
  const manifest = JSON.parse(readFileSync(join(out, "codemap.json"), "utf8"));
  const path = join(out, "codemap.json");
  assert.deepEqual(validateSharded(path, manifest), []);
  assert.ok(manifest.nodes.every((x: any) => ["project", "package", "directory", "external"].includes(x.kind)), "manifest holds nodes down to directory level");
  assert.ok(manifest.rollups && manifest.features);
  const total = manifest.nodes.length + manifest.shards.reduce((t: number, s: any) => t + s.nodes, 0);
  assert.equal(total, doc.nodes.length);

  const split = writeCodemap(out, doc, { nodes: 10, bytes: 600 }).shards; // the root package is too big: split by top-level folder
  assert.ok(split > 2);
  assert.deepEqual(validateSharded(path, JSON.parse(readFileSync(path, "utf8"))), []);

  const shardFile = join(out, JSON.parse(readFileSync(path, "utf8")).shards[0].path);
  writeFileSync(shardFile, readFileSync(shardFile, "utf8").replace("g0", "gX"));
  assert.ok(validateSharded(path, JSON.parse(readFileSync(path, "utf8"))).some((e) => /hash differs/.test(e)));

  assert.deepEqual(writeCodemap(out, doc), { shards: 0 });
  assert.ok(!existsSync(join(out, "shards")), "stale shards removed");
});

test("history cache: same HEAD reuses it, new commits are read alone, result equals a cold run", async () => {
  const repo = tmp(), cacheDir = tmp();
  let t = Date.parse("2026-02-01T00:00:00Z");
  const git = (...a: string[]) => { const d = new Date((t += 60_000)).toISOString(); execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore", env: { ...process.env, GIT_COMMITTER_DATE: d, GIT_AUTHOR_DATE: d } }); };
  const commit = (m: string, f: Record<string, string>) => { put(repo, f); git("add", "-A"); git("commit", "-qm", m); };
  git("init", "-q");
  commit("one", { "a.ts": "export const a = 1;\n" });
  commit("two", { "a.ts": "export const a = 2;\n" });
  const run = async (c?: string) => { const stats: Stats = { parsed: 0, cached: 0 }; return { doc: await scan(repo, {}, { cacheDir: c, stats }), stats }; };

  assert.equal((await run(cacheDir)).stats.historyRead, 2);
  assert.equal((await run(cacheDir)).stats.historyCached, true);
  commit("three", { "a.ts": "export const a = 3;\n" });
  const inc = await run(cacheDir);
  assert.equal(inc.stats.historyRead, 1);
  assert.equal(serialize(inc.doc), serialize((await run()).doc));
  assert.equal(inc.doc.history!.commits.length, 3);
});

test("performance: 1,500 files, cold < 10 s and warm < 2 s (fails above 2× the target)", { timeout: 180_000 }, async () => {
  const repo = tmp(), cacheDir = tmp();
  const files: Record<string, string> = {};
  for (let i = 0; i < 1000; i++) {
    const dep = (k: number) => `../m${(i - k) % 20}/f${i - k}`;
    files[`src/m${i % 20}/f${i}.${i % 3 === 0 ? "tsx" : "ts"}`] = [
      i > 13 ? `import { h${i - 1} } from "${dep(1)}";\nimport { h${i - 13} } from "${dep(13)}";` : "",
      `export function h${i}(a: number): number {`, `  const x = a + ${i};`, i > 13 ? `  return h${i - 1}(x) + h${i - 13}(x);` : "  return x;", "}",
      i % 3 === 0 ? `export function C${i}() { return <div>{h${i}(1)}</div>; }` : `export type T${i} = { v: number };`,
    ].join("\n") + "\n";
  }
  for (let i = 0; i < 400; i++) files[`svc/p${i % 10}/mod${i}.py`] = `${i > 2 ? `from svc.p${(i - 2) % 10}.mod${i - 2} import fn${i - 2}\n` : ""}\n\ndef fn${i}(x):\n    """Doc ${i}."""\n    return ${i > 2 ? `fn${i - 2}(x)` : "x"}\n`;
  for (let i = 0; i < 100; i++) files[`assets/s${i}.css`] = `.a${i} { color: red; }\n`;
  put(repo, files);

  let nodes = 0, edges = 0;
  const time = async (): Promise<[number, Stats]> => { const stats: Stats = { parsed: 0, cached: 0 }; const t0 = performance.now(); const doc = await scan(repo, {}, { cacheDir, stats }); writeCodemap(tmp(), doc); nodes = doc.nodes.length; edges = doc.edges.length; return [(performance.now() - t0) / 1000, stats]; };
  const [cold, s1] = await time();
  const [warm, s2] = await time();
  console.log(`  1,500 files: cold ${cold.toFixed(1)} s (${s1.parsed} parsed), warm ${warm.toFixed(1)} s (${s2.cached} cached)`);
  assert.ok(nodes > 2500 && edges > 2000, `graph too small: ${nodes} nodes, ${edges} edges`);
  assert.equal(s2.parsed, 0);
  assert.ok(cold < 20, `cold run took ${cold.toFixed(1)} s`);
  assert.ok(warm < 4, `warm run took ${warm.toFixed(1)} s`);
});
