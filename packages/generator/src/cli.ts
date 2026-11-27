#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, scan } from "./scan.ts";
import { validateCodemap, validateSharded } from "./validate.ts";
import type { Diagnostic } from "./types.ts";
import { serialize, writeAtomic, writeCodemap } from "./write.ts";

// Default output: <project>/maps/<repo-name>/, next to packages/ (not inside the analysed repo)
const MAPS = fileURLToPath(new URL("../../../maps", import.meta.url));
const USAGE = "usage: codemap <repo>   (same as: codemap scan <repo>)\n       codemap scan <repo> [--out <dir>] [--full] [--no-cache] [--no-history] [--quiet]\n       codemap check <codemap.json>\n       codemap init <repo>";
const die = (msg: string, code = 2): never => { console.error(msg); process.exit(code); };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, full: { type: "boolean" }, "no-cache": { type: "boolean" }, "no-history": { type: "boolean" }, quiet: { type: "boolean" } },
});
// `codemap <repo>` is shorthand for `codemap scan <repo>`
const [first, second] = positionals;
const cmd = ["scan", "check", "init"].includes(first ?? "") ? first : first ? "scan" : undefined;
const target = cmd === first ? second : first;

if (cmd === "check" && target) {
  let doc;
  try { doc = JSON.parse(readFileSync(target, "utf8")); } catch (e) { die(`cannot read ${target}: ${(e as Error).message}`); }
  const errors = doc.shards?.length ? validateSharded(target, doc) : validateCodemap(doc);
  for (const e of errors) console.error(`✗ ${e}`);
  console.log(errors.length ? `${errors.length} error(s)` : `✓ ${target} ok (${doc.nodes?.length ?? 0} nodes, ${doc.edges?.length ?? 0} edges)`);
  process.exit(errors.length ? 1 : 0);
} else if (cmd === "scan" && target) {
  const repo = resolve(target);
  if (!existsSync(repo)) die(`not a folder: ${repo}`);
  const out = values.out ? resolve(values.out) : join(MAPS, basename(repo));
  const file = `map-${basename(repo)}.json`;
  const t0 = performance.now();
  let doc;
  const diagnostics: Diagnostic[] = [];
  try { const cfg = loadConfig(out); if (values.full) cfg.detail = { full: ["**"] }; doc = await scan(repo, cfg, { history: !values["no-history"], diagnostics, ...(!values["no-cache"] && { cacheDir: join(out, ".cache") }) }); } catch (e) { die(`scan failed: ${(e as Error).message}`); }
  const errors = validateCodemap(doc);
  if (errors.length) {
    writeAtomic(out, file.replace(".json", ".invalid.json"), serialize(doc!));
    die(`output failed validation (see ${join(out, file.replace(".json", ".invalid.json"))}):\n${errors.slice(0, 10).join("\n")}`, 1);
  }
  const { shards } = writeCodemap(out, doc!, undefined, file);
  const warns = diagnostics.filter((d) => d.level !== "info");
  console.log(`${doc!.project.name}: ${doc!.nodes.length} nodes, ${doc!.edges.length} edges, ${warns.length} warnings, ${((performance.now() - t0) / 1000).toFixed(1)} s${shards ? `, ${shards} shards` : ""}`);
  if (!values.quiet) for (const w of warns.slice(0, 10)) console.log(`  ${w.code} ${w.path ?? ""}${w.line ? `:${w.line}` : ""} ${w.message}`);
} else if (cmd === "init" && target) {
  const repo = resolve(target);
  if (!existsSync(repo)) die(`not a folder: ${repo}`);
  const out = values.out ? resolve(values.out) : join(MAPS, basename(repo));
  const file = join(out, "codemap.config.json");
  let doc;
  try { doc = await scan(repo, loadConfig(out), { history: false }); } catch (e) { die(`scan failed: ${(e as Error).message}`); }
  if (existsSync(file)) console.log(`${file} exists: left untouched`);
  else {
    writeAtomic(out, "codemap.config.json", `${JSON.stringify({ project: doc!.project.name, entrypoints: doc!.project.entrypoints, hubFanIn: 10, featureDistance: 2, features: [] }, null, 2)}\n`);
    console.log(`wrote ${file}`);
  }
  console.log("auto features (copy the ones you want into `features`):");
  for (const f of doc!.features.filter((f) => f.members.some((m) => m.origin !== "history"))) console.log(`  ${f.id}  ${f.name}  (${f.members.length} members)`);
}
else die(USAGE);
