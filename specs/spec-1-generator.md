# Spec 1 — Codemap generator

Status: **draft v0.3** (2026-11-26; v0.2 adds git history, §4.7.1; v0.3 records the decisions in §12). Produces files in the format of [Spec 2 v1.1](spec-2-codemap-schema.md); read by the viewer in [Spec 3](spec-3-visualiser.md).

Files: [codemap.config.schema.json](../schema/codemap.config.schema.json) (your config file's contract), [lettore.codemap.config.json](../examples/lettore.codemap.config.json) (example config).

## 1. Goal

A command-line script that reads a repository **without running any of its code** and writes `maps/<project>/map-<project>.json`: every package, folder, file and relevant symbol, the links between them, the tools used, and the features, plus what git history says (which commits touched which files, which files change together), merged with your notes and overrides.

**v1 scope**

- Languages: **TS/JS (incl. JSX/TSX), Python, Rust**. Swift and C++ in v2 (same adapter design, §5).
- Frameworks: React, Redux Toolkit, Express, FastAPI, Flask, Tauri (commands, `invoke`, sidecars), axum (routes).
- Target: medium-size repos (~1,500 files): **under 10 s cold, under 2 s when nothing changed**, on a laptop.

**Not in v1**: type-aware analysis, Swift/C++, watch mode, running build tools (no `tsc`, `cargo`, `pip`).

## 2. Usage

```
codemap <repo>                      # shorthand for `codemap scan <repo>`: the single entry point
codemap scan <repo> [--out <dir>] [--full] [--no-cache] [--no-history] [--quiet]
codemap check <codemap.json>
codemap init <repo>
```

| Command | Does |
|---|---|
| `<repo>` | Same as `scan <repo>`: a path that is not a command name runs `scan`. One command from any folder, only the repo as argument |
| `scan` | Generates or refreshes the codemap. Default out: `maps/<project-name>/` inside this project. Reads `codemap.config.json` from the out folder if present |
| `scan --full` | Emits every symbol (same as `detail.full: ["**"]`) |
| `scan --no-cache` | Ignores the parse cache (§7) |
| `scan --no-history` | Skips the git history step (§4.7.1) |
| `check` | Validates a codemap: JSON Schema + Spec 2 §10 invariants (the existing `check-codemap.mjs`, moved in) |
| `init` | Creates a starter `codemap.config.json` in the out folder with the detected entrypoints, and prints the auto features it found so you can copy the ones you want. Never overwrites an existing config |

Exit codes: `0` ok (warnings allowed), `1` output failed validation (nothing overwritten), `2` bad arguments or unreadable repo.

Console output: one summary line (`lettore: 412 files, 1,830 nodes, 5,204 edges, 12 warnings, 3.1 s`) plus the first 10 warnings; all of them are in `diagnostics`.

## 3. Runtime and dependencies

- **Node 22+, TypeScript**, run locally. Install once with `npm link` in `packages/generator`; then `codemap <repo>` works from any folder. From the project root, `npm run codemap <repo>` does the same (flags after `--`).
- Runtime dependencies, kept to the minimum that does real work:

| Package | Why |
|---|---|
| `web-tree-sitter` + grammar `.wasm` files (typescript, tsx, javascript, python, rust) | Parsing, no native build |
| `jsonc-parser` | `tsconfig.json` and other config files allow comments |
| `smol-toml` | `Cargo.toml`, `pyproject.toml` |

- Dev only: `ajv` (schema validation in tests and in `check`), test runner (`node:test`).
- File listing, hashing, globbing (`fs.glob`), worker threads and git calls use Node built-ins.

## 4. Pipeline

```
discover → parse (cached, parallel) → resolve → detect frameworks → build graph
        → apply detail rule → git history → features → your overrides → tools → metrics/hubs
        → rollups/shards → validate → write
```

Each stage is a pure function from the previous stage's data (except discover, parse and write), so each can be unit-tested.

### 4.1 Discover

1. **Repo root and git**: `git rev-parse --show-toplevel`, `HEAD` commit, `git status --porcelain` (clean or dirty), `origin` URL.
   - **The remote URL is sanitised**: user/password/token parts are removed (`https://user:tok@host/x.git` → `https://host/x.git`). Never written otherwise.
   - Not a git repo: allowed. `commit: null`, no remote.
2. **Files**: `git ls-files --cached` (tracked files only, decision 3). Without git: walk the folder with default ignores.
3. **Always skipped** (listed once per folder as `skipped-file`): `node_modules`, `target`, `dist`, `build`, `.venv`, `venv`, `__pycache__`, `.git`, `vendor`, plus config `ignore` globs. Files over **1 MB**, binary files (NUL byte in first 8 KB), and files with a "generated" header (`@generated`, `DO NOT EDIT`) are skipped or marked `meta.generated`.
4. **Symlinks** are not followed outside the repo.
5. **Language by extension**: `.ts .tsx .mts .cts .js .jsx .mjs .cjs` → TS/JS; `.py` → Python; `.rs` → Rust. Other text files worth showing (`.css`, `.json` configs, `.toml`, `.html`) become `asset` nodes without parsing.

### 4.2 Packages

A package is the folder of a manifest. Every package's `parent` is `project:` (flat); a file belongs to the **deepest** package folder containing it.

| Manifest | Package name | Dependencies (for `external` nodes) |
|---|---|---|
| `package.json` (+ `workspaces`) | `name` | `dependencies`, `devDependencies`, `peerDependencies` |
| `Cargo.toml` (`[package]`, `[workspace].members`) | `package.name` | `[dependencies]`, `[dev-dependencies]` |
| `pyproject.toml`, `setup.cfg`, `setup.py` (read as text, never run), `requirements*.txt` | project name or folder name | listed requirements |

- Id: `pkg:<folder>`, with `pkg:.` for a manifest at the repo root.
- Files outside every package belong to a synthetic root package `pkg:.` named after the project.
- `entrypoints`: `main`/`module`/`bin` in `package.json`, Vite/HTML `<script type="module" src>`, `src/main.rs`/`[[bin]]`, Python files with `if __name__ == "__main__"`, `uvicorn.run`, or `[project.scripts]`; plus config `entrypoints`.

### 4.3 Parse (per file → facts)

Each language **adapter** turns one file into a plain `FileFacts` record. Adapters never look at other files.

```ts
type FileFacts = {
  path: string; lang: string; hash: string; loc: number;
  imports:  { spec: string; names: string[]; line: number; typeOnly?: boolean; dynamic?: boolean }[];
  decls:    { name: string; kind: DeclKind; range: Range; exported: boolean; doc?: string;
              parentDecl?: string; params?: string[]; async?: boolean; methods?: string[];
              declaredAs?: string; decorators?: string[] }[];
  calls:    { callee: string; line: number; inDecl?: string; args: ArgFact[] }[];  // bare names and member calls
  jsx:      { name: string; line: number; inDecl?: string; conditional: boolean }[];
  strings:  { value: string; line: number; inDecl?: string; template: boolean }[]; // only for request matching
  annotations: { feature: string; line: number }[];   // @feature comments
  errors:   { line: number; message: string }[];     // tree-sitter ERROR nodes
};
```

- `ArgFact` keeps only literal values (string, template with placeholders, identifier name) for the first 2 arguments.
- Parse errors don't stop the file: partial facts are kept, and a `parse-error` diagnostic is added.
- Parsing runs in a **worker pool** (`os.availableParallelism() - 1` workers).

### 4.4 Resolve

**Imports → files or externals**

| Language | Rules |
|---|---|
| TS/JS | Relative specifiers with extension probing (`.ts .tsx .js .jsx .mjs .cjs`, `/index.*`); `tsconfig.json` `baseUrl`/`paths` (incl. `extends`); query suffixes stripped (`?url`, `?raw`); bare specifiers → `ext:npm:<pkg>` (scope kept: `@tauri-apps/api/core` → `@tauri-apps/api`); `node:` and Node built-ins dropped |
| Python | Relative imports by dots; absolute imports against the package folder, `src/`, and the importing file's folder (in that order); third-party → `ext:pip:<name>` using the package's requirements (small alias table for known mismatches, e.g. `fitz` → `pymupdf`, `yaml` → `pyyaml`); standard library dropped (static list) |
| Rust | `mod x;` → `x.rs` or `x/mod.rs`; `use crate::a::b` / `super::` / `self::` → module file; external crates → `ext:cargo:<crate>` if in `Cargo.toml`; `std`, `core`, `alloc` dropped |

- Unresolved relative imports → `unresolved-import` diagnostic, no edge.
- Import `names` feed symbol resolution: a call or JSX use of an imported name resolves to the exporting file's symbol (following one level of re-export: `export { X } from './y'`, `export * from`).

**Names → symbols** (for `calls`, `renders`, `uses`, `reads`, `writes`): a bare name resolves to (1) a top-level declaration in the same file, else (2) the symbol it was imported as. Nothing else (no type inference). Resolved through an import or alias = `inferred`; same file = `exact`.

### 4.5 Framework detectors

Detectors are small rule modules reading `FileFacts` + resolution results. Each emits nodes/edges with the confidence shown.

| Detector | Recognises | Emits |
|---|---|---|
| React | Capitalised function/arrow returning JSX, `class X extends Component`, `React.memo`/`forwardRef` wrappers, `React.lazy(() => import(...))` | `component` nodes (`props`, `hooks`, `lazy`), `renders` edges from JSX uses (`conditional` when inside `&&`, ternary, or `if`), `uses` edges to hooks |
| Hooks | `function useX` / `const useX =` | `hook` nodes |
| Redux Toolkit | `createSlice({ name })`, `configureStore({ reducer: { key: slice.reducer } })`, `x.actions` aliases, `useSelector`/typed wrappers (`useAppSelector`), `dispatch(...)` | `store` nodes (`actions`, `stateKeys`); `reads` from selector lambdas `s => s.<key>` → slice registered under `<key>` (`heuristic` if the lambda is not that simple); `writes` from `dispatch(alias.action())` (`inferred`) |
| Express | `app.<method>("/path", …)`, `router.<method>`, `app.use("/prefix", router)` | `endpoint` nodes with prefix joined |
| FastAPI / Flask | `@app.get("/p")`, `@router.post`, `@app.websocket`, `include_router(prefix=)`, `@app.route(methods=)`; `Depends(...)` in the decorator or signature → `auth: true` when the dependency name contains `auth`, `token`, `user` or `login` | `endpoint` nodes |
| axum | `.route("/p", get(h))`, `.nest("/prefix", …)` | `endpoint` nodes; edge `endpoint → handler` as `calls` |
| Tauri | `#[tauri::command] fn x`, `invoke("x")` / `invoke<T>("x")`, `Command.sidecar("name")` / `.sidecar("name")`, `externalBin` in `tauri.conf.json` | `command` nodes; `requests` (`exact`); `spawns` file → package of the sidecar; `configures` from `tauri.conf.json` |
| Requests | `fetch`, `axios.<m>`, `ky`, `requests.<m>`, `httpx.<m>`, `new WebSocket(...)`, **plus wrapper functions**: a function whose body passes its first parameter into one of these URL positions (one level deep), e.g. Lettore's `call(path)` → `get(path)` → `fetch(...)` | `requests` edges to the endpoint whose method and path match (`heuristic`); path matched literally, or by suffix for template URLs (`${base}/parse`). No match → `unmatched-request` diagnostic |
| Tests | `*.test.*`, `*.spec.*`, `test_*.py`, `*_test.py`, `tests/`, Rust `#[cfg(test)]`/`#[test]` | `meta.test` on files; `tests` edges to the files a test imports |
| Annotations | `@feature <id>` in any comment | feature seeds (§4.7) |

Wrapper functions found by the Requests detector are listed in diagnostics at `info` level, so you can see why a link was made; config `requestWrappers` adds ones the rule misses.

### 4.6 Build graph and apply the detail rule

1. Create nodes: project, packages, directories (only those with source files), files, assets, externals (only those actually imported), and every declaration/detector node.
2. Create edges, merging duplicates (`count`), keeping the first 3 `at` locations sorted by path and line.
3. **Detail rule** (Spec 2 §5.2.1): drop non-structural symbols that are private and used only in their own file; set `metrics.hiddenSymbols`; **re-attach** edges touching a dropped symbol to its file, merging duplicates again. `detail.full` paths and `--full` keep everything.
4. Doc comments: first paragraph of JSDoc/TSDoc, Python docstring, Rust `///` or `//!`, trimmed to 300 characters.

### 4.7 Features

Exactly Spec 2 §7.2: seeds from config, `@feature` annotations, one auto feature per `route`/`store`/`endpoint`/`command`, keyword seeds; breadth-first walk to `featureDistance` (default 2) over `imports`, `renders`, `calls`, `reads`, `writes`, `requests`, both directions; hubs (fan-in ≥ `hubFanIn`, default 10) included as `shared` but not walked through; roles as in Spec 2.

- Keyword seeds match whole words of node names and paths (`PdfView.tsx` → `pdf`, `view`) for files and structural symbols.
- Auto feature ids: `feature:<kind>-<slug>` (e.g. `feature:endpoint-post-geometry`). A config feature with the same id replaces it.
- Members are sorted by role (`entry`, `core`, `support`, `shared`), then distance, then id.

### 4.7.1 Git history: which commits touched what

Commit subjects and changed file lists, matched with plain text rules. No AI, no diff contents.

1. **Read**: `git -c core.quotepath=off log --no-merges --no-ext-diff --no-textconv -M --name-status -n <maxCommits> --format=<hash, committer date, subject> HEAD`.
   - Author names and emails are never read. Commit bodies are not read (Q8).
   - Not a git repo → step skipped (`info`). Shallow clone → `shallow-history` diagnostic.
2. **Renames**: walking newest → oldest, `R old new` maps `old` to the file's current path, so older commits count for the file as it is named today.
3. **Only mapped files**: deleted files and files that are not nodes (README, SPEC.md, images, ignored folders) are dropped. A commit left with no mapped file is dropped.
4. **Bulk commits**: more than `history.bulkFiles` (default 50) mapped files (formatting passes, mass renames, imports of old code) → kept and counted, flagged `bulk`, but not used for co-change or grouping.
5. **Output** (Spec 2 §7.5):
   - `history.commits`: hash (12 chars), date (UTC), subject (≤ 200 chars), files, `bulk`. Newest first.
   - File `metrics.commits` and `meta.lastChanged`.
   - **`changes-with` edges**: two files changed together in ≥ `history.coChangeMin` (default 3) non-bulk commits **and** in at least half of the commits of the less-changed one. `count` = shared commits, `confidence: heuristic`, one edge per pair with `from` < `to`. Each file keeps its 10 strongest.
   - Features, from the grouping rules below.

**Grouping commits into features** (literal matching only):

| Rule | A commit matches when | Result |
|---|---|---|
| Keywords | Its subject contains a `keywords` entry of an existing feature (whole word, case-insensitive) | That feature gets the commit |
| Conventional scope | Subject starts `type(scope):`, e.g. `feat(pdf-loading): …`, `fix(player)!: …` | `feature:scope-<slug>`, or the existing `feature:<slug>` if you defined one with that slug |
| Reference | Subject contains a `history.refPatterns` match (default: issue `#123`, tracker key `ABC-45`) | `feature:ref-<slug>`; name = the reference, description = subject of its oldest commit |

A commit can match several rules and several features.

**Members from commits**: each file of a feature's non-bulk commits joins with `origin: "history"`, `commits` = how many of those commits touched it, no `distance`. Role: `shared` if a hub, `core` if in at least half the feature's commits, else `support`. A file that is already a member (graph walk or you) keeps its role and distance and only gains `commits`. Features created here have `source: "history"`; every feature that matched commits lists them in `commits` (hashes, newest first).

Lettore's subjects (`M3.8: blue underline on the sentence being read`) use milestone ids, not scopes or tickets: its config adds the pattern `\bM\d+(\.\d+)?\b`, which gives `feature:ref-m3-8` with `PdfView.tsx`, `player.ts`, `chunker.py`, `main.py` and `styles.css` as core and `store.ts` (a hub) as shared: the files that feature touched across TS and Python. The same history yields `sidecar/main.py changes-with src/App.tsx` (3 of 3 commits).

Every commit stays searchable by subject in `history.commits`, even when no rule groups it.

### 4.8 Your overrides

Merged after everything else, so they always win (Spec 2 §7.4): `notes` → `note`; `edges` → `confidence: "manual"` (replacing a generated edge with the same key); feature `include`/`exclude`/`roles` → `origin: "user"`; `tools` → `meta.category`; `entrypoints` added. Every id in the config that doesn't exist → `stale-override` warning (the override is skipped, not lost: it stays in your config).

### 4.9 Tools, metrics, hubs

- **Tools**: built-in registry `registry/tools.json` (package name or prefix → category, ~200 common packages across npm, PyPI, crates.io), overridden by config `tools`. Unknown packages → `other`.
- **Metrics**: `loc` = lines in the file; `fanIn`/`fanOut` = distinct files importing / imported (externals excluded); `children` = child node count on containers.
- **Hubs**: files with `fanIn ≥ hubFanIn` get tag `hub`.
- **Entry depth**: breadth-first over `renders` from the root components (components rendered in an entrypoint file, e.g. `createRoot(...).render(<App/>)`); unreachable components get `-1`.

### 4.10 Rollups and shards

- Rollups for `package` and `directory` pairs (sum of `count` of the edges between their descendants), always computed; written in single-file mode too (cheap, and the viewer needs them for closed cards).
- Above 20,000 nodes or 10 MB: shard by package (a package over 10 MB is split by its top-level folders). Manifest and shard contents as in Spec 2 §8.

### 4.11 Validate and write

1. Sort nodes by `id` and edges by (`from`, `kind`, `to`); sort features, tools, rollups and diagnostics too.
2. Validate against `codemap.schema.json` and the Spec 2 §10 invariants. **On failure**: write nothing over the previous codemap; write `map-<project>.invalid.json` next to it and exit `1`.
3. Write each file to a temporary name, then rename, so a crash never leaves a half-written codemap.
4. Layout: 2-space indent, **one node / edge / member per line** (as in the example), so git diffs show one line per change.
5. **Determinism**: same repo state → byte-identical output. `generatedAt` is the `HEAD` commit time when the tree is clean, and the current time only when it is dirty or not a git repo.

## 5. Adapters (per language)

One folder per language, same interface, so Swift and C++ can be added in v2 without touching the rest:

```ts
interface LanguageAdapter {
  id: "typescript" | "python" | "rust";
  extensions: string[];
  grammar: string;                                  // wasm file
  facts(tree: Tree, source: string, path: string): FileFacts;
  resolveImport(spec: string, from: string, ctx: ResolveContext): ResolvedImport | null;
}
```

What each adapter extracts as `decls`:

| | Exported when | Kinds |
|---|---|---|
| TS/JS | `export`, `export default`, `module.exports` | function, class, type/interface, const arrow functions, components/hooks via detectors |
| Python | name without leading `_` at module level (or listed in `__all__`) | `def`, `async def`, `class` (methods by name) |
| Rust | `pub` (any visibility modifier) | `fn`, `struct`, `enum`, `trait`, `impl` methods (attached to the type), `mod`, `type` |

## 6. Your config file (`codemap.config.json`)

Lives in the codemap's out folder (`maps/<project>/`), never in the repo. Contract: [codemap.config.schema.json](../schema/codemap.config.schema.json). Example: [lettore.codemap.config.json](../examples/lettore.codemap.config.json).

| Key | Purpose | Default |
|---|---|---|
| `project` | Display name override | repo folder name |
| `ignore` | Extra globs to skip | `[]` |
| `entrypoints` | Extra entry files/symbols | `[]` |
| `requestWrappers` | Function names to treat as HTTP wrappers (`{ "name": "call", "method": "GET" }`) | `[]` |
| `hubFanIn` | Hub threshold | `10` |
| `featureDistance` | Feature walk depth | `2` |
| `detail.full` | Paths where every symbol is emitted | `[]` |
| `features` | Your features (`seeds`, `keywords`, `include`, `exclude`, `roles`, `description`) | `[]` |
| `notes` | Node id → your note | `{}` |
| `edges` | Manual edges (`from`, `to`, `kind`, `note`) | `[]` |
| `tools` | Package → category | `{}` |
| `history` | `enabled`, `maxCommits`, `bulkFiles`, `coChangeMin`, `refPatterns` (§4.7.1) | `true`, `100`, `50`, `3`, `["#\\d+", "\\b[A-Z][A-Z0-9]+-\\d+\\b"]` |

Plain JSON (no comments), so any tool can read and write it; the viewer may edit it later (Spec 3 Q3).

## 7. Incremental runs

- **Parse cache** in `maps/<project>/.cache/facts/`: one file per content hash (`<sha256>.json`), tagged with the adapter version. A file whose content didn't change is not re-parsed, even after a rename.
- Everything after parsing is recomputed every run (fast: it's in-memory graph work), so results never drift from a cold run.
- Cache entries not used by the current run are deleted at the end.
- **History cache** `.cache/history.json`, keyed by `HEAD`: if the cached `HEAD` is an ancestor of the new one, only the new commits are read; otherwise history is read again.
- `.cache/` is excluded when you copy/share the folder (the viewer ignores it; Spec 3).

## 8. Safety and robustness

- **Never runs repo code**: no `require`/`import` of repo files, no `setup.py`, no build scripts. Config files (`vite.config.ts`, `tauri.conf.json`) are parsed, not evaluated.
- Never writes inside the repo.
- One bad file never stops the run: parse errors, unreadable files, encoding problems → diagnostics.
- Paths in the output are always repo-relative POSIX; absolute paths are rejected by the writer (assert).
- Remote URL credentials are stripped (§4.1).
- Git is only asked to list (`log`, `ls-files`, `rev-parse`, `status`), with external diff and text-conversion drivers off, so no repo-configured program runs. No author names or emails are read.

## 9. Source layout

```
code-reader/
  packages/
    schema/        codemap types (TS), codemap.schema.json, config schema, check  ← shared with the viewer
    generator/
      src/cli.ts
      src/discover/   git.ts, files.ts, packages.ts
      src/parse/      pool.ts, cache.ts
      src/lang/       typescript.ts, python.ts, rust.ts
      src/detect/     react.ts, redux.ts, express.ts, fastapi.ts, axum.ts, tauri.ts, requests.ts, tests.ts, annotations.ts
      src/graph/      build.ts, detail.ts, features.ts, overrides.ts, metrics.ts, rollups.ts, shards.ts
      src/history/    gitlog.ts (read + renames), history.ts (metrics, changes-with, grouping)
      src/write.ts
      registry/tools.json
      test/fixtures/  ts-react-redux/, python-fastapi/, rust-tauri/, lettore-like/, git-history/ (scripted commits)
    viewer/        (Spec 3)
```

## 10. Tests

| Test | Checks |
|---|---|
| Adapter unit tests | Each language: imports, decls, exports, docs, calls, JSX, parse-error tolerance |
| Resolver unit tests | Extension probing, `tsconfig` paths, re-exports, Python relative/absolute/stdlib, Rust `mod`/`use` |
| Detector unit tests | One small snippet per rule in §4.5, including Lettore's `call()` wrapper |
| Golden fixtures | Each fixture repo → expected `codemap.json` (committed). Fails on any difference |
| Lettore-like fixture | A trimmed copy of Lettore's structure (TS + Python + Rust): must contain the cross-language feature, `PageView`, the lifted `/geometry` edge, the `sidecar_info` command, and the manual `WS /speak` edge from config |
| Validation | Every golden output passes the JSON Schema (ajv) and the §10 invariants |
| Determinism | Two runs → identical bytes; shuffled file order → identical bytes |
| Incremental | Change one file → only that file is re-parsed; output equals a `--no-cache` run |
| History | Scripted repo: renames followed, docs-only and deleted files dropped, bulk commit excluded from co-change, `changes-with` threshold, scope/ref/keyword grouping, member roles, no author data in output, same `HEAD` → same bytes |
| Overrides | Notes, manual edges, include/exclude/roles applied; unknown id → `stale-override` |
| Safety | Remote URL with a token is sanitised; no absolute paths in output; symlink outside the repo is not followed |
| Performance | A generated 1,500-file fixture: cold < 10 s, warm < 2 s (reported, fails above 2× the target) |

## 11. Milestones

Each ends with a run on Lettore and a passing `check`.

1. **M1 Skeleton**: CLI, discover, packages, TS/JS imports, file/dir/package/external nodes, validate + write. Lettore's file tree and imports visible.
2. **M2 TS symbols**: decls, detail rule, React components/hooks/renders, Redux stores/reads/writes, entry depth.
3. **M3 Python**: adapter, resolver, FastAPI/Flask endpoints.
4. **M4 Rust + bridges**: adapter, resolver, Tauri commands/sidecars, axum, request matching with wrapper detection. *Skipped for now (2026-11-26): few Rust apps. Request matching is the part that links TS calls to Python endpoints.*
5. **M5 Features and you**: features, annotations, git history (§4.7.1), config overrides, tools registry, `init`.
6. **M6 Scale**: parse cache, worker pool, rollups, sharding, performance test. *Done.*

## 12. Decisions (2026-11-26)

| # | Question | Decision |
|---|---|---|
| 1 | Repo layout | One repo holding `schema`, `generator` and `viewer` packages (§9). |
| 2 | Standard libraries | Dropped entirely (less noise). |
| 3 | Untracked files | Not included: tracked files only (§4.1). Outside git, the folder is walked. |
| 4 | `generatedAt` | Commit time when clean, current time when dirty (§4.11). |
| 5 | `init` | Kept in v1: the tool writes the starter config for you (§2), so you edit instead of writing from scratch. |
| 6 | Lettore as a fixture | A trimmed copy goes into the test fixtures (§10). |
| 7 | History depth | Last **100** commits (`history.maxCommits` default, §4.7.1, §6). |
| 8 | Commit bodies | Subjects and changed files only (§4.7.1). The goal is to map functionality to components. |
| 9 | Symbol-level history | No changed lines. Commits map to files; the components and functions declared in a changed file are reached through containment (`parent`). |
| 10 | Lettore's milestone ids | Pattern stays in Lettore's config, not in the default `refPatterns`. |
