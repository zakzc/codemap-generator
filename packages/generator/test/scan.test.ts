import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sanitizeRemote } from "../src/discover/git.ts";
import { makeResolver } from "../src/resolve/typescript.ts";
import { scan } from "../src/scan.ts";
import { validateCodemap } from "../src/validate.ts";
import { serialize } from "../src/write.ts";

const fixture = new URL("./fixtures/ts-basic", import.meta.url).pathname;
const tmp = () => mkdtempSync(join(tmpdir(), "codemap-"));
const edge = (doc: any, from: string, to: string) => doc.edges.find((e: any) => e.from === from && e.to === to);

test("ts-basic: nodes, edges, diagnostics, validation", async () => {
  const doc: any = await scan(fixture);
  assert.deepEqual(validateCodemap(doc), []);
  const main = "file:src/main.tsx";
  assert.equal(edge(doc, main, "file:src/App.tsx").count, 2); // `@/App` alias + re-export
  assert.equal(edge(doc, main, "file:src/types.ts").meta.typeOnly, true); // ./types.js → types.ts
  assert.equal(edge(doc, main, "file:src/components/index.ts").meta.names[0], "helper");
  assert.equal(edge(doc, main, "file:src/components/Lazy.ts").meta.dynamic, true);
  assert.ok(edge(doc, main, "file:src/styles.css"));
  assert.ok(edge(doc, main, "ext:npm:@scope/pkg")); // scope kept, subpath dropped
  assert.equal(doc.nodes.find((n: any) => n.id === "ext:npm:react").meta.version, "^18.0.0");
  assert.ok(!doc.edges.some((e: any) => e.to.includes("fs")), "node: built-ins dropped");
  assert.ok(!doc.nodes.some((n: any) => n.path?.includes("node_modules")));
  assert.deepEqual(doc.project.entrypoints, [main]);
  assert.deepEqual(doc.diagnostics.filter((d: any) => d.level !== "info").map((d: any) => d.code), ["unresolved-import"]);
});

test("static assets: importing an image resolves to an asset node", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), 'import logo from "./logo.png";\nexport const l = logo;\n');
  writeFileSync(join(dir, "src/logo.png"), Buffer.from([0x89, 0x50, 0, 0xff]));
  const doc: any = await scan(dir);
  assert.deepEqual(doc.diagnostics.filter((d: any) => d.level !== "info"), []);
  assert.ok(doc.edges.some((e: any) => e.to === "file:src/logo.png"));
  assert.equal(doc.nodes.find((n: any) => n.id === "file:src/logo.png").hash, undefined);
  assert.deepEqual(validateCodemap(doc), []);
});

test("determinism: same input, same bytes", async () => {
  const a: any = await scan(fixture), b: any = await scan(fixture);
  a.generator.generatedAt = b.generator.generatedAt = "x";
  assert.equal(serialize(a), serialize(b));
});

test("git repo: remote credentials stripped, clean tree uses commit time, untracked files not shown", async () => {
  const dir = tmp();
  cpSync(fixture, dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
  git("init", "-q"); git("remote", "add", "origin", "https://user:tok@github.com/me/x.git");
  git("add", "-A"); git("commit", "-qm", "init");
  let doc: any = await scan(dir);
  assert.equal(doc.project.remote, "https://github.com/me/x.git");
  assert.match(doc.project.commit, /^[0-9a-f]+$/);
  const again: any = await scan(dir);
  assert.equal(doc.generator.generatedAt, again.generator.generatedAt);
  writeFileSync(join(dir, "src/new.ts"), "export {}");
  doc = await scan(dir);
  assert.ok(!doc.nodes.some((n: any) => n.id === "file:src/new.ts"));
});

test("safety: symlinks not followed, ignore globs applied, no absolute paths", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "export {}");
  writeFileSync(join(dir, "src/gen.ts"), "// @generated\nexport {}");
  symlinkSync("/etc/hosts", join(dir, "src/link.ts"));
  const doc: any = await scan(dir, { ignore: ["src/gen.ts"] });
  assert.deepEqual(doc.nodes.filter((n: any) => n.kind === "file").map((n: any) => n.id), ["file:src/a.ts"]);
  assert.deepEqual(validateCodemap(doc), []);
});

