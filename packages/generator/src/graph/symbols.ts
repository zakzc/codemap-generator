import { matchesGlob } from "node:path";
import { classifyReact, isHookName, type Classified } from "../detect/react.ts";
import { findEndpoints, type Endpoint } from "../detect/fastapi.ts";
import { classifyRedux, isSelectorHook } from "../detect/redux.ts";
import type { Resolved } from "../resolve/typescript.ts";
import type { Decl, Edge, FileFacts, Node } from "../types.ts";

type Sym = { id: string; file: string; decl: Decl; cls: Classified; emitted: boolean };
type Hit = { file: string; decl: Decl; exact: boolean };
type Acc = Edge & { count: number; cond: boolean };

const STRUCTURAL = new Set(["component", "hook", "store", "class", "endpoint"]);
const endpointId = (e: Endpoint) => `endpoint:${e.method} ${e.path}`;
const classifyPython = (d: Decl): Classified | undefined =>
  d.kind === "function" ? { kind: "function", meta: {} }
  : d.kind === "class" ? { kind: "class", meta: { declaredAs: "class", ...(d.methods && { methods: d.methods }) } } : undefined;
const isTest = (p: string) => /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\/|(^|\/)(test_[^/]*|[^/]*_test)\.py$|(^|\/)tests\//.test(p);
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && !v.length)));

type Input = {
  facts: FileFacts[]; resolve: (spec: string, from: string) => Resolved;
  fullGlobs: string[];
};

/**
 * Symbol nodes and the edges between them (Spec 1 §4.4–4.6): names resolve to a same-file top-level decl, else to the
 * symbol they were imported as (one level of re-export). Symbols dropped by the detail rule lift their edges to the file.
 */
