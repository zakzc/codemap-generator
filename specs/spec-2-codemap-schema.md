# Spec 2 — Codemap schema (`codemap/1`)

Status: **v1.1** (2026-11-26) — all open questions decided (§13). v1.1 adds git history (§7.5): optional fields only, same `codemap/1` format. Part of a 3-spec series:

| Spec | What | Depends on |
|---|---|---|
| 1 | Generator script: scans a repo, writes a codemap | this spec |
| **2** | **Codemap file format (this document)** | — |
| 3 | Visualiser (Tauri + TS now, Swift later) | this spec |

Files: [codemap.schema.json](../schema/codemap.schema.json) (machine-readable contract), [lettore.codemap.json](../examples/lettore.codemap.json) (worked example), [check-codemap.mjs](../schema/check-codemap.mjs) (integrity check).

## 1. Goals and non-goals

**Goals**

1. Answer, from one file and without reading code:
   - What is inside what (packages → folders → files → components/functions)?
   - Who imports, renders, calls, reads or writes what?
   - Which tools (Redux, auth, router, HTTP, IPC…) are used, and where?
   - **"I want to work on feature X — which files do I open, in what order?"**
   - How does a component get loaded (from which entrypoint, lazily or not, how deep)?
   - Which commits touched which files, and which files usually change together?
2. Produced **deterministically** by a script (Spec 1). No AI. Same input → same output (byte-identical, so it diffs cleanly).
3. **Portable**: plain JSON with no absolute paths or machine-specific data, so a codemap can be copied to another machine (e.g. at work) and opened there. A SQLite form can be derived from the JSON later; the JSON stays the source of truth.
4. Targets **medium-size codebases** comfortably; sharding (§8) is there so larger ones don't break.
5. Language-neutral: TS/JS, Python, Rust, Swift, C++ share the same node and edge kinds (§5.5).
6. **Your understanding wins**: notes and overrides you write are merged in and always beat generated data (§7.4).
7. Easy to decode in TypeScript **and** Swift `Codable` (no exotic unions, no tuples of mixed types).

**Non-goals**

- Natural-language summaries. The only prose is doc comments from the code and notes you write.
- Exact, type-aware call graphs (§6.3).
- Layout/positions. That is the viewer's job (Spec 3).

## 2. What we take from the two reference projects

| Idea | Floorplan | Understand-Anything | Codemap decision |
|---|---|---|---|
| Hierarchy | `parent` chain on nodes, dotted ids | `contains` edges + `layers` | **`parent` field** (cheaper than edges, one parent per node) |
| Node kinds | 11 coarse kinds (`ui`, `service`, `data`…) | 27 kinds incl. design/knowledge | ~15 code-only kinds (§5.2) |
| Edge kinds | 8 (`import`, `call`, `http`, `rpc`, `event`…) | 38 incl. semantic (`similar_to`) | 13 kinds: 12 from the code, plus `changes-with` from git history (§6.2) |
| Features / flows | AI writes `flows`, `tour` | AI writes `layers`, `tour`, domains | **Rule-based features** from config, annotations, routes, stores, endpoints, keywords (§7) |
| Cross-language links | matches `fetch()` calls to endpoints | — | `requests` edge: client call → endpoint node (§6.2) |
| Who decides grouping | AI step | AI step | **Your `codemap.config.json`** plus heuristics |
| Human input | AI-written `architecture.json`, editable | — | **Notes, manual edges and feature overrides** in config (§7.4) |
| Incremental updates | per-file fingerprint | SHA-256 + signature diff | `hash` on file nodes (Spec 1 can skip unchanged files) |
| Confidence | "pattern matching, not a compiler" | weight 0–1 | `confidence: exact \| inferred \| heuristic \| manual` on every edge |
| Large repos | not documented | batching, one big file | **Optional sharding + precomputed rollups** (§8) |

Not taken: AI summaries, `complexity` labels, semantic/similarity edges, personas, design/knowledge node types.

## 3. File layout

Codemaps live in a **folder outside the analysed repos**, one sub-folder per project. Default `~/Codemaps/` (configurable in Spec 1).

```
~/Codemaps/
  lettore/
    codemap.json           ← generated (single file, or manifest when sharded)
    codemap.config.json    ← yours: features, notes, manual edges, overrides (§7.4)
    shards/                ← generated, only when sharded
      src.json
      sidecar.json
```

