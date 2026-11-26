import type { Node as TsNode } from "web-tree-sitter";
import type { ArgFact, Decl, FileFacts } from "../types.ts";
import { annotationsOf } from "./typescript.ts";

const DOTTED = /^[\w$]+(\.[\w$]+)*$/;
type Facts = Pick<FileFacts, "imports" | "decls" | "calls" | "jsx" | "errors" | "entry" | "annotations">;

function pyString(n: TsNode): { value: string; template: boolean } {
  const m = n.text.match(/^([a-zA-Z]*)("""|'''|"|')([\s\S]*)$/);
  const body = m ? m[3]!.slice(0, m[3]!.length - m[2]!.length) : n.text;
  return { value: body, template: /f/i.test(m?.[1] ?? "") };
}

function argFact(n: TsNode, depth = 0): ArgFact {
  switch (n.type) {
    case "string": { const s = pyString(n); return { kind: s.template ? "template" : "string", value: s.value }; }
    case "identifier": return { kind: "id", value: n.text };
    case "attribute": return DOTTED.test(n.text) ? { kind: "id", value: n.text } : { kind: "other" };
    case "call": { const f = n.childForFieldName("function")?.text ?? ""; return DOTTED.test(f) ? { kind: "call", value: f } : { kind: "other" }; }
    case "list": case "tuple": return depth > 2 ? { kind: "list" } : { kind: "list", items: n.namedChildren.filter((c): c is TsNode => !!c).map((c) => argFact(c, depth + 1)) };
    case "lambda": return { kind: "fn" };
    default: return { kind: "other" };
  }
}

function callArgs(call: TsNode): { args: ArgFact[]; kwargs?: Record<string, ArgFact> } {
  const args: ArgFact[] = [];
  const kwargs: Record<string, ArgFact> = {};
  for (const a of call.childForFieldName("arguments")?.namedChildren ?? []) {
    if (!a || a.type === "comment") continue;
    if (a.type === "keyword_argument") { const k = a.childForFieldName("name")?.text, v = a.childForFieldName("value"); if (k && v) kwargs[k] = argFact(v); }
    else if (args.length < 2) args.push(argFact(a));
  }
  return { args, ...(Object.keys(kwargs).length && { kwargs }) };
}

function docOf(def: TsNode): string | undefined {
  const first = def.childForFieldName("body")?.namedChild(0);
  const s = first?.type === "expression_statement" && first.namedChild(0)?.type === "string" ? first.namedChild(0) : undefined;
  if (!s) return;
  const para = pyString(s).value.trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").trim();
  return para ? para.slice(0, 300) : undefined;
}

const paramNames = (def: TsNode) =>
  (def.childForFieldName("parameters")?.namedChildren ?? []).flatMap((p) => {
    if (!p || p.type === "comment") return [];
    const n = p.type === "identifier" ? p : p.childForFieldName("name") ?? p.namedChild(0);
    return n ? [n.text] : [];
  });

/** Imports, top-level decls (functions, classes, call-initialised names), decorators, calls (Spec 1 §4.3, §5). */
export function pythonFacts(root: TsNode): Facts {
  const imports: FileFacts["imports"] = [];
  const decls: Decl[] = [];
  const spans: { name: string; s: number; e: number }[] = [];
  let all: Set<string> | undefined;
  let entry = false;
  const range = (n: TsNode) => ({ start: n.startPosition.row + 1, end: n.endPosition.row + 1 });
  const add = (d: Decl, outer: TsNode) => {
    if (decls.some((x) => x.name === d.name)) return;
    decls.push(d);
    spans.push({ name: d.name, s: outer.startIndex, e: outer.endIndex });
  };

  for (const top of root.namedChildren) {
    if (!top) continue;
    const line = top.startPosition.row + 1;
    if (top.type === "import_statement") {
      for (const n of top.childrenForFieldName("name")) {
        if (!n) continue;
        const mod = n.type === "aliased_import" ? n.childForFieldName("name")!.text : n.text;
        const local = n.type === "aliased_import" ? n.childForFieldName("alias")!.text : mod.split(".")[0]!;
        imports.push({ spec: mod, names: [], line, bindings: [{ local, imported: "*" }] });
      }
    } else if (top.type === "import_from_statement") {
      const mod = top.childForFieldName("module_name")?.text;
      if (mod === undefined) continue;
      const bindings: { local: string; imported: string }[] = [];
      for (const n of top.childrenForFieldName("name")) {
        if (!n) continue;
        if (n.type === "aliased_import") bindings.push({ local: n.childForFieldName("alias")!.text, imported: n.childForFieldName("name")!.text });
        else bindings.push({ local: n.text, imported: n.text });
      }
      if (top.namedChildren.some((c) => c?.type === "wildcard_import")) bindings.push({ local: "*", imported: "*" });
      imports.push({ spec: mod, names: bindings.map((b) => b.imported), line, bindings });
    } else if (top.type === "function_definition" || top.type === "class_definition" || top.type === "decorated_definition") {
      const def = top.type === "decorated_definition" ? top.childForFieldName("definition") : top;
      if (!def) continue;
      const name = def.childForFieldName("name")?.text;
      if (!name) continue;
      const decorators = top.type === "decorated_definition"
        ? top.namedChildren.filter((c) => c?.type === "decorator").map((d) => {
            const e = d!.namedChild(0);
            if (e?.type === "call") return { callee: e.childForFieldName("function")?.text ?? "", ...callArgs(e) };
            return { callee: e?.text ?? "", args: [] };
          })
        : [];
      const depends = [...(top.type === "decorated_definition" ? top.text.slice(0, def.startIndex - top.startIndex) : "").matchAll(/Depends\(\s*([\w.]+)/g), ...(def.childForFieldName("parameters")?.text.matchAll(/Depends\(\s*([\w.]+)/g) ?? [])].map((m) => m[1]!);
      const doc = docOf(def);
      const base = { name, range: range(top), exported: !name.startsWith("_"), ...(doc && { doc }), ...(decorators.length && { decorators }), ...(depends.length && { depends }) };
      if (def.type === "function_definition")
        add({ ...base, kind: "function", params: paramNames(def), ...(def.children.some((c) => c?.type === "async") && { async: true }) }, top);
      else {
        const methods = def.childForFieldName("body")?.namedChildren.flatMap((c) => {
          const f = c?.type === "decorated_definition" ? c.childForFieldName("definition") : c;
          return f?.type === "function_definition" ? [f.childForFieldName("name")!.text] : [];
        }) ?? [];
        const ext = def.childForFieldName("superclasses")?.namedChildren.find((c) => c && c.type !== "keyword_argument")?.text;
        add({ ...base, kind: "class", declaredAs: "class", ...(ext && { extends: ext }), ...(methods.length && { methods }) }, top);
      }
    } else if (top.type === "expression_statement") {
      const a = top.namedChild(0);
      if (a?.type !== "assignment") continue;
      const left = a.childForFieldName("left"), right = a.childForFieldName("right");
      if (left?.type !== "identifier" || !right) continue;
      if (left.text === "__all__" && right.type === "list") all = new Set(right.namedChildren.flatMap((c) => (c?.type === "string" ? [pyString(c).value] : [])));
      else if (right.type === "call") {
        const callee = right.childForFieldName("function")?.text ?? "";
        add({ name: left.text, kind: "const", range: range(top), exported: !left.text.startsWith("_"), init: { callee, ...callArgs(right) } }, top);
      }
    } else if (top.type === "if_statement" && /__name__/.test(top.childForFieldName("condition")?.text ?? "") && /__main__/.test(top.childForFieldName("condition")?.text ?? "")) entry = true;
  }
  if (all) for (const d of decls) d.exported = all.has(d.name);

  const calls: FileFacts["calls"] = [];
  for (const n of root.descendantsOfType("call")) {
    const fn = n?.childForFieldName("function");
    if (!n || !fn || !(fn.type === "identifier" || (fn.type === "attribute" && DOTTED.test(fn.text)))) continue;
    const inDecl = spans.find((s) => n.startIndex >= s.s && n.endIndex <= s.e)?.name;
    if (fn.text === "uvicorn.run") entry = true;
    calls.push({ callee: fn.text, line: n.startPosition.row + 1, ...(inDecl && { inDecl }), ...callArgs(n) });
  }
  const errors = root.hasError ? root.descendantsOfType("ERROR").filter((e) => e).map((e) => ({ line: e!.startPosition.row + 1, message: "syntax error" })) : [];
  return { imports, decls, calls, jsx: [], errors, ...(entry && { entry }), ...annotationsOf(root) };
}
