# Codemap — progress

## Spec 1 milestones (generator)

| M | Scope | Status |
|---|---|---|
| M1 | Skeleton: CLI, discover, packages, TS/JS imports, file/dir/package/external nodes, validate + write | **Done** (2026-11-26) |
| M2 | TS symbols: decls, detail rule, React components/hooks/renders, Redux stores/reads/writes, entry depth | **Done** (2026-11-26) |
| M3 | Python: adapter, resolver, FastAPI/Flask endpoints | **Done** (2026-11-26) |
| M4 | Rust + bridges: adapter, resolver, Tauri commands/sidecars, axum, request matching with wrapper detection | **Skipped for now** (decided 2026-11-26: few Rust apps). M5 does not need it; only the request-matching part would add `requests` edges (TS → Python endpoints) |
| M5 | Features and you: features, annotations, git history (§4.7.1), config overrides, tools registry, `init` | **Done** (2026-11-26) |
| M6 | Scale: parse cache, worker pool, rollups, sharding, performance test | **Done** (2026-11-26) |

Each milestone ends with a run on Lettore and a passing `check`. Details of what was built are under Done.

## Done
- 2026-11-26 — Spec 2 draft v0.1: [specs/spec-2-codemap-schema.md](specs/spec-2-codemap-schema.md)
  - Researched Floorplan and Understand-Anything data models (both rely on AI for grouping; we replace that with config + rules).
  - JSON Schema: [schema/codemap.schema.json](schema/codemap.schema.json)
  - Integrity checker for cross-references (§10): [schema/check-codemap.mjs](schema/check-codemap.mjs)
  - Hand-written worked example from the real Lettore repo: [examples/lettore.codemap.json](examples/lettore.codemap.json) — passes the checker; negative test (duplicate id, dangling edge, bad kind) fails as expected.
- 2026-11-26 — Spec 3 draft v0.1: [specs/spec-3-visualiser.md](specs/spec-3-visualiser.md)
  - JSON Crack-style cards/rows with +/−, layered left-to-right layout.
  - Sereia's hover/pin highlighting (Direct/Chain, blue outgoing, orange incoming) adapted to edge kinds, card-level selection and closed cards.
  - Extras: feature mode, kind filter, group lines, load path, tools panel, search, open in editor, details panel.
- 2026-11-26 — Spec 2 v0.2: open questions 1–10 decided (§13).
  - Portable JSON in `maps/<project>/`, outside the repos; repo location is a per-machine viewer setting.
  - Detail rule: structural kinds always, `hiddenSymbols` counts, edges from hidden helpers lifted to their file, `detail.full` override.
  - Your notes, manual edges and feature overrides in `codemap.config.json`, always winning (`note`, `confidence: manual`, member `origin: user`, `stale-override` diagnostic).
  - Languages TS/JS, Python, Rust, Swift, C++ via tree-sitter; generator in Node/TS (`web-tree-sitter`).
  - `calls`: syntax-only rule, no type checker.
  - Schema and example updated; example passes the checker (33 nodes, 26 edges).
- 2026-11-26 — Spec 2 v1.0: decision 7 confirmed — generator v1 covers TS/JS, Python and Rust; Swift and C++ later.
- 2026-11-26 — Spec 3 v0.2: aligned with Spec 2 v0.2 (note markers, "+N internal" rows, dotted manual edges, per-machine repo location; Q3 reworded).
- 2026-11-26 — Spec 1 draft v0.1: [specs/spec-1-generator.md](specs/spec-1-generator.md)
  - Node/TS CLI (`scan`, `check`, `init`), never runs repo code, never writes in the repo.
  - Pipeline: discover → cached parallel tree-sitter parse → resolve → framework detectors → detail rule → features → your overrides → tools/metrics → rollups/shards → validate → atomic write.
  - v1: TS/JS, Python, Rust; React, Redux Toolkit, Express, FastAPI/Flask, Tauri, axum; request matching incl. wrapper functions like Lettore's `call()`.
  - Config contract: [schema/codemap.config.schema.json](schema/codemap.config.schema.json); example: [examples/lettore.codemap.config.json](examples/lettore.codemap.config.json) (shape checked).
  - Milestones M1–M6; tests incl. golden fixtures, determinism, incremental, safety.
