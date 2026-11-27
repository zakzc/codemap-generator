import type { Decl, FileFacts } from "../types.ts";

export type Classified = { kind: "component" | "hook" | "function" | "class" | "type" | "store" | "endpoint"; meta: Record<string, unknown> };

const COMPONENT_BASES = /^(React\.)?(Pure)?Component$/;
const WRAPPERS = /^(React\.)?(memo|forwardRef)$/;
const LAZY = /^(React\.)?lazy$/;
export const isHookName = (n: string) => /^use[A-Z0-9]/.test(n);

/** React + hook rules of Spec 1 §4.5. Returns undefined when the decl is not a symbol node (aliases, plain consts). */
export function classifyReact(d: Decl, facts: FileFacts): Classified | undefined {
  const rendersJsx = facts.jsx.some((j) => j.inDecl === d.name);
  const isComponent = /^[A-Z]/.test(d.name) || (d.name === "default" && rendersJsx);
  switch (d.kind) {
    case "function":
      if (isHookName(d.name)) return { kind: "hook", meta: {} };
      if (isComponent && rendersJsx) return { kind: "component", meta: { lazy: false } };
      return { kind: "function", meta: {} };
    case "class":
      if (d.extends && COMPONENT_BASES.test(d.extends)) return { kind: "component", meta: { lazy: false } };
      return { kind: "class", meta: { declaredAs: d.declaredAs ?? "class", ...(d.methods && { methods: d.methods }) } };
    case "type": return { kind: "type", meta: {} };
    case "const": {
      const callee = d.init?.callee ?? "";
      if (LAZY.test(callee)) return { kind: "component", meta: { lazy: true } };
      if (WRAPPERS.test(callee) && isComponent && rendersJsx) return { kind: "component", meta: { lazy: false } };
      if (isHookName(d.name) && d.init) return { kind: "hook", meta: {} };
    }
  }
}
