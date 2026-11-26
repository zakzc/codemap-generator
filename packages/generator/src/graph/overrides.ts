import type { Config, Diagnostic, Edge, Feature, Node } from "../types.ts";
import { sortMembers } from "./features.ts";

type CfgFeature = { id: string; include?: string[]; exclude?: string[]; roles?: Record<string, Feature["members"][number]["role"]> };

/** Your notes, manual edges and feature changes always win (Spec 1 §4.8). Unknown ids → `stale-override`, skipped. */
export function applyOverrides(nodes: Node[], edges: Edge[], features: Feature[], config: Config, diagnostics: Diagnostic[]): Edge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stale = (what: string, id: string) => diagnostics.push({ level: "warn", code: "stale-override", message: `${what}: ${id} does not exist` });

  for (const [id, note] of Object.entries((config.notes as Record<string, string> | undefined) ?? {})) {
    const n = byId.get(id);
    if (n) (n as Node & { note?: string }).note = note; else stale("note", id);
  }

  const manual = new Map<string, Edge>();
  for (const e of (config.edges as { from: string; to: string; kind: string; note?: string }[] | undefined) ?? []) {
    if (!byId.has(e.from) || !byId.has(e.to)) { stale("edge", byId.has(e.from) ? e.to : e.from); continue; }
    manual.set(`${e.from}\0${e.kind}\0${e.to}`, { from: e.from, to: e.to, kind: e.kind, confidence: "manual", ...(e.note && { meta: { note: e.note } }) });
  }
  const merged = [...edges.filter((e) => !manual.has(`${e.from}\0${e.kind}\0${e.to}`)), ...manual.values()];

  for (const c of (config.features as CfgFeature[] | undefined) ?? []) {
    const f = features.find((x) => x.id === c.id);
    if (!f) continue; // a feature without seeds or commits has nothing to change
    for (const id of c.include ?? []) {
      if (!byId.has(id)) { stale(`feature ${c.id} include`, id); continue; }
      const m = f.members.find((x) => x.node === id);
      if (m) m.origin = "user"; else f.members.push({ node: id, role: "support", distance: 2, origin: "user" });
    }
    for (const id of c.exclude ?? []) f.members = f.members.filter((m) => m.node !== id);
    for (const [id, role] of Object.entries(c.roles ?? {})) {
      const m = f.members.find((x) => x.node === id);
      if (m) { m.role = role; m.origin = "user"; } else stale(`feature ${c.id} role`, id);
    }
    sortMembers(f.members);
  }
  return merged;
}