- 2026-11-26 — Git history added: Spec 1 v0.2 (§4.7.1) and Spec 2 v1.1 (§7.5).
  - `git log` subjects + changed files (renames followed, no authors, no bodies) → `history.commits`, file `metrics.commits`/`meta.lastChanged`, `changes-with` edges (co-change), and features grouped by keyword, conventional-commit scope or reference pattern (`source: "history"`, member `origin: "history"`).
  - Schema, config schema (`history` key), checker (invariant 7) updated; example now carries Lettore's real history (4 commits, `main.py changes-with App.tsx`, `feature:ref-m3-8`) and passes; negative test catches the new invariants.
- 2026-11-26 — Spec 1 and Spec 2 files copied to `~/Local/LocalCode/codemap-generator`.

- 2026-11-26 — Spec 1 **M1 Skeleton** implemented in [packages/generator](packages/generator) (Node 26 runs the `.ts` directly, no build step; `npm test`, `npm run codemap -- scan <repo>`).
  - CLI `scan` and `check` (`init` prints "arrives in M5"); exit codes 0/1/2; invalid output goes to `codemap.invalid.json`, previous codemap untouched.
  - Discover: git root/commit/dirty/sanitised remote, `git ls-files` (tracked + untracked at the time; since v0.3 tracked only), skip dirs/lockfiles/ignore globs/>1 MB/binary, `@generated` flag, symlinks skipped.
  - Packages: `package.json`, `Cargo.toml`, `pyproject.toml`, `requirements*.txt`, `setup.*`; synthetic `pkg:.`; entrypoints from `main`/`module`/`bin`, `src/main.rs`.
  - TS/JS imports via web-tree-sitter (static, re-export, `import()`, `require`); resolver with extension probing, `.js`→`.ts`, tsconfig `paths`/`baseUrl`/`extends` (jsonc), query suffixes, built-ins dropped, scoped externals.
  - Graph: project/package/directory/file/asset/external nodes, merged `imports` edges, fanIn/fanOut/loc/children metrics, `hub` and `entry` tags, `unresolved-import` / `parse-error` diagnostics.
  - Validate (ajv 2020 + Spec 2 §10 + no absolute paths) → atomic write, one node/edge per line, `generatedAt` = commit time when clean.
  - 6 tests pass (fixture `ts-basic`, determinism, git remote/untracked, symlink/ignore, resolver). Lettore run: 50 nodes, 55 edges, 0 warnings, 0.2 s, `check` passes.
  - Deviations: grammars come from `@vscode/tree-sitter-wasm` (`tree-sitter-wasms` is built for an older ABI and fails to load in `web-tree-sitter` 0.27); schema + `check-codemap.mjs` are still imported from `docs/schema/` (no `packages/schema` split yet); parsing is sequential (worker pool is M6).