test("sanitizeRemote", () => {
  assert.equal(sanitizeRemote("https://u:t@host/x.git"), "https://host/x.git");
  assert.equal(sanitizeRemote("git@github.com:me/x.git"), "git@github.com:me/x.git");
  assert.equal(sanitizeRemote("https://[bad"), "");
});

test("resolver: probing, index files, extends chain, queries", () => {
  const files = new Set(["a/b.ts", "a/c/index.tsx", "a/x.css", "a/schema.d.ts", "base/tsconfig.json", "app/tsconfig.json", "base/lib/util.ts"]);
  const text: Record<string, string> = {
    "app/tsconfig.json": '{"extends":"../base/tsconfig.json"}',
    "base/tsconfig.json": '{"compilerOptions":{"baseUrl":"..","paths":{"lib/*":["base/lib/*"]}}}',
  };
  const r = makeResolver({ files, read: (p) => text[p] });
  assert.deepEqual(r("./b", "a/z.ts"), { kind: "file", path: "a/b.ts" });
  assert.deepEqual(r("./c", "a/z.ts"), { kind: "file", path: "a/c/index.tsx" });
  assert.deepEqual(r("./x.css?url", "a/z.ts"), { kind: "file", path: "a/x.css" });
  assert.deepEqual(r("./schema", "a/z.ts"), { kind: "file", path: "a/schema.d.ts" });
  assert.deepEqual(r("./none", "a/z.ts"), { kind: "unresolved" });
  assert.deepEqual(r("lib/util", "app/z.ts"), { kind: "file", path: "base/lib/util.ts" });
  assert.deepEqual(r("node:path", "a/z.ts"), { kind: "drop" });
  assert.deepEqual(r("fs/promises", "a/z.ts"), { kind: "drop" });
  assert.deepEqual(r("@a/b/c", "a/z.ts"), { kind: "external", name: "@a/b" });
});

test("ts-react-redux: symbols, detail rule, React and Redux edges, entry depth", async () => {
  const doc: any = await scan(new URL("./fixtures/ts-react-redux", import.meta.url).pathname);
  assert.deepEqual(validateCodemap(doc), []);
  const node = (id: string) => doc.nodes.find((n: any) => n.id === id);
  const kinds = (ids: Record<string, string>) => Object.entries(ids).map(([id, k]) => assert.equal(node(id)?.kind, k, id));
  kinds({
    "sym:src/App.tsx#App": "component", "sym:src/App.tsx#PageView": "component", "sym:src/Lazy.tsx#Lazy": "component",
    "sym:src/App.tsx#LazyView": "component", "sym:src/hooks.ts#useDoc": "hook",
    "sym:src/store.ts#documentSlice": "store", "sym:src/store.ts#store": "store", "sym:src/api.ts#get": "function",
  });
  // detail rule: private functions are hidden and counted, plain consts are never nodes
  assert.equal(node("sym:src/App.tsx#unusedHelper"), undefined);
  assert.equal(node("sym:src/components/PdfView.tsx#spanRects"), undefined);
  assert.equal(node("file:src/App.tsx").metrics.hiddenSymbols, 1);
  assert.equal(node("sym:src/store.ts#documentSlice").doc, "Holds the loaded document.");
  assert.deepEqual(node("sym:src/store.ts#documentSlice").meta, { framework: "redux", actions: ["clear", "setDoc"], stateKeys: ["documents"] });
  assert.deepEqual(node("sym:src/hooks.ts#useDoc").meta.hooks, ["useAppSelector", "useState"]);

  const app = "sym:src/App.tsx#App";
  const e = (from: string, kind: string, to: string) => doc.edges.find((x: any) => x.from === from && x.kind === kind && x.to === to);
  assert.ok(e("file:src/main.tsx", "renders", app));
  assert.equal(e(app, "renders", "sym:src/components/PdfView.tsx#PdfView")?.confidence, "inferred"); // through a re-export
  assert.equal(e(app, "renders", "sym:src/App.tsx#PageView")?.confidence, undefined); // same file = exact
  assert.equal(e(app, "renders", "sym:src/Settings.tsx#Settings").meta.conditional, true);
  assert.ok(e("sym:src/App.tsx#LazyView", "renders", "sym:src/Lazy.tsx#Lazy"));
  assert.ok(e(app, "uses", "sym:src/hooks.ts#useDoc"));
  assert.ok(e("sym:src/hooks.ts#useDoc", "uses", "ext:npm:react"));
  assert.ok(e(app, "writes", "sym:src/store.ts#documentSlice")); // dispatch(setDoc(…)) through the alias
  assert.ok(e("sym:src/hooks.ts#useDoc", "reads", "sym:src/store.ts#documentSlice")); // s => s.documents.pages
  assert.ok(e("file:src/components/PdfView.tsx", "calls", "sym:src/api.ts#get"), "edge from a hidden helper lifts to its file");

  assert.ok(e("sym:src/Footer.tsx#Footer", "writes", "sym:src/store.ts#documentSlice")); // dispatch(doc.clear()) with `doc = slice.actions`

  const depth = (id: string) => node(id).meta.entryDepth;
  assert.equal(depth(app), 0);
  assert.equal(depth("sym:src/components/PdfView.tsx#PdfView"), 1);
  assert.equal(depth("sym:src/Orphan.tsx#Orphan"), -1);
  assert.equal(node("sym:src/Settings.tsx#Settings").meta.conditional, true);
});