- The folder is self-contained: copy it to another machine and the viewer opens it there.
- **Where the repo lives on this machine** is not stored in the folder. The viewer keeps that per machine (Spec 3) and uses `project.remote` / `project.name` to suggest a match. Without it, the map still works; only source preview and "open in editor" need it.
- Sharding: single file up to **20,000 nodes or 10 MB**, sharded above.
- Optional `.json.gz` for either. Readable keys compress ~10×, so we keep them readable rather than abbreviating.

## 4. Top-level document

```jsonc
{
  "format": "codemap/1",           // major version; breaking change → codemap/2
  "generator": { "name": "codemap", "version": "0.1.0", "generatedAt": "2026-11-26T10:00:00Z" },
  "project": {
    "name": "lettore",
    "root": ".",                   // repo root; all paths are relative to it, POSIX "/"
    "remote": "git@github.com:me/lettore.git",  // optional, from git origin; helps find the repo on another machine
    "commit": "a1b2c3d",           // null if not a git repo
    "languages": ["typescript", "python", "rust"],
    "entrypoints": ["file:src/main.tsx", "file:sidecar/main.py", "file:src-tauri/src/main.rs"]
  },
  "tools":    [ /* §7.1  libraries/services grouped by category */ ],
  "features": [ /* §7.2  "work on X → open these" */ ],
  "nodes":    [ /* §5 */ ],
  "edges":    [ /* §6 */ ],
  "rollups":  [ /* §8.2  aggregated edges between containers (sharded only, optional otherwise) */ ],
  "shards":   [ /* §8.1  present only in a sharded manifest */ ],
  "history":  { /* §7.5  commits → files, from git log (optional) */ },
  "diagnostics": [ /* §9  unresolved imports, parse errors, stale overrides */ ]
}
```

Rules:

- Arrays are **sorted** (nodes by `id`, edges by `from`,`kind`,`to`) so output is stable and diff-friendly.
- No absolute paths, user names or machine names anywhere in the file.
- Unknown fields must be ignored by readers (forward compatibility). New optional fields = minor change, no format bump.
- Omit empty/default fields (`tags: []`, `exported: false`) to save space; readers apply defaults.

## 5. Nodes

### 5.1 Fields

| Field | Type | Req | Meaning |
|---|---|---|---|
| `id` | string | ✓ | Stable, readable id (§5.3) |
| `kind` | enum | ✓ | §5.2 |
| `name` | string | ✓ | Display name (`PdfView`, `store.ts`, `/parse`) |
| `parent` | id \| null | ✓ | Container. `null` only for the root `project` node |
| `path` | string | | File/dir path. Symbols inherit their file's path |
| `range` | `{start,end}` | | 1-based line range inside `path` |
| `lang` | string | | `typescript`, `python`, `rust`, `swift`, `cpp`… |
| `exported` | bool | | Visible outside its file/module |
| `doc` | string | | First paragraph of the doc comment, verbatim, ≤ 300 chars |
| `note` | string | | **Your** note from `codemap.config.json` (§7.4). Shown above `doc` |
| `tags` | string[] | | Free labels: `test`, `generated`, `entry`, `lazy`, `hub` |
| `metrics` | object | | `loc`, `fanIn`, `fanOut`, `children`, `hiddenSymbols`, `commits` (all integers; `commits` = commits that touched the file, §7.5) |
| `hash` | string | | `sha256:<hex>` of file content (file nodes only) |
| `meta` | object | | Kind-specific detail (§5.4) |

### 5.2 Kinds

