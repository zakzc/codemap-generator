import type { Node as TsNode } from "web-tree-sitter";
import type { ArgFact, Decl, FileFacts } from "../types.ts";

type Imp = FileFacts["imports"][number];
const str = (n: TsNode | null): string | null => (n && n.type === "string" ? n.text.slice(1, -1) : null);
const DOTTED = /^[\w$]+(\.[\w$]+)*$/;
const FN_TYPES = new Set(["arrow_function", "function_expression", "function"]);

/** Selector lambda `s => s.docs.x` → "docs"; anything else → undefined. */
function selectorKey(fn: TsNode): string | undefined {
  const p = fn.childForFieldName("parameters")?.namedChild(0);
  const param = (p?.childForFieldName("pattern") ?? p ?? fn.childForFieldName("parameter"))?.text;
  let body = fn.childForFieldName("body");
  while (body?.type === "parenthesized_expression") body = body.namedChild(0);
  const props: string[] = [];
  while (body?.type === "member_expression") { props.unshift(body.childForFieldName("property")?.text ?? ""); body = body.childForFieldName("object"); }
  return body?.type === "identifier" && body.text === param ? props[0] || undefined : undefined;
}

function argFact(n: TsNode, depth = 0): ArgFact {
  switch (n.type) {
    case "string": return { kind: "string", value: n.text.slice(1, -1) };
    case "template_string": return { kind: "template", value: n.text.slice(1, -1) };
    case "identifier": return { kind: "id", value: n.text };
    case "member_expression": return DOTTED.test(n.text) ? { kind: "id", value: n.text } : { kind: "other" };
    case "call_expression": { const f = n.childForFieldName("function")?.text ?? ""; return DOTTED.test(f) ? { kind: "call", value: f } : { kind: "other" }; }
    case "object": {
      if (depth > 2) return { kind: "object" };
      const props: Record<string, ArgFact> = {};
      for (const c of n.namedChildren) {
        if (c?.type === "pair") { const k = c.childForFieldName("key"); const v = c.childForFieldName("value"); if (k && v) props[k.text.replace(/^["']|["']$/g, "")] = argFact(v, depth + 1); }
        else if (c?.type === "shorthand_property_identifier") props[c.text] = { kind: "id", value: c.text };
        else if (c?.type === "method_definition") props[c.childForFieldName("name")?.text ?? ""] = { kind: "fn" };
      }
      return { kind: "object", props };
    }
    default: return FN_TYPES.has(n.type) ? { kind: "fn", value: selectorKey(n) } : { kind: "other" };
  }
}

const argsOf = (call: TsNode): ArgFact[] => (call.childForFieldName("arguments")?.namedChildren ?? []).slice(0, 2).filter((a) => a && a.type !== "comment").map((a) => argFact(a!));

function paramInfo(fn: TsNode): { params: string[]; props?: string[] } {
  const list = fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter");
  const nodes = list?.type === "formal_parameters" ? list.namedChildren : list ? [list] : [];
  const pats = nodes.filter((c): c is TsNode => !!c && c.type !== "comment").map((c) => c.childForFieldName("pattern") ?? c);
  const first = pats[0];
  const props = first?.type === "object_pattern"
    ? first.namedChildren.flatMap((c) => (c?.type === "shorthand_property_identifier_pattern" ? [c.text] : c?.type === "pair_pattern" ? [c.childForFieldName("key")?.text ?? ""] : [])).filter(Boolean)
    : undefined;
  return { params: pats.map((p) => (p.type === "identifier" ? p.text : p.type === "object_pattern" ? "{…}" : p.text.slice(0, 40))), ...(props && { props }) };
}

function docOf(outer: TsNode): string | undefined {
  const c = outer.previousNamedSibling;
  if (c?.type !== "comment" || !c.text.startsWith("/**") || c.endPosition.row < outer.startPosition.row - 1) return;
  const body = c.text.replace(/^\/\*\*|\*\/$/g, "").split("\n").map((l) => l.replace(/^\s*\*?\s?/, "")).join("\n").trim();
  const first = body.split(/\n\s*\n|\n@/)[0]!.replace(/\s+/g, " ").trim();
  return first ? first.slice(0, 300) : undefined;
}

/** `@feature <id>` in any comment (Spec 1 §4.5). */
export function annotationsOf(root: TsNode): { annotations?: { feature: string; line: number }[] } {
  const annotations = root.descendantsOfType("comment").flatMap((c) => {
    const m = c?.text.match(/@feature\s+([\w.:-]+)/);
    return c && m ? [{ feature: m[1]!.replace(/^feature:/, ""), line: c.startPosition.row + 1 }] : [];
  });
  return annotations.length ? { annotations } : {};
}

/** Imports (static, re-exports, `import()`, `require`), top-level declarations, calls and JSX uses. */
export function typescriptFacts(root: TsNode): Pick<FileFacts, "imports" | "decls" | "defaultExport" | "calls" | "jsx" | "errors" | "annotations"> {
  const imports: Imp[] = [];
  const decls: Decl[] = [];
  const spans: { name: string; s: number; e: number }[] = [];
  const exportedLater = new Set<string>();
  let defaultExport: string | undefined;

  const addDecl = (d: Decl, outer: TsNode) => {
    if (decls.some((x) => x.name === d.name)) return; // overloads / merged declarations: first wins
    decls.push({ ...d, ...(docOf(outer) && { doc: docOf(outer) }) });
    spans.push({ name: d.name, s: outer.startIndex, e: outer.endIndex });
  };
  const range = (n: TsNode) => ({ start: n.startPosition.row + 1, end: n.endPosition.row + 1 });

  function declare(stmt: TsNode, exported: boolean, outer: TsNode, isDefault: boolean) {
    const nameOf = (n: TsNode) => n.childForFieldName("name")?.text ?? (isDefault ? "default" : "");
    switch (stmt.type) {
      case "function_declaration": case "generator_function_declaration": {
        const name = nameOf(stmt);
        addDecl({ name, kind: "function", range: range(outer), exported, async: stmt.children.some((c) => c?.type === "async") || undefined, ...paramInfo(stmt) }, outer);
        if (isDefault) defaultExport = name;
        break;
      }
      case "class_declaration": case "abstract_class_declaration": {
        const name = nameOf(stmt);
        const ext = stmt.descendantsOfType("extends_clause")[0]?.childForFieldName("value")?.text;
        const methods = stmt.childForFieldName("body")?.namedChildren.filter((c) => c?.type === "method_definition").map((c) => c!.childForFieldName("name")?.text ?? "") ?? [];
        addDecl({ name, kind: "class", range: range(outer), exported, declaredAs: "class", ...(ext && { extends: ext }), ...(methods.length && { methods }) }, outer);
        if (isDefault) defaultExport = name;
        break;
      }
      case "interface_declaration": addDecl({ name: nameOf(stmt), kind: "type", range: range(outer), exported, declaredAs: "interface" }, outer); break;
      case "type_alias_declaration": addDecl({ name: nameOf(stmt), kind: "type", range: range(outer), exported }, outer); break;
      case "enum_declaration": addDecl({ name: nameOf(stmt), kind: "class", range: range(outer), exported, declaredAs: "enum" }, outer); break;
      case "lexical_declaration": case "variable_declaration":
        for (const v of stmt.namedChildren) {
          if (v?.type !== "variable_declarator") continue;
          const nm = v.childForFieldName("name"), val = v.childForFieldName("value");
          const r = range(v);
          if (nm?.type === "object_pattern") {
            // `export const { a, b: c } = slice.actions` → aliases that resolve to the slice's actions
            if (val && DOTTED.test(val.text))
              for (const c of nm.namedChildren) {
                const local = c?.type === "shorthand_property_identifier_pattern" ? c.text : c?.type === "pair_pattern" ? c.childForFieldName("value")?.text : undefined;
                if (local) addDecl({ name: local, kind: "alias", range: r, exported, target: val.text }, outer);
              }
            continue;
          }
          if (nm?.type !== "identifier") continue;
          let value = val;
          while (value && ["as_expression", "satisfies_expression", "parenthesized_expression"].includes(value.type)) value = value.namedChild(0);
          if (value?.type === "member_expression" && /^[\w$]+\.actions$/.test(value.text))
            addDecl({ name: nm.text, kind: "alias", range: r, exported, target: value.text }, outer); // `export const doc = slice.actions`
          else if (value && FN_TYPES.has(value.type))
            addDecl({ name: nm.text, kind: "function", range: r, exported, async: value.children.some((c) => c?.type === "async") || undefined, ...paramInfo(value) }, outer);
          else if (value?.type === "call_expression") {
            const callee = value.childForFieldName("function")?.text ?? "";
            const lazy = /^(React\.)?lazy$/.test(callee) ? value.text.match(/import\(\s*['"]([^'"]+)['"]/)?.[1] : undefined;
            addDecl({ name: nm.text, kind: "const", range: r, exported, init: { callee, args: argsOf(value), ...(lazy && { lazy }) } }, outer);
          } else addDecl({ name: nm.text, kind: "const", range: r, exported }, outer);
        }
        break;
    }
  }

  for (const top of root.namedChildren) {
    if (!top) continue;
    if (top.type === "export_statement") {
      const decl = top.childForFieldName("declaration"), value = top.childForFieldName("value");
      const source = str(top.childForFieldName("source"));
      if (decl) declare(decl, true, top, top.children.some((c) => c?.type === "default"));
      else if (source) {
        const names = top.descendantsOfType("export_specifier").map((s) => s!.childForFieldName("name")?.text ?? "").filter(Boolean);
        if (top.children.some((c) => c?.type === "*")) names.push("*");
        imports.push({ spec: source, names, line: top.startPosition.row + 1, reexport: true, bindings: names.map((n) => ({ local: n, imported: n })) });
      } else if (value) { if (value.type === "identifier") defaultExport = value.text; }
      else for (const s of top.descendantsOfType("export_specifier")) { const n = s!.childForFieldName("name")?.text; if (n) exportedLater.add(n); }
    } else if (top.type === "import_statement") {
      const spec = str(top.childForFieldName("source"));
      if (!spec) continue;
      const bindings: { local: string; imported: string }[] = [];
      for (const s of top.descendantsOfType("import_specifier")) { const n = s!.childForFieldName("name")?.text; if (n) bindings.push({ local: s!.childForFieldName("alias")?.text ?? n, imported: n }); }
      for (const c of top.children.filter((c) => c?.type === "import_clause"))
        for (const x of c!.children) {
          if (x?.type === "identifier") bindings.push({ local: x.text, imported: "default" });
          if (x?.type === "namespace_import") bindings.push({ local: x.namedChild(0)?.text ?? "", imported: "*" });
        }
      const typeOnly = top.children.some((c) => c?.type === "type") || undefined;
      imports.push({ spec, names: bindings.map((b) => b.imported), line: top.startPosition.row + 1, bindings, ...(typeOnly && { typeOnly }) });
    } else declare(top, false, top, false);
  }
  for (const d of decls) if (exportedLater.has(d.name)) d.exported = true;

  const declAt = (n: TsNode) => spans.find((s) => n.startIndex >= s.s && n.endIndex <= s.e)?.name;
  const conditional = (n: TsNode, stop: number) => {
    for (let p = n.parent; p && p.startIndex >= stop; p = p.parent) {
      if (p.type === "ternary_expression" || p.type === "if_statement") return true;
      if (p.type === "binary_expression" && ["&&", "||", "??"].includes(p.childForFieldName("operator")?.text ?? "")) return true;
    }
    return false;
  };

  const calls: FileFacts["calls"] = [];
  const jsx: FileFacts["jsx"] = [];
  for (const n of root.descendantsOfType(["call_expression", "jsx_opening_element", "jsx_self_closing_element"])) {
    if (!n) continue;
    const line = n.startPosition.row + 1;
    const inDecl = declAt(n);
    if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn?.type === "import") { const spec = str(n.childForFieldName("arguments")?.namedChild(0) ?? null); if (spec) imports.push({ spec, names: [], line, dynamic: true }); continue; }
      if (fn?.type === "identifier" && fn.text === "require") { const spec = str(n.childForFieldName("arguments")?.namedChild(0) ?? null); if (spec) imports.push({ spec, names: [], line, dynamic: true }); continue; }
      if (fn && (fn.type === "identifier" || (fn.type === "member_expression" && DOTTED.test(fn.text))))
        calls.push({ callee: fn.text, line, ...(inDecl && { inDecl }), args: argsOf(n) });
    } else {
      const name = n.childForFieldName("name")?.text;
      if (name) jsx.push({ name, line, ...(inDecl && { inDecl }), conditional: conditional(n, spans.find((s) => s.name === inDecl)?.s ?? 0) });
    }
  }

  const errors = root.hasError
    ? root.descendantsOfType("ERROR").filter((e) => e).map((e) => ({ line: e!.startPosition.row + 1, message: "syntax error" }))
    : [];
  return { imports, decls, ...(defaultExport && { defaultExport }), calls, jsx, errors, ...annotationsOf(root) };
}