test("detail.full keeps private symbols", async () => {
  const doc: any = await scan(new URL("./fixtures/ts-react-redux", import.meta.url).pathname, { detail: { full: ["**"] } });
  assert.ok(doc.nodes.some((n: any) => n.id === "sym:src/App.tsx#unusedHelper"));
});

test("python-fastapi: adapter, resolver, FastAPI/Flask endpoints", async () => {
  const doc: any = await scan(new URL("./fixtures/python-fastapi", import.meta.url).pathname);
  assert.deepEqual(validateCodemap(doc), []);
  const node = (id: string) => doc.nodes.find((n: any) => n.id === id);
  const edge = (from: string, kind: string, to: string) => doc.edges.find((x: any) => x.from === from && x.kind === kind && x.to === to);

  // endpoints: prefixes through include_router / APIRouter / Blueprint, auth from Depends, Flask methods
  const eps = doc.nodes.filter((n: any) => n.kind === "endpoint").map((n: any) => n.name);
  assert.deepEqual(eps, ["GET /", "GET /api/v2/items/{id}", "GET /health", "POST /bp/x", "POST /parse", "PUT /bp/x", "WS /speak"]);
  assert.deepEqual(node("endpoint:GET /health").meta, { method: "GET", path: "/health", framework: "fastapi", auth: true });
  assert.equal(node("endpoint:GET /api/v2/items/{id}").meta.auth, true);
  assert.equal(node("endpoint:GET /health").doc, "Liveness probe.");
  assert.equal(node("endpoint:POST /parse").meta.auth, undefined);
  assert.equal(node("endpoint:PUT /bp/x").meta.framework, "flask");
  assert.equal(node("endpoint:POST /parse").parent, "file:sidecar/main.py");

  // symbols, detail rule, entry
  assert.equal(node("sym:sidecar/parse.py#parse_pdf").kind, "function");
  assert.equal(node("sym:sidecar/main.py#_ping"), undefined);
  assert.equal(node("file:sidecar/main.py").metrics.hiddenSymbols, 1);
  assert.ok(node("file:sidecar/main.py").tags.includes("entry"));
  assert.equal(node("sym:sidecar/main.py#check_token").kind, "function");

  // imports: alias table, requirements, stdlib dropped, relative + submodule + re-export
  assert.ok(edge("file:sidecar/main.py", "imports", "ext:pip:pymupdf"), "fitz → pymupdf");
  assert.ok(edge("file:sidecar/main.py", "imports", "ext:pip:fastapi"));
  assert.ok(edge("file:sidecar/main.py", "imports", "ext:pip:uvicorn"));
  assert.ok(!doc.nodes.some((n: any) => n.id === "ext:pip:os"));
  assert.ok(edge("file:sidecar/main.py", "imports", "file:sidecar/parse.py"));
  assert.ok(edge("file:sidecar/main.py", "imports", "file:sidecar/pkg/__init__.py"));
  assert.ok(edge("file:sidecar/pkg/other.py", "imports", "file:sidecar/chunker.py"), "from .. import chunker");
  assert.ok(edge("file:sidecar/pkg/other.py", "imports", "file:sidecar/pkg/inner.py"), "from . import inner");
  assert.deepEqual(doc.diagnostics.filter((d: any) => d.level !== "info").map((d: any) => `${d.code} ${d.path}:${d.line}`), ["unresolved-import sidecar/pkg/other.py:3"]);
  assert.equal(node("ext:pip:fastapi").meta.ecosystem, "pip");

  // calls: through an import, through a package re-export, from a hidden helper lifted to its file
  assert.equal(edge("endpoint:POST /parse", "calls", "sym:sidecar/parse.py#parse_pdf").confidence, "inferred");
  assert.ok(edge("file:sidecar/main.py", "calls", "sym:sidecar/pkg/inner.py#thing"), "_ping → thing via pkg/__init__ re-export, lifted to the file");
  assert.ok(edge("sym:sidecar/parse.py#parse_pdf", "calls", "sym:sidecar/chunker.py#chunk"));
});