| Kind | What | Example (Lettore) |
|---|---|---|
| `project` | Root | `lettore` |
| `package` | Independently built unit (npm workspace, Cargo crate, Python package, SwiftPM/Xcode target, CMake target) | `src`, `sidecar`, `src-tauri` |
| `directory` | Folder | `src/components` |
| `file` | Source file | `src/PdfView.tsx` |
| `component` | UI component (React function/class, SwiftUI `View`, Vue SFC) | `PdfView` |
| `hook` | React hook / composable | `useAppSelector` |
| `function` | Function / free function | `play`, `parse_pdf` |
| `class` | Class / struct / enum / actor / trait / protocol with behaviour | `Sidecar` |
| `type` | Type alias / interface / data-only protocol | `RootState` |
| `store` | State container or slice (Redux slice, Zustand store, Pinia, `@Observable`, `ObservableObject`) | `documentSlice` |
| `route` | Client-side route / screen | `/settings` |
| `endpoint` | Server endpoint: HTTP, WebSocket, RPC | `POST /parse` |
| `command` | IPC command exposed across a boundary (Tauri `#[tauri::command]`, Electron `ipcMain.handle`) | `sidecar_info` |
| `external` | Thing outside the repo: npm/pip/cargo/SwiftPM package, system library, or remote service. `parent` = `project` | `npm:@reduxjs/toolkit` |
| `asset` | Non-code file worth showing (CSS, worker, config) | `src/styles.css` |

### 5.2.1 Detail level: what is emitted

Goal: not every detail, but **never a partial view**. A file must never look smaller or simpler than it is.

**Always emitted**

1. Every `package`, every `directory` that contains source files, and every source `file`. No source file is ever left out (only ignored globs and generated/vendor folders are skipped, and those are listed in `diagnostics` as `skipped-file`).
2. Every node of a **structural kind**, exported or not: `component`, `hook`, `store`, `route`, `endpoint`, `command`, and top-level `class`.
3. A `function` or `type` when it is exported, used from another file, an entrypoint (`main`, `@main`, `if __name__ == "__main__"`), or a test.

**Not emitted as nodes**

- Private top-level functions/types used only inside their own file, nested functions, locals, and methods. Methods are listed by name in the class's `meta.methods`.

**Nothing is silently lost**

- Each file node has `metrics.hiddenSymbols` = how many top-level symbols were not emitted, so the viewer can show "+2 internal".
- An edge whose end is a hidden symbol is **attached to that symbol's file** (e.g. `spanRects()` inside `PdfView.tsx` calls `/geometry` → edge `file:src/PdfView.tsx → endpoint:POST /geometry`). Connections are never dropped because a symbol was hidden.
- `codemap.config.json` can ask for **full detail** on chosen paths (§7.4), e.g. the area you are working on.

### 5.3 Ids

`<prefix>:<path>[#<symbol>]`, deterministic, readable, unique.

| Kind | Id pattern |
|---|---|
| project | `project:` |
| package / directory / file / asset | `pkg:sidecar`, `dir:src`, `file:src/PdfView.tsx` |
| symbol in a file | `sym:src/PdfView.tsx#PdfView`, nested: `sym:src/store.ts#documentSlice.setDoc`, C++ namespace: `sym:src/a.cpp#ns::Foo` |
| route | `route:/settings` |
| endpoint | `endpoint:POST /parse` (`WS /speak` for websockets) |
| command | `command:tauri:sidecar_info` |
| external | `ext:npm:@reduxjs/toolkit`, `ext:pip:fastapi`, `ext:cargo:serde`, `ext:spm:Alamofire`, `ext:sys:Qt6Core`, `ext:http:api.github.com` |

- Overloads (C++, Swift) share one node; `meta.overloads` holds the count.
- Renaming a file changes its id; that is accepted. Notes keyed to old ids are reported as `stale-override` (§9).

### 5.4 `meta` per kind

All optional. Readers must tolerate missing keys.

| Kind | `meta` keys |
|---|---|
| `component` | `props: string[]`, `hooks: string[]` (names called), `lazy: bool` (`React.lazy`/dynamic import), `entryDepth: int` (render-tree distance from the root component, `-1` = never rendered), `conditional: bool` (only rendered inside a condition) |
| `hook` | `hooks: string[]` |
| `function` | `async: bool`, `params: string[]`, `overloads: int` |
| `class` | `declaredAs: "class"\|"struct"\|"enum"\|"actor"\|"trait"\|"protocol"\|"interface"`, `methods: string[]` |
| `store` | `framework: "redux"\|"zustand"\|"swiftui"\|…`, `actions: string[]`, `stateKeys: string[]` |
| `endpoint` | `method`, `path`, `framework` (`fastapi`, `express`, `axum`…), `auth: bool` (dependency/middleware detected) |
| `command` | `framework: "tauri"\|"electron"` |
| `route` | `path`, `lazy: bool` |
| `external` | `ecosystem: "npm"\|"pip"\|"cargo"\|"spm"\|"sys"\|"http"`, `version`, `category` (§7.1) |
| `file` | `generated: bool`, `test: bool`, `lastChanged` (ISO date-time, UTC, of the last commit touching it, §7.5) |