export function buildSymbols({ facts, resolve, fullGlobs }: Input) {
  const byPath = new Map(facts.map((f) => [f.path, f]));
  const declsOf = new Map(facts.map((f) => [f.path, new Map(f.decls.map((d) => [d.name, d]))]));
  const targetFile = (spec: string, from: string) => { const r = resolve(spec, from); return r.kind === "file" && byPath.has(r.path) ? r.path : undefined; };

  // --- names → symbols
  const bindings = new Map(facts.map((f) => [f.path, new Map(f.imports.filter((i) => !i.reexport).flatMap((i) => (i.bindings ?? []).map((b) => [b.local, { spec: i.spec, imported: b.imported }] as const)))]));
  function lookupExport(file: string, name: string, depth = 0): { file: string; decl: Decl } | undefined {
    const f = byPath.get(file);
    if (!f) return;
    const n = name === "default" ? f.defaultExport : name;
    const d = n ? declsOf.get(file)?.get(n) : undefined;
    if (d && (d.exported || name === "default")) return { file, decl: d };
    if (depth < 2)
      for (const imp of f.imports) {
        if (!(imp.reexport || file.endsWith("__init__.py")) || !(imp.names.includes(name) || imp.names.includes("*"))) continue;
        const t = targetFile(imp.spec, file);
        const hit = t && lookupExport(t, name, depth + 1);
        if (hit) return hit;
      }
  }
  function resolveName(file: string, name: string): Hit | undefined {
    const own = declsOf.get(file)?.get(name);
    if (own) return { file, decl: own, exact: true };
    const b = bindings.get(file)?.get(name);
    if (!b || b.imported === "*") return;
    const t = targetFile(b.spec, file);
    const hit = t && lookupExport(t, b.imported);
    return hit ? { ...hit, exact: false } : undefined;
  }
  const externalOf = (file: string, name: string) => {
    const b = bindings.get(file)?.get(name);
    const r = b && resolve(b.spec, file);
    return r?.kind === "external" ? `ext:npm:${r.name}` : undefined;
  };

  // --- symbol table
  const endpoints = findEndpoints(facts, resolveName);
  const syms = new Map<string, Sym>();
  for (const f of facts) for (const d of f.decls) {
    if (d.kind === "alias") continue;
    const key = `sym:${f.path}#${d.name}`;
    const route = endpoints.get(`${f.path}#${d.name}`)?.[0];
    if (route) { // a routed function is the endpoint node (Spec 2 §5.2)
      syms.set(key, { id: endpointId(route), file: f.path, decl: d, cls: { kind: "endpoint", meta: { method: route.method, path: route.path, framework: route.framework, ...(route.auth && { auth: true }) } }, emitted: true });
      continue;
    }
    const cls = f.lang === "python" ? classifyPython(d) : classifyRedux(d) ?? classifyReact(d, f);
    if (!cls) continue;
    const full = fullGlobs.some((g) => matchesGlob(f.path, g));
    syms.set(key, { id: key, file: f.path, decl: d, cls, emitted: STRUCTURAL.has(cls.kind) || d.exported || isTest(f.path) || full });
  }
  const symFor = (file: string, name: string) => syms.get(`sym:${file}#${name}`);
  const end = (s: Sym | string): string => (typeof s === "string" ? s : s.emitted ? s.id : `file:${s.file}`);
  const from = (file: string, decl?: string) => { const s = decl ? symFor(file, decl) : undefined; return s ? end(s) : `file:${file}`; };

  // --- Redux: state key → slice, and actions → slice
  const sliceByKey = new Map<string, Sym>();
  for (const f of facts) for (const d of f.decls) {
    if (d.init?.callee !== "configureStore") continue;
    for (const [key, a] of Object.entries(d.init.args[0]?.props?.reducer?.props ?? {})) {
      const hit = a.value ? resolveName(f.path, a.value.split(".")[0]!) : undefined;
      const s = hit && symFor(hit.file, hit.decl.name);
      if (s?.cls.kind === "store") {
        sliceByKey.set(key, s);
        s.cls.meta.stateKeys = [...new Set([...((s.cls.meta.stateKeys as string[]) ?? []), key])].sort();
      }
    }
  }
  const storeOfAction = (file: string, callee: string): Sym | undefined => {
    const [head, second] = callee.split(".");
    const hit = resolveName(file, head!);
    if (!hit) return;
    if (second === "actions") { const s = symFor(hit.file, hit.decl.name); return s?.cls.kind === "store" ? s : undefined; }
    if (hit.decl.kind !== "alias") return;
    const base = hit.decl.target?.split(".")[0];
    const r = base ? resolveName(hit.file, base) : undefined;
    const s = r && symFor(r.file, r.decl.name);
    return s?.cls.kind === "store" ? s : undefined;
  };

  // --- edges
  const acc = new Map<string, Acc>();
  const add = (src: string, dst: string, kind: string, exact: boolean, path: string, line: number, cond = false) => {
    if (src === dst) return;
    const key = `${src}\0${kind}\0${dst}`;
    const e = acc.get(key) ?? { from: src, to: dst, kind, count: 0, at: [], cond: true, ...(!exact && { confidence: "inferred" }) };
    e.count++; e.at!.push({ path, line }); e.cond &&= cond;
    acc.set(key, e);
  };

  for (const f of facts) {
    for (const j of f.jsx) {
      if (!/^[A-Z]/.test(j.name) || j.name.includes(".")) continue;
      const hit = resolveName(f.path, j.name);
      const s = hit && symFor(hit.file, hit.decl.name);
      if (s?.cls.kind === "component") add(from(f.path, j.inDecl), end(s), "renders", hit!.exact, f.path, j.line, j.conditional);
    }
    for (const c of f.calls) {
      const src = from(f.path, c.inDecl);
      if (c.callee === "dispatch" || c.callee.endsWith(".dispatch")) {
        const a = c.args[0];
        const store = a?.kind === "call" && a.value ? storeOfAction(f.path, a.value) : undefined;
        if (store) add(src, end(store), "writes", false, f.path, c.line);
      }
      if (isSelectorHook(c.callee) && c.args[0]?.kind === "fn" && c.args[0].value) {
        const store = sliceByKey.get(c.args[0].value);
        if (store) add(src, end(store), "reads", false, f.path, c.line);
      }
      if (c.callee.includes(".")) continue; // method calls are skipped (Spec 2 §6.3)
      const hit = resolveName(f.path, c.callee);
      const s = hit && symFor(hit.file, hit.decl.name);
      if (s?.cls.kind === "hook") add(src, end(s), "uses", hit!.exact, f.path, c.line);
      else if (s?.cls.kind === "function") add(src, end(s), "calls", hit!.exact, f.path, c.line);
      else if (!hit && isHookName(c.callee)) { const ext = externalOf(f.path, c.callee); if (ext) add(src, ext, "uses", false, f.path, c.line); }
    }
    for (const d of f.decls) { // React.lazy(() => import("./X")) renders X's default export
      const spec = d.init?.lazy, t = spec && targetFile(spec, f.path), hit = t ? lookupExport(t, "default") : undefined;
      const s = hit && symFor(hit.file, hit.decl.name);
      if (s?.cls.kind === "component") add(end(symFor(f.path, d.name) ?? `file:${f.path}`), end(s), "renders", false, f.path, d.range.start);
    }
  }

  // --- conditional rendering
  const renders = [...acc.values()].filter((e) => e.kind === "renders");
  for (const s of syms.values()) {
    if (s.cls.kind !== "component") continue;
    const incoming = renders.filter((e) => e.to === s.id);
    if (incoming.length && incoming.every((e) => e.cond)) s.cls.meta.conditional = true;
  }

  // --- output
  const hidden = new Map<string, number>();
  const nodes: Node[] = [];
  for (const s of syms.values()) {
    if (!s.emitted) { hidden.set(s.file, (hidden.get(s.file) ?? 0) + 1); continue; }
    const meta = clean(s.cls.meta);
    const isEndpoint = s.cls.kind === "endpoint";
    if (isEndpoint && nodes.some((n) => n.id === s.id)) continue; // same route declared twice: first wins
    nodes.push({
      id: s.id, kind: s.cls.kind, name: isEndpoint ? s.id.slice(9) : s.decl.name, parent: `file:${s.file}`, path: s.file,
      range: s.decl.range, ...(s.decl.exported && !isEndpoint && { exported: true }),
      ...(s.decl.doc && { doc: s.decl.doc }), ...(Object.keys(meta).length && { meta }),
    });
    if (isEndpoint) // further routes on the same function become their own endpoint nodes
      for (const e of endpoints.get(`${s.file}#${s.decl.name}`)!.slice(1))
        if (!nodes.some((n) => n.id === endpointId(e)))
          nodes.push({ id: endpointId(e), kind: "endpoint", name: endpointId(e).slice(9), parent: `file:${s.file}`, path: s.file, range: s.decl.range, meta: clean({ method: e.method, path: e.path, framework: e.framework, auth: e.auth }) });
  }
  const edges: Edge[] = [...acc.values()].map(({ cond, count, at, ...e }) => ({
    ...e, ...(count > 1 && { count }),
    at: at!.sort((a, b) => (`${a.path}\0${String(a.line).padStart(8, "0")}` < `${b.path}\0${String(b.line).padStart(8, "0")}` ? -1 : 1)).slice(0, 1),
    ...(e.kind === "renders" && cond && { meta: { conditional: true } }),
  }));
  return { nodes, edges, hidden };
}
