# Codemap

Codemap reads a code repository **without running any of its code** and writes one portable JSON file, `map-<repo-name>.json`, that answers:

- What is inside what: packages → folders → files → components, hooks, functions, endpoints.
- Who imports, renders, calls, reads or writes what.
- Which libraries are used, grouped by purpose (state, http-server, ui…).
- Which files to open to work on a feature, and which files usually change together (from git history).

There is no AI in the pipeline: the same repo state gives byte-identical output, so the file diffs cleanly in git. Your own notes and overrides are merged in and always win.

Status: the **generator** is implemented (milestones M1–M3, M5, M6; M4 skipped). The **viewer** (Spec 3) is not built yet.

---

## 1. Installation

You do this once.

**Requirements**

| Need | Why |
|---|---|
| Node.js **22.18 or newer** (developed on 26) | Runs the TypeScript sources directly, no build step |
| git on your `PATH` | File listing and history. Repos without git also work, without history |

**Steps**

```bash
cd packages/generator
npm install          # installs the dependencies
npm test             # optional: runs the test suite (18 tests, about 3 s)
npm link             # optional: installs the `codemap` command globally
```

`npm link` is what lets you type `codemap <repo>` from any folder. Without it, use the npm script described in section 2.

---

## 2. Execution

You do this every time you want a codemap.

### Quick start

```bash
codemap /path/to/your/repo
```

or, without `npm link`, from the project root:

```bash
npm run codemap /path/to/your/repo
```

Either way the result is written to `maps/<repo-name>/map-<repo-name>.json`, and a summary line is printed:

```
lettore: 122 nodes, 163 edges, 0 warnings, 0.3 s
```

Run it again whenever the code changes. Runs are incremental: unchanged files are not re-parsed (a 1,500-file repo takes about 0.6 s cold and 0.2 s warm).

### Commands

| Command | What it does |
|---|---|
| `codemap <repo>` | Shorthand for `codemap scan <repo>` |
| `codemap scan <repo>` | Generates or refreshes the codemap |
| `codemap check <codemap.json>` | Validates a codemap: JSON Schema plus the integrity rules of Spec 2 §10. Also checks every shard of a sharded codemap |
| `codemap init <repo>` | Writes a starter `codemap.config.json` (project name, detected entrypoints) and lists the automatic features it found, so you can copy the ones you want. Never overwrites an existing config |

### Options (for `scan`)

| Option | Effect |
|---|---|
| `--out <dir>` | Write somewhere other than `maps/<repo-name>/` |
| `--full` | Emit every symbol, including private ones (same as `detail.full: ["**"]`) |
| `--no-cache` | Ignore the parse cache |
| `--no-history` | Skip the git history step |
| `--quiet` | Do not print the first 10 warnings |

With the npm script, put options after `--`:

```bash
npm run codemap ../my-repo -- --out ./out --full
```

### What you get

```
maps/<repo-name>/
  map-<repo-name>.json   generated (e.g. map-news-hub.json); a manifest when the codemap is large
  shards/                generated, only above 20,000 nodes or 10 MB
  codemap.config.json    yours: features, notes, manual edges, overrides
  .cache/                generated: parse and history cache (do not copy or share)
```

The folder lives outside your repos and is self-contained: copy it (without `.cache/`) to another machine and a viewer can open it. Nothing is ever written inside the analysed repo.

### Your config file

`codemap.config.json` sits next to the codemap and is read on every run. It is plain JSON, validated against [docs/schema/codemap.config.schema.json](docs/schema/codemap.config.schema.json); a complete example is [docs/examples/lettore.codemap.config.json](docs/examples/lettore.codemap.config.json).