### 5.5 Language mapping

How each target language fills the same kinds. Detail belongs to Spec 1; this table fixes the vocabulary.

| | TS/JS | Python | Rust | Swift | C++ |
|---|---|---|---|---|---|
| `package` | `package.json` workspace | `pyproject`/package dir | Cargo crate | SwiftPM / Xcode target | CMake target |
| `component` | React/Vue component | — | — | `View` struct | (Qt widget class, later) |
| `class` | class | class | struct/enum/trait | class/struct/enum/actor/protocol | class/struct |
| `store` | Redux/Zustand | — | — | `@Observable`, `ObservableObject` | — |
| `endpoint` | Express/Next routes | FastAPI/Flask | axum/actix | Vapor | — |
| `command` | Electron IPC | — | `#[tauri::command]` | — | — |
| `imports` | `import`/`require` | `import`/`from` | `use`/`mod` | `import` module + same-target files | `#include` |

## 6. Edges

### 6.1 Fields

| Field | Type | Req | Meaning |
|---|---|---|---|
| `from` | id | ✓ | Source node |
| `to` | id | ✓ | Target node |
| `kind` | enum | ✓ | §6.2 |
| `confidence` | enum | | `exact` (resolved by a parser, default), `inferred` (resolved by name through imports/aliases), `heuristic` (pattern/string match), `manual` (written by you in config) |
| `count` | int | | Number of occurrences collapsed into this edge (default 1) |
| `at` | `{path,line}`[] | | Up to 3 evidence locations (click → open file at line) |
| `meta` | object | | `names: string[]` for imports, `typeOnly`, `dynamic`; `note` for manual edges |

One edge per (`from`, `kind`, `to`). Repeats raise `count`.

### 6.2 Kinds

| Kind | From → To | Detected from |
|---|---|---|
| `imports` | file → file / external | `import`, `require`, `from x import`, `use crate::`, `#include` |
| `renders` | component → component | JSX `<PdfView/>`, SwiftUI body |
| `calls` | function/component → function | Syntax only, v1 rule in §6.3 |
| `uses` | component/function → hook / tool external | Hook calls, `use*` of a library API |
| `reads` | component/function → store | `useSelector`, `getState`, `@Environment` |
| `writes` | component/function → store | `dispatch(slice.actions.x)` |
| `requests` | function/component/file → endpoint / command | `fetch("/parse")`, `call("/parse")`, `invoke("sidecar_info")` matched to a known endpoint/command |
| `routes` | route → component | Router config |
| `extends` | class → class/type | `extends`, `: Base`, protocol/trait conformance |
| `tests` | test file → file | Test imports subject; filename convention |
| `spawns` | file → package | Process/sidecar launch (`Command.sidecar`, `subprocess`) |
| `configures` | asset/config → package/file | `tauri.conf.json` → sidecar, `vite.config.ts` |
| `changes-with` | file → file | Git history: changed together in the same commits (§7.5). Undirected, stored once with `from` < `to`; `count` = shared commits |

Containment is **not** an edge — it is `parent`.

### 6.3 Honesty about precision

- `imports`, `renders`, `routes`, `extends` → normally `exact`.
- **`calls`, v1 rule (no type checker)**: from the syntax tree only. A call whose callee is a bare name that resolves to an imported symbol or a top-level symbol of the same file becomes a `calls` edge with `inferred`. Method calls (`obj.m()`), callbacks, function values and virtual/dynamic dispatch are skipped. If this proves noisy in testing, `calls` is dropped from v1; nothing else depends on it.
- `requests` URL matching (`call("/parse")` → `endpoint:POST /parse`) → `heuristic`; the viewer shows these dashed. URLs built at run time can't be matched: add them as manual edges (§7.4).
- `changes-with` (git co-change) → always `heuristic`: files that change together are often, not always, related.
- Anything the script cannot resolve goes to `diagnostics`, never silently dropped.

## 7. Tools, features, notes