test("features: auto features, annotations, walk roles", async () => {
  const doc: any = await scan(new URL("./fixtures/ts-react-redux", import.meta.url).pathname);
  const feature = (id: string) => doc.features.find((f: any) => f.id === id);
  const slice = feature("feature:store-documentslice");
  assert.equal(slice.source, "store");
  const member = (f: any, id: string) => f.members.find((m: any) => m.node === id);
  assert.deepEqual([member(slice, "sym:src/store.ts#documentSlice").role, member(slice, "sym:src/store.ts#documentSlice").distance], ["core", 0]);
  assert.equal(member(slice, "sym:src/App.tsx#App").distance, 1); // App writes the slice
  const note = feature("feature:footer-actions"); // `// @feature footer-actions` above Footer
  assert.equal(note.source, "annotation");
  assert.deepEqual(note.seeds, ["sym:src/Footer.tsx#Footer"]);
  assert.deepEqual(doc.tools.find((t: any) => t.category === "state").nodes, ["ext:npm:@reduxjs/toolkit", "ext:npm:react-redux"]);
  assert.equal(doc.nodes.find((n: any) => n.id === "ext:npm:react").meta.category, "ui");
});

test("overrides: notes, manual edges, include/exclude/roles, tools, stale ids", async () => {
  const repo = new URL("./fixtures/ts-react-redux", import.meta.url).pathname;
  const doc: any = await scan(repo, {
    notes: { "file:src/api.ts": "All HTTP goes through get().", "file:gone.ts": "stale" },
    edges: [{ from: "sym:src/App.tsx#App", to: "sym:src/api.ts#get", kind: "requests", note: "dynamic URL" }, { from: "file:nope", to: "file:src/api.ts", kind: "calls" }],
    features: [{ id: "feature:store-documentslice", name: "Doc", seeds: ["sym:src/store.ts#documentSlice"], include: ["file:src/api.ts", "file:missing"], exclude: ["sym:src/App.tsx#App"], roles: { "sym:src/store.ts#documentSlice": "support" } }],
    tools: { react: "other" },
  } as any);
  assert.equal(doc.nodes.find((n: any) => n.id === "file:src/api.ts").note, "All HTTP goes through get().");
  assert.deepEqual(doc.edges.find((e: any) => e.kind === "requests"), { from: "sym:src/App.tsx#App", to: "sym:src/api.ts#get", kind: "requests", confidence: "manual", meta: { note: "dynamic URL" } });
  const f = doc.features.find((x: any) => x.id === "feature:store-documentslice");
  assert.ok(!f.members.some((m: any) => m.node === "sym:src/App.tsx#App"), "exclude removes a member");
  assert.equal(f.members.find((m: any) => m.node === "file:src/api.ts").origin, "user");
  assert.deepEqual(f.members.find((m: any) => m.node === "sym:src/store.ts#documentSlice"), { node: "sym:src/store.ts#documentSlice", role: "support", distance: 0, origin: "user" });
  assert.equal(doc.nodes.find((n: any) => n.id === "ext:npm:react").meta.category, "other");
  assert.deepEqual(doc.diagnostics.filter((d: any) => d.code === "stale-override").map((d: any) => d.message).sort(),
    ["edge: file:nope does not exist", "feature feature:store-documentslice include: file:missing does not exist", "note: file:gone.ts does not exist"]);
  assert.deepEqual(validateCodemap(doc), []);
});

