import type { Decl, FileFacts } from "../types.ts";

export type Classified = { kind: "component" | "hook" | "function" | "class" | "type" | "store" | "endpoint"; meta: Record<string, unknown> };

const COMPONENT_BASES = /^(React\.)?(Pure)?Component$/;
const WRAPPERS = /^(React\.)?(memo|forwardRef)$/;
const LAZY = /^(React\.)?lazy$/;
export const isHookName = (n: string) => /^use[A-Z0-9]/.test(n);

/** Hook names called inside `decl` (`useState`, `React.useEffect` → `useEffect`). */
const hooksIn = (facts: FileFacts, decl: string) =>
  [...new Set(facts.calls.filter((c) => c.inDecl === decl).map((c) => c.callee.split(".").pop()!).filter(isHookName))].sort();

/** React + hook rules of Spec 1 §4.5. Returns undefined when the decl is not a symbol node (aliases, plain consts). */
export function classifyReact(d: Decl, facts: FileFacts): Classified | undefined {
  const rendersJsx = facts.jsx.some((j) => j.inDecl === d.name);
  const hooks = hooksIn(facts, d.name);
  const isComponent = /^[A-Z]/.test(d.name) || (d.name === "default" && rendersJsx);
  switch (d.kind) {
    case "function":
      if (isHookName(d.name)) return { kind: "hook", meta: { hooks, ...(d.async && { async: true }), params: d.params } };
      if (isComponent && rendersJsx) return { kind: "component", meta: { props: d.props ?? [], hooks, lazy: false } };
      return { kind: "function", meta: { ...(d.async && { async: true }), ...(d.params?.length && { params: d.params }) } };
    case "class":
      if (d.extends && COMPONENT_BASES.test(d.extends)) return { kind: "component", meta: { props: [], hooks: [], lazy: false } };
      return { kind: "class", meta: { declaredAs: d.declaredAs ?? "class", ...(d.methods && { methods: d.methods }) } };
    case "type": return { kind: "type", meta: {} };
    case "const": {
      const callee = d.init?.callee ?? "";
      if (LAZY.test(callee)) return { kind: "component", meta: { props: [], hooks: [], lazy: true } };
      if (WRAPPERS.test(callee) && isComponent && rendersJsx) return { kind: "component", meta: { props: d.props ?? [], hooks, lazy: false } };
      if (isHookName(d.name) && d.init) return { kind: "hook", meta: { hooks } };
    }
  }
}

/** Breadth-first render distance from `roots` over `renders` edges; unreachable components get -1. */
export function entryDepths(components: string[], roots: string[], renders: [string, string][]): Map<string, number> {
  const depth = new Map(components.map((c) => [c, -1]));
  let frontier = roots.filter((r) => depth.has(r));
  for (const r of frontier) depth.set(r, 0);
  for (let d = 1; frontier.length; d++) {
    const next: string[] = [];
    for (const [from, to] of renders) if (frontier.includes(from) && depth.get(to) === -1) { depth.set(to, d); next.push(to); }
    frontier = next;
  }
  return depth;
}