### 7.1 Tools

A grouped index of `external` nodes, so the viewer can answer "where is Redux used?" in one click.

```jsonc
"tools": [
  { "category": "state",   "nodes": ["ext:npm:@reduxjs/toolkit", "ext:npm:react-redux"] },
  { "category": "ipc",     "nodes": ["ext:npm:@tauri-apps/api"] },
  { "category": "http-server", "nodes": ["ext:pip:fastapi"] }
]
```

Categories come from a **built-in registry** in Spec 1 (package name → category), overridable in `codemap.config.json`. Starting vocabulary:
`ui`, `state`, `routing`, `data-fetching`, `http-server`, `auth`, `database`, `storage`, `ipc`, `i18n`, `testing`, `build`, `styling`, `validation`, `logging`, `media`, `ml`, `other`.

### 7.2 Features ("I want to work on X")

A feature is a named set of nodes, each with a **role** and **distance**, so the viewer can show "open these first".

```jsonc
{
  "id": "feature:document-loading",
  "name": "Document loading",
  "source": "config",                // config | annotation | route | store | endpoint | command | keyword | history
  "seeds": ["sym:src/App.tsx#App", "endpoint:POST /parse"],
  "members": [
    { "node": "sym:src/App.tsx#App",            "role": "entry",   "distance": 0 },
    { "node": "endpoint:POST /parse",           "role": "core",    "distance": 0 },
    { "node": "file:sidecar/parse.py",          "role": "core",    "distance": 1 },
    { "node": "sym:src/store.ts#documentSlice", "role": "core",    "distance": 1 },
    { "node": "sym:src/PdfView.tsx#PdfView",    "role": "core",    "distance": 1 },
    { "node": "file:src/api.ts",                "role": "shared",  "distance": 1 },
    { "node": "file:sidecar/chunker.py",        "role": "support", "distance": 2, "origin": "user" }
  ]
}
```