- 2026-11-26 — Single entry point: `codemap <repo>` (shorthand for `scan`), installed once with `npm link` in `packages/generator`; verified from `/` on Lettore. Spec 1 §2/§3 updated.
- 2026-11-26 — Spec 1 v0.3: open questions 1–10 decided (§12). Applied: tracked files only (`git ls-files --cached`, test updated: untracked not shown, dirty tree → current time), `history.maxCommits` default 100 (config schema + spec). Others matched the proposed defaults.
- 2026-11-26 — `npm run codemap <repo>` from the project root (root `package.json`; extra flags after `--`, e.g. `npm run codemap <repo> -- --out <dir>`). Relative repo paths resolve from the folder you run it in.
- 2026-11-26 — Spec 1 **M2 TS symbols** implemented (8 tests pass, `tsc` clean).
  - Facts now carry `decls` (function/class/type/const/alias, exported, doc, params/props, methods, `extends`, call initialisers), `defaultExport`, `calls`, `jsx` (with `conditional`), import `bindings` and re-exports ([lang/typescript.ts](packages/generator/src/lang/typescript.ts)).
  - Name resolution: same-file top-level decl (`exact`), else the imported symbol with one level of re-export (`inferred`) ([graph/symbols.ts](packages/generator/src/graph/symbols.ts)).
  - Detectors: React components (function/arrow, `memo`/`forwardRef`, class `extends Component`, `lazy`), hooks, Redux slices/stores, `reads` from `useSelector`/`use*Selector` lambdas, `writes` from `dispatch(...)` through `slice.actions` aliases ([detect/react.ts](packages/generator/src/detect/react.ts), [detect/redux.ts](packages/generator/src/detect/redux.ts)); `renders`/`uses`/`calls` edges.
  - Detail rule: structural kinds always; functions/types only when exported or in test files; `detail.full` and `--full` keep everything; `metrics.hiddenSymbols`; edges from hidden symbols lift to their file.
  - Entry depth from components rendered in entrypoint files (`package.json` main, Vite `<script type="module">`, config `entrypoints`); `meta.conditional` when every render is conditional.
  - Lettore: 92 nodes, 142 edges (11 `writes`, many `reads`), 0 warnings, 0.2 s (110 nodes with `--full`); `check` passes; `App → PdfView/Minimap/…` renders found; `export const doc = slice.actions` whole-object aliases supported.
  - Shortcuts: CommonJS `module.exports` and `export { a as b }` aliases are not tracked; method calls (`obj.m()`) are skipped by design; a component rendered only by a helper function gets `entryDepth: -1`; `uses` edges to library hooks (`useState`) point at the external package.
- 2026-11-26 — Spec 1 **M3 Python** implemented (9 tests pass, `tsc` clean).
  - Adapter ([lang/python.ts](packages/generator/src/lang/python.ts)): imports (absolute, relative, aliased, `*`), top-level `def`/`async def`/`class` (methods by name, docstring, `__all__`/leading `_` for exported), decorators with args and keyword args, call-initialised names (`app = FastAPI()`), calls, `Depends(...)` names, entry markers (`if __name__ == "__main__"`, `uvicorn.run`).
  - Resolver ([resolve/python.ts](packages/generator/src/resolve/python.ts)): relative imports by dots; absolute against the package folder, `src/`, then the importing folder; `from pkg import module` submodules; package `__init__.py` re-exports; stdlib dropped (`sys.stdlib_module_names` list); third party → `ext:pip:<name>` through an alias table (`fitz` → `pymupdf`, `yaml` → `pyyaml`…) and the package's requirements.
  - FastAPI/Flask ([detect/fastapi.ts](packages/generator/src/detect/fastapi.ts)): `@app.get/post/…`, `@x.websocket`, `@x.route(methods=)`, prefixes joined through `APIRouter(prefix=)`, `include_router(prefix=)`, `Blueprint(url_prefix=)`, `register_blueprint`; `auth: true` when a `Depends(...)` name contains auth/token/user/login. A routed function becomes the `endpoint:METHOD /path` node (parent = its file), so its calls leave from the endpoint.
  - Packages: `requirements*.txt` and `setup.cfg` are now picked up as assets (they were silently dropped before); `[project.scripts]` give entrypoints.
  - Lettore: 116 nodes, 158 edges, 0 warnings, 0.2 s; `check` passes; `pkg:sidecar` found; the same 7 endpoints as the hand-written example (6 with `auth`, `WS /speak` without); `POST /parse → parse_pdf` and the other `calls` found.
  - Shortcuts: only module-level declarations (nothing inside `if`/`try`); `import x` + `x.func()` and method calls are not tracked; router-level `dependencies=` are ignored for `auth`; class instantiation is not a `calls` edge.