test("history: renames, bulk, co-change, grouping, no author data", async () => {
  const dir = tmp();
  let t = Date.parse("2026-01-01T00:00:00Z"); // distinct commit dates, so the newest-first order is unambiguous
  const git = (...a: string[]) => {
    const date = new Date((t += 60_000)).toISOString();
    execFileSync("git", ["-C", dir, "-c", "user.name=Secret Person", "-c", "user.email=secret@example.com", ...a], { stdio: "ignore", env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  };
  const commit = (msg: string, files: Record<string, string>) => { for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, ".."), { recursive: true }); writeFileSync(join(dir, f), c); } git("add", "-A"); git("commit", "-qm", msg); };
  git("init", "-q");
  commit("feat(player): add a and b", { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n", "README.md": "x" });
  commit("fix #12: tweak", { "src/a.ts": "export const a = 2;\n", "src/b.ts": "export const b = 2;\n" });
  commit("feat(player): third", { "src/a.ts": "export const a = 3;\n", "src/b.ts": "export const b = 3;\n" });
  commit("docs only", { "README.md": "y" });
  git("mv", "src/b.ts", "src/bb.ts"); git("commit", "-qm", "rename b");
  commit("pdf work", { "src/bb.ts": "export const b = 4;\n" });
  commit("Format everything", { "src/a.ts": "export const a = 4;\n", "src/bb.ts": "export const b = 5;\n", "src/c.ts": "export {};\n", "src/d.ts": "export {};\n" });

  const cfg = { history: { bulkFiles: 3 }, features: [{ id: "feature:pdf", name: "PDF", keywords: ["pdf"] }] } as any;
  const doc: any = await scan(dir, cfg);
  assert.deepEqual(validateCodemap(doc), []);
  assert.deepEqual(doc.history.commits.map((c: any) => c.subject), ["Format everything", "pdf work", "rename b", "feat(player): third", "fix #12: tweak", "feat(player): add a and b"], "docs-only commit dropped, newest first");
  assert.equal(doc.history.commits[0].bulk, true);
  assert.ok(doc.history.commits.slice(1).every((c: any) => !c.files.some((f: string) => f.endsWith("README.md"))));
  assert.ok(doc.history.commits.at(-1).files.includes("file:src/bb.ts"), "old commits count for the file under its current name");

  const a = doc.nodes.find((n: any) => n.id === "file:src/a.ts");
  assert.equal(a.metrics.commits, 4); // includes the bulk commit
  assert.equal(a.meta.lastChanged, doc.history.commits[0].date);
  const cw = doc.edges.filter((e: any) => e.kind === "changes-with");
  assert.deepEqual(cw, [{ from: "file:src/a.ts", to: "file:src/bb.ts", kind: "changes-with", confidence: "heuristic", count: 3 }]); // bulk commit not counted, c.ts / d.ts never reach the threshold

  const f = (id: string) => doc.features.find((x: any) => x.id === id);
  assert.equal(f("feature:scope-player").commits.length, 2);
  assert.deepEqual(f("feature:scope-player").members.map((m: any) => [m.node, m.role, m.origin, m.commits]), [["file:src/a.ts", "core", "history", 2], ["file:src/bb.ts", "core", "history", 2]]);
  assert.equal(f("feature:ref-12").source, "history");
  assert.equal(f("feature:ref-12").description, "fix #12: tweak");
  assert.equal(f("feature:pdf").source, "config");
  assert.equal(f("feature:pdf").commits.length, 1);
  assert.ok(!f("feature:scope-player").commits.includes(doc.history.commits[0].hash));

  const text = serialize(doc);
  assert.ok(!/Secret|secret@example/.test(text), "no author data");
  assert.equal(serialize(await scan(dir, cfg)).replace(/"generatedAt".*/, ""), text.replace(/"generatedAt".*/, ""), "same HEAD → same bytes");
  assert.equal(((await scan(dir, cfg, { history: false })) as any).history, undefined);
});