`origin` is `auto` (default, computed), `user` (added or re-roled by you, §7.4) or `history` (joined only through commits, §7.5; has `commits` and no `distance`). Any member may carry `commits` (how many of the feature's commits touched it), and a feature that matched commits lists them in `commits` (hashes, newest first).

**How Spec 1 derives features, deterministically** (in priority order, merged by `id`):

1. **Config** — `codemap.config.json` lists features with `seeds` (ids or globs) and optional `keywords`. The main mechanism.
2. **Annotations** — a comment `@feature document-loading` in a file makes that file (or the next symbol) a seed.
3. **Automatic** — one feature per `route`, `store`, `endpoint`, `command` (`source` = that kind). Gives useful features with zero config.
4. **Keyword** — identifiers/paths matching a feature's `keywords` (`load`, `pdf`, `parse`) become seeds with `heuristic` flavour.
5. **History** — commits grouped by keyword, conventional-commit scope or reference (`#123`, `ABC-45`, your own patterns) add their files (§7.5).

**Membership** = breadth-first walk from seeds over `imports`, `renders`, `calls`, `reads`, `writes`, `requests` edges (not `changes-with`), both directions, **max distance 2**. Stops expanding at **hub** nodes (**fan-in ≥ 10**, tagged `hub`, e.g. `api.ts`, `store.ts`) — hubs are included with role `shared` but not walked through, otherwise every feature would swallow the whole app. Both numbers are config settings and may be tuned after use tests.

**Roles**

| Role | Rule |
|---|---|
| `entry` | A seed that is a UI component, route, or user-triggered function |
| `core` | A seed, or distance 1 and not a hub |
| `support` | distance ≥ 2 |
| `shared` | A hub (used by many features) |

### 7.3 "How does this component load?"

Answered from data already in the map, no extra section:

- `meta.entryDepth` and `meta.lazy` / `meta.conditional` on the component.
- The `renders` chain back to a root (the viewer walks `renders` edges in reverse to draw `main.tsx → App → PdfView`).
- `reads`/`requests` edges from the component = what it needs before it can show data.
- `meta.hooks` lists effects (`useEffect`) and data hooks.

### 7.4 Your notes and overrides

Everything you know that the script can't see goes in `codemap.config.json`, next to the generated codemap. The generator merges it in on every run; **your input always wins**.

```jsonc
{
  "features": [
    {
      "id": "feature:document-loading",
      "name": "Document loading",
      "description": "Pick a PDF, parse it in the sidecar, store and render it.",
      "seeds": ["sym:src/App.tsx#App", "endpoint:POST /parse"],
      "keywords": ["pdf", "parse"],
      "include": ["file:sidecar/chunker.py"],         // add members  → origin "user"
      "exclude": ["file:src/voices.ts"],              // remove members
      "roles": { "sym:src/PdfView.tsx#PdfView": "core" } // change a role → origin "user"
    }
  ],
  "notes": {
    "file:src/api.ts": "All sidecar HTTP goes through get(); it adds the X-Token header."
  },
  "edges": [
    { "from": "sym:src/player.ts#play", "to": "endpoint:WS /speak", "kind": "requests",
      "note": "URL comes from speakUrl(), so the scanner can't match it" }
  ],
  "tools": { "kokoro-js": "ml" },
  "detail": { "full": ["src/player.ts"] },           // emit every symbol under these paths
  "hubFanIn": 10,
  "featureDistance": 2,
  "ignore": ["**/dist/**", "**/build/**"]
}
```

How each override lands in the codemap:

| Config | Result in `codemap.json` |
|---|---|
| `notes` | node `note` |
| `edges` | edge with `confidence: "manual"`, note in `meta.note`; replaces a generated edge with the same (`from`, `kind`, `to`) |
| `features[].include` / `roles` | member with `origin: "user"` |
| `features[].exclude` | member removed |
| `tools` | `external` node `meta.category` |
| `detail.full` | all symbols emitted under those paths (§5.2.1) |

Any id in the config that no longer exists produces a `stale-override` diagnostic, so renamed files don't silently lose your notes.

The exact config schema is part of Spec 1. Whether the viewer can edit it is Spec 3 Open Question 3.

### 7.5 Git history

What the commit log says, read without AI (Spec 1 §4.7.1): commit subjects and the files each commit changed.

```jsonc
"history": {
  "scanned": 6,                     // commits read (≤ maxCommits)
  "truncated": false,               // true if maxCommits was reached or the clone is shallow
  "commits": [                      // newest first; only commits touching mapped files
    { "hash": "2784ec44a3a2", "date": "2026-11-25T10:06:18Z",
      "subject": "M4: first-run model download with progress; packaging status (SPEC §8 M4)",
      "files": ["file:sidecar/main.py", "file:src/App.tsx"] },
    { "hash": "…", "date": "…", "subject": "Format everything", "files": ["…"], "bulk": true }   // illustration
  ]
}
```

| Where | What |
|---|---|
| `history.commits[]` | `hash` (12 hex chars), `date` (UTC), `subject` (first line, ≤ 200 chars), `files` (file ids under their **current** names, renames followed), `bulk` (too many files to say anything about how files relate; still counted) |
| File `metrics.commits`, `meta.lastChanged` | How often and how recently a file changed |
| `changes-with` edges | Files that usually change together (thresholds in Spec 1) |
| Features | `source: "history"` features from scopes/references; `commits` on features and members; members with `origin: "history"` (§7.2) |

- **No author names or emails**, and no commit bodies: the file stays shareable (§4).
- Files that aren't nodes (docs, images) are not listed. A commit with no mapped file is left out.
- Your overrides still win: `exclude` removes a history member like any other.


## 8. Scaling

### 8.1 Shards

When sharded, the manifest has:

```jsonc
"shards": [
  { "id": "src", "path": "shards/src.json", "root": "pkg:src", "nodes": 412, "edges": 1310, "hash": "sha256:…" }
]
```

- The manifest keeps `project`, `tools`, `features`, `rollups`, and every node down to `directory` level (so the tree can draw collapsed).
- A shard file is `{ "format": "codemap/1", "shard": "src", "nodes": [...], "edges": [...] }` holding everything under its `root`.
- An edge lives in the shard of its `from` node. Cross-shard `to` ids are allowed; the viewer loads the other shard on demand.
- Feature `members` may point into unloaded shards; the viewer resolves them lazily.

### 8.2 Rollups

Pre-aggregated edges between containers, so a collapsed view draws correct arrows without loading details:

```jsonc
"rollups": [
  { "from": "pkg:src", "to": "pkg:sidecar", "kind": "requests", "count": 6 },
  { "from": "dir:src/components", "to": "dir:src/store", "kind": "reads", "count": 23 }
]
```

Emitted for `package` and `directory` pairs. Required in sharded mode; optional in single-file mode (the viewer can compute them).

### 8.3 Size budget (estimate)

~150 bytes/node and ~90 bytes/edge minified. A medium app (~1,500 files) ≈ 10k nodes + 35k edges ≈ 5 MB raw, under 1 MB gzipped: one file. A 5,000-file app ≈ 40k nodes + 150k edges ≈ 20 MB: sharded.

## 9. Diagnostics

```jsonc
"diagnostics": [
  { "level": "warn", "code": "unresolved-import", "path": "src/x.ts", "line": 3, "message": "Cannot resolve './old'" }
]
```

Codes: `unresolved-import`, `parse-error`, `unmatched-request`, `ambiguous-symbol`, `skipped-file`, `stale-override`, `shallow-history`.

## 10. Invariants (checked by `check-codemap.mjs`, enforced by Spec 1 tests)

1. `id`s are unique.
2. Exactly one node has `parent: null`, and it is `kind: project`.
3. Every `parent`, edge `from`/`to`, feature seed/member, tool node, rollup end and history commit file refers to an existing node (or, in sharded mode, to a node in a listed shard).
4. Following `parent` never loops.
5. No two edges share (`from`, `kind`, `to`).
6. Arrays are sorted as in §4 (`history.commits` newest first, then by hash).
7. `changes-with` edges have `from` < `to`; every hash in a feature's `commits` is in `history.commits`.

JSON Schema covers shapes; these cross-references need the script.

## 11. Swift / TypeScript notes

- Every polymorphic thing is discriminated by a string `kind`, and `meta` is a plain object → TS: `Record<string, unknown>`; Swift: a small `JSONValue` enum.
- No tuples: ranges are `{start,end}`, evidence is `{path,line}`.
- Dates are ISO 8601 strings; hashes are `"sha256:<hex>"`.

## 12. Example

A trimmed but real map of the Lettore project: [examples/lettore.codemap.json](../examples/lettore.codemap.json). It shows a feature that crosses three languages (React `App` → `POST /parse` in the Python sidecar, with the Rust `sidecar_info` command providing the port), a private component kept by the detail rule (`PageView`), an edge lifted from a hidden helper to its file (`/geometry`), a user note, a manual edge (`WS /speak`), and git history from Lettore's real log (4 commits, `changes-with` between `sidecar/main.py` and `src/App.tsx`, feature `ref-m3-8`).

## 13. Decisions (2026-11-26)

| # | Question | Decision |
|---|---|---|
| 1 | Format | **JSON**, portable and shareable. SQLite may be generated from the JSON later. |
| 2 | Symbol depth | Not full detail, but never a partial view: rule in §5.2.1 (structural kinds always, hidden-symbol counts, edges lifted to the file, `detail.full` override). |
| 3 | Sharding threshold | 20,000 nodes or 10 MB. |
| 4 | Feature walk | Distance 2, both directions, hub cut-off. Configurable; revisit after use tests. Target is medium-size codebases. |
| 5 | Hub threshold | Fan-in ≥ 10. |
| 6 | Annotations | `@feature` comments OK, **plus your notes and overrides** in config, which always win (§7.4). |
| 7 | Languages for v1 | **TS/JS, Python and Rust** (enough for Lettore's cross-language links). Swift and C++ follow in a later version, using the same adapters approach (#10). |
| 8 | `calls` edges | No type-aware parser. Syntax-only rule (§6.3); dropped from v1 if noisy. |
| 9 | Location | Central folder outside the repos, `~/Codemaps/<project>/` (§3). |
| 10 | Generator language | Targets include TS/JS, Python, Rust, Swift, C++, not only React. So: one parser family for all, **tree-sitter**, with a small adapter per language (§5.5). Generator in **Node/TypeScript** using `web-tree-sitter` (WASM, no native build), sharing the codemap types with the Tauri viewer. |
| 11 | Git history | Added on request (v1.1): commit subjects and changed files give `history`, `metrics.commits`, `changes-with` edges and commit-based features (§7.5). |