| Key | Purpose |
|---|---|
| `project` | Display name |
| `ignore` | Extra globs to skip |
| `entrypoints` | Extra entry files (`file:src/main.tsx`) |
| `features` | Your features: `seeds`, `keywords`, `include`, `exclude`, `roles`, `description` |
| `notes` | Node id → your note |
| `edges` | Manual edges for links the scanner cannot see |
| `tools` | Package → category |
| `detail.full` | Paths where every symbol is emitted |
| `hubFanIn`, `featureDistance` | Hub threshold (10) and feature walk depth (2) |
| `history` | `enabled`, `maxCommits` (100), `bulkFiles` (50), `refPatterns` |

An id in the config that no longer exists produces a `stale-override` warning; the override is skipped but stays in your file.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success (warnings allowed) |
| `1` | The output failed validation. The previous codemap is left untouched and the rejected one is written to `map-<repo-name>.invalid.json` |
| `2` | Bad arguments or unreadable repo |

---

## 3. Overview

### What it understands

| | |
|---|---|
| **Languages** | TypeScript / JavaScript (incl. JSX/TSX) and Python are parsed. Rust files appear as file nodes only (no symbols or imports yet) |
| **Frameworks** | React (components, hooks, `renders`), Redux Toolkit (slices, `reads`, `writes`), FastAPI and Flask (endpoints with prefixes and auth) |
| **Packages** | `package.json`, `Cargo.toml`, `pyproject.toml`, `requirements*.txt`, `setup.cfg` |
| **Git history** | Last 100 commits (subjects and changed files only, no authors): which commits touched which files, files that change together, features grouped by scope (`feat(player): …`), reference (`#12`, `ABC-45`) or your keywords |

Every edge carries a confidence (`exact`, `inferred`, `heuristic`, `manual`), so a viewer can draw uncertain links differently.

### How it works

```
discover → parse (cached, parallel) → resolve → detect frameworks → build graph
        → detail rule → git history → features → your overrides → tools → metrics
        → rollups / shards → validate → atomic write
```

- **Tree-sitter** (WASM, no native build) parses each file; adapters never look at other files.
- A **detail rule** keeps the map readable without ever hiding a file: private helpers are not nodes, but their count is stored and their connections are attached to their file.
- **Features** are rule-based: seeds (your config, `@feature name` comments, one per endpoint/store/route) are expanded a few steps over imports, renders, calls, reads and writes; heavily imported "hub" files are marked shared instead of swallowing everything.
- Output is validated before it replaces the previous codemap, and written atomically.

### Safety

The scanner never executes repo code, never writes inside the repo, strips credentials from the git remote, reads no author names or emails, follows no symlinks, and keeps every path repo-relative.

### Known limits

- **Request matching is not built**: `fetch(...)` / `invoke(...)` calls are not yet linked to the endpoints or commands they hit, so features do not cross from a TypeScript client into a Python server. (Part of milestone M4.)
- **Rust, Tauri and axum** are not analysed (M4 skipped).
- Swift and C++ are planned for a later version.
- Method calls (`obj.m()`), CommonJS `module.exports` and Python declarations nested in `if`/`try` blocks are not tracked.

### Repository layout

```
specs/       Spec 1 (generator) and Spec 2 (codemap format); Spec 3 (viewer) is a draft kept elsewhere
docs/        JSON Schemas, the integrity checker, a worked example of a codemap and of a config
packages/
  generator/ the CLI: src/ (discover, parse, lang, resolve, detect, graph, history), registry/tools.json, test/
progress.md  what is done, in progress and to do, milestone by milestone
```

| Document | Read it for |
|---|---|
| [specs/spec-1-generator.md](specs/spec-1-generator.md) | How the generator works and its decisions |
| [specs/spec-2-codemap-schema.md](specs/spec-2-codemap-schema.md) | The `codemap.json` format |
| [progress.md](progress.md) | Milestones and current status |

### Development

```bash
cd packages/generator
npm test                 # all tests
npx tsc -p .             # type check
node src/cli.ts scan <repo> --out /tmp/out
```

Tests cover each language adapter, the resolvers, framework detection, features, git history (scripted repos), overrides, incremental runs, sharding, determinism, safety and a generated 1,500-file performance fixture.
