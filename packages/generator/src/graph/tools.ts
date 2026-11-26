import { readFileSync } from "node:fs";
import type { Config, Node } from "../types.ts";

const registry: Record<string, Record<string, string[]>> = JSON.parse(readFileSync(new URL("../../registry/tools.json", import.meta.url), "utf8"));

function categoryOf(eco: string, name: string): string {
  for (const [cat, names] of Object.entries(registry[eco] ?? {}))
    for (const n of names) if (n === name || (n.endsWith("*") && name.startsWith(n.slice(0, -1)))) return cat;
  return "other";
}

/** `meta.category` on externals (your config first, then the built-in registry) and the grouped `tools` index (Spec 1 §4.9). */
export function applyTools(nodes: Node[], config: Config): { category: string; nodes: string[] }[] {
  const mine = (config.tools as Record<string, string> | undefined) ?? {};
  const groups = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.kind !== "external") continue;
    const cat = mine[n.name] ?? categoryOf(String(n.meta?.ecosystem), n.name);
    n.meta = { ...n.meta, category: cat };
    (groups.get(cat) ?? groups.set(cat, []).get(cat)!).push(n.id);
  }
  return [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([category, ids]) => ({ category, nodes: ids.sort() }));
}
