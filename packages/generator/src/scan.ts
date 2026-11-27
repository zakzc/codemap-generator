import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { discoverFiles } from "./discover/files.ts";
import { gitInfo } from "./discover/git.ts";
import { findPackages, packageOf } from "./discover/packages.ts";
import { buildGraph } from "./graph/build.ts";
import { buildFeatures, mergeHistory } from "./graph/features.ts";
import { applyOverrides } from "./graph/overrides.ts";
import { buildRollups } from "./graph/rollups.ts";
import { applyTools } from "./graph/tools.ts";
import { isShallow, readLogCached } from "./history/gitlog.ts";
import { groupCommits, mapCommits, HISTORY_DEFAULTS } from "./history/history.ts";
import { parseWithCache, type Stats } from "./parse/cache.ts";
import { resolvePython, pythonSubmodules, type PyCtx } from "./resolve/python.ts";
import { makeResolver } from "./resolve/typescript.ts";
import { validateConfig } from "./validate.ts";
import type { Config, Diagnostic } from "./types.ts";

export function loadConfig(outDir: string): Config {
  const file = join(outDir, "codemap.config.json");
  if (!existsSync(file)) return {};
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  if (!validateConfig(cfg)) throw new Error(`${file}: ${(validateConfig.errors ?? []).map((e: any) => `${e.instancePath} ${e.message}`).join("; ")}`);
  return cfg;
}

/** Pure-ish pipeline: discover → parse → resolve → graph. Returns the unwritten document. */
export async function scan(repo: string, config: Config = {}, opts: { history?: boolean; cacheDir?: string; workers?: number; stats?: Stats; diagnostics?: Diagnostic[] } = {}) {
  const git = gitInfo(repo);
  const root = git?.root ?? repo;
  const projectName = config.project ?? basename(root);
  const { files, diagnostics: d1 } = discoverFiles(root, !!git, config.ignore);
  const d2: Diagnostic[] = [];
  const packages = findPackages(files, d2);
  const facts = await parseWithCache(files, opts);
  const content = new Map(files.map((f) => [f.path, f.content]));
  const paths = new Set(content.keys());
  const tsResolve = makeResolver({ files: paths, read: (p) => content.get(p) });
  const pkgDirs = new Set(packages.map((p) => p.dir));
  const py: PyCtx = {
    files: paths,
    pkgDirOf: (p) => packageOf(p, pkgDirs),
    pipDeps: (dir) => Object.keys(packages.find((p) => p.dir === dir)?.deps.pip ?? {}),
  };
  const resolve = (spec: string, from: string) => (from.endsWith(".py") ? resolvePython(spec, from, py) : tsResolve(spec, from));
  const submodules = (spec: string, from: string, names: string[]) => (from.endsWith(".py") ? pythonSubmodules(spec, from, names, py) : []);
  const g = buildGraph({ projectName, files, facts, packages, config, resolve, submodules });

  const diagnostics = [...d1, ...d2, ...g.diagnostics];
  let { nodes, edges } = g;

  // git history: commits → files, co-change, commit-based features (Spec 1 §4.7.1)
  const hcfg = { ...HISTORY_DEFAULTS, ...(config.history as object | undefined) };
  const useHistory = opts.history !== false && (config.history as { enabled?: boolean } | undefined)?.enabled !== false;
  let history: { commits: ReturnType<typeof mapCommits> } | undefined;
  let groups: ReturnType<typeof groupCommits> = [];
  if (!git || !useHistory) diagnostics.push({ level: "info", code: "skipped-file", message: `History skipped: ${!git ? "not a git repo" : "disabled"}` });
  else {
    const log = readLogCached(root, hcfg.maxCommits, opts.cacheDir, opts.stats);
    const shallow = isShallow(root);
    if (!log) diagnostics.push({ level: "info", code: "skipped-file", message: "History skipped: no commits" });
    else {
      if (shallow) diagnostics.push({ level: "warn", code: "shallow-history", message: "Shallow clone: history is incomplete" });
      const commits = mapCommits(log, new Set(nodes.filter((n) => n.kind === "file" || n.kind === "asset").map((n) => n.id)), hcfg);
      history = { commits };
      groups = groupCommits(commits, ((config.features as { id: string; keywords?: string[] }[] | undefined) ?? []), hcfg);
    }
  }

  const annotations = facts.flatMap((f) => (f.annotations ?? []).map((a) => ({ file: f.path, ...a })));
  let features = buildFeatures(nodes, edges, config, annotations, diagnostics);
  features = mergeHistory(features, groups, new Set(nodes.filter((n) => n.tags?.includes("hub")).map((n) => n.id)));
  edges = applyOverrides(nodes, edges, features, config, diagnostics);
  const tools = applyTools(nodes, config);

  const key = (d: (typeof diagnostics)[number]) => `${d.path ?? ""}\0${String(d.line ?? 0).padStart(8, "0")}\0${d.code}\0${d.message}`;
  diagnostics.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  edges.sort((a, b) => { const x = `${a.from}\0${a.kind}\0${a.to}`, y = `${b.from}\0${b.kind}\0${b.to}`; return x < y ? -1 : x > y ? 1 : 0; });
  opts.diagnostics?.push(...diagnostics);
  return {
    format: "codemap/1",
    project: { name: projectName, ...(git?.remote && { remote: git.remote }), commit: git?.commit ?? null, entrypoints: g.entrypoints },
    tools, features, nodes, edges, rollups: buildRollups(nodes, edges), ...(history && { history }),
  };
}