- 2026-11-26 — Spec 1 **M5 Features and you** implemented (12 tests pass, `tsc` clean). M4 skipped by decision; M5 needs nothing from it.
  - Features ([graph/features.ts](packages/generator/src/graph/features.ts)): seeds from config (ids or path globs), `@feature <id>` comments (the symbol below, else the file), one auto feature per `route`/`store`/`endpoint`/`command` (`feature:<kind>-<slug>`), and keywords (whole words of names and paths of structural symbols and files). Breadth-first walk to `featureDistance` over `imports`/`renders`/`calls`/`reads`/`writes`/`requests`, both directions; a symbol also reaches what its file imports; hubs are `shared` and not walked through; roles `entry`/`core`/`support`/`shared`; members sorted by role, distance, id. A config feature replaces the auto one with the same id.
  - Git history ([history/gitlog.ts](packages/generator/src/history/gitlog.ts), [history/history.ts](packages/generator/src/history/history.ts)): last 100 commits (hash, committer date, subject, files; no authors, bodies or diffs); renames followed newest → oldest; deleted and non-node files dropped; bulk commits flagged and excluded from co-change/grouping; `metrics.commits` and `meta.lastChanged` on files; `changes-with` edges (≥ 3 shared and ≥ half of the less-changed file's commits, 10 strongest per file); features from keywords, `type(scope):` and reference patterns (`feature:scope-…`, `feature:ref-…`) with `origin: "history"` members, roles by share of commits; `shallow-history` diagnostic; `--no-history` and `history.enabled`.
  - Overrides ([graph/overrides.ts](packages/generator/src/graph/overrides.ts)): `notes` → `note`; `edges` → `confidence: "manual"` replacing generated ones; feature `include`/`exclude`/`roles` (`origin: "user"`); `tools`; unknown ids → `stale-override`, skipped.
  - Tools ([graph/tools.ts](packages/generator/src/graph/tools.ts), [registry/tools.json](packages/generator/registry/tools.json)): ~600 npm/PyPI/crates.io packages (with `scope/*` prefixes) → `meta.category` on externals and the grouped `tools` index; unknown → `other`; your config wins.
  - `codemap init <repo>`: writes a starter `codemap.config.json` (project, detected entrypoints, `hubFanIn`, `featureDistance`, empty `features`) in the out folder, never overwrites, and lists the auto features with member counts.
  - Output layout: features one member per line, `history.commits` one per line.
  - Lettore (with its example config): 122 nodes, 163 edges, 0 warnings, 0.2 s; `check` passes; `feature:ref-m3-8` has `chunker.py`, `main.py`, `PdfView.tsx`, `player.ts`, `styles.css` as core and `store.ts` as shared; `sidecar/main.py changes-with src/App.tsx` (3 commits); tools grouped (state, ui, ipc, http-server, media, ml…).
  - Shortcuts: history cache (`.cache/history.json`) comes with M6, so history is re-read each run (100 commits: fast); keyword seeds are heuristic and can be broad; without request matching (M4), features do not cross from the TS client to Python endpoints; a file and its symbols can both appear as members.
- 2026-11-26 — Spec 1 **M6 Scale** implemented (18 tests pass, `tsc` clean).
  - Parse cache ([parse/cache.ts](packages/generator/src/parse/cache.ts)): `<out>/.cache/facts/<sha256>.json`, tagged with a hash of the adapter sources (editing an adapter invalidates entries by itself); unchanged content is not re-parsed, even after a rename; unused entries deleted; `--no-cache` ignores it.
  - Worker pool ([parse/pool.ts](packages/generator/src/parse/pool.ts)): `availableParallelism() - 1` workers when ≥ 60 files need parsing; a failing worker falls back to in-process parsing.
  - History cache (`.cache/history.json`, keyed by `HEAD`): same HEAD reuses it; cached HEAD an ancestor → only new commits are read; otherwise a full read. Raw commits are cached, mapping is recomputed.
  - Rollups ([graph/rollups.ts](packages/generator/src/graph/rollups.ts)): package and directory pairs, summed `count`, always written.
  - Sharding ([graph/shards.ts](packages/generator/src/graph/shards.ts), `writeCodemap` in [write.ts](packages/generator/src/write.ts)): above 20,000 nodes or 10 MB the manifest keeps nodes down to directory level plus tools, features, rollups, history; one shard per package (split by top-level folder if over 10 MB); edges live in the shard of their `from`; stale shards removed, and switching back to one file removes `shards/`. `codemap check` verifies shard hashes, counts and the merged document.
  - Performance (generated 1,500-file repo, 1,400 parsed): cold 0.6 s, warm 0.2 s (targets: 10 s / 2 s); the test fails above 2× the targets and checks the graph is not trivially small.
  - Lettore: 122 nodes, 163 edges, cold 0.3 s, warm 0.1 s; `check` passes.
- 2026-11-26 — [README.md](README.md): installation and execution kept separate, overview, config, limits, layout.
- 2026-11-26 — Fix from the first real run (news-hub): importing an image (`../assets/newsIcon.png`) gave `unresolved-import`. Images, fonts and media (`.png .jpg .svg .woff .mp3 …`) are now asset nodes, never read or hashed, so those imports resolve. Test added (19 pass); news-hub: 69 nodes, 71 edges, 0 warnings.
- 2026-11-26 — Default output moved from `~/Codemaps/<repo>/` to `maps/<repo>/` inside this project (created `maps/`); `--out` still overrides. README and Spec 1 updated. Older codemaps in `~/Codemaps/` are left as they are.
- 2026-11-26 — Output file renamed to `map-<repo-name>.json` (e.g. `maps/news-hub/map-news-hub.json`); invalid output is `map-<repo-name>.invalid.json`. The config stays `codemap.config.json`. README and Spec 1 updated.
- 2026-11-27 — Removed fields no visualiser screen reads (Spec 2 v1.2 §14, Spec 1 v0.4 §12 #11). 20 tests pass, `tsc` clean.
  - Generator no longer writes: `changes-with` edges (and `history.coChangeMin`), `generator`, `project.root`/`languages`, `diagnostics`, node `hash`/`lang`, `metrics.children`/`commits`, `meta` `hooks`/`props`/`params`/`async`/`entryDepth`/`ecosystem`/`lastChanged`, edge `meta.names`/`typeOnly`, feature `source`/`seeds`/`commits`, `edge.at` beyond the first entry, `history.scanned`/`truncated`. Tags were already only `entry` and `hub`.
  - Removed at the source, not stripped at the end: adapters no longer extract params/props/async/typeOnly, the co-change and entry-depth code is gone, `scan()` no longer returns diagnostics in the document (callers pass `opts.diagnostics`, as the CLI does for its warnings; `--quiet` and the warning count are unchanged).
  - `ecosystem` is read from the external's id (`ext:npm:react`) by the tools registry. Feature listing in `init` now skips features whose members all come from history (was `source !== "history"`).
  - Schema, config schema, `check-codemap.mjs` (invariant 7 and the `seeds` check removed) and the Lettore example updated; `maps/diagramma` and `maps/news-hub` regenerated (diagramma 883 → 827 edges, all `changes-with`).
  - Fix found on the way: `serialize` wrote invalid JSON for a `history` block holding only `commits`; test now parses the written history back.
  - Fix found on the way: the fixture tests were failing since the project became a git repo (a scan of `test/fixtures/*` took the project repo as root). They now scan temp copies.
  - Not done: the viewer (Spec 3) is not in this repo, so its loader still drops `changes-with`/`commits` itself; harmless, it can delete that code.

## In progress
- Spec 1 generator milestones are finished (M4 skipped). Next candidates: request matching (the part of M4 that links TS calls to endpoints), the viewer (Spec 3).
- Spec 3 open questions 1–8.

## To do
- Spec 3 v1.0 after its open questions are answered; add a history view (search commit subjects → highlight files, commit-based features).
- Optional M4: request matching first (TS `fetch`/`call` → endpoints); Rust/Tauri/axum only if needed.
- When the generator exists, regenerate the hand-written example: Lettore's root `package.json` makes the root package `pkg:.` (the example uses `pkg:src`).
