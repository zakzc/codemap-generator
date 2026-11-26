import type { ArgFact, Decl, FileFacts } from "../types.ts";

export type Endpoint = { method: string; path: string; framework: "fastapi" | "flask"; auth: boolean; line: number };
type Hit = { file: string; decl: Decl };
type Router = { key: string; prefix: string; framework: "fastapi" | "flask"; parent?: { key: string; prefix: string } };

const VERBS = new Set(["get", "post", "put", "delete", "patch", "options", "head"]);
const ROUTER_CALLEE = /(^|\.)(FastAPI|APIRouter|Flask|Blueprint)$/;
const AUTH = /auth|token|user|login/i;
const str = (a?: ArgFact) => (a?.kind === "string" ? a.value : undefined);
const join = (...ps: string[]) => ("/" + ps.map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")).replace(/\/+$/, "") || "/";

/**
 * FastAPI / Flask routes (Spec 1 §4.5): decorators on functions whose object resolves to an app/router created in the
 * repo; prefixes joined through `APIRouter(prefix=)`, `include_router(prefix=)`, `Blueprint(url_prefix=)`, `register_blueprint`.
 * Returns endpoints keyed by `file#function`.
 */
export function findEndpoints(facts: FileFacts[], resolveName: (file: string, name: string) => Hit | undefined): Map<string, Endpoint[]> {
  const py = facts.filter((f) => f.lang === "python");
  const routers = new Map<string, Router>();
  for (const f of py) for (const d of f.decls) {
    const m = d.init?.callee.match(ROUTER_CALLEE);
    if (!m) continue;
    const prefix = str(d.init!.kwargs?.prefix) ?? str(d.init!.kwargs?.url_prefix) ?? "";
    routers.set(`${f.path}#${d.name}`, { key: `${f.path}#${d.name}`, prefix, framework: /FastAPI|APIRouter/.test(m[2]!) ? "fastapi" : "flask" });
  }
  const routerOf = (file: string, name: string) => { const h = resolveName(file, name); return h ? routers.get(`${h.file}#${h.decl.name}`) : undefined; };

  for (const f of py) for (const c of f.calls) {
    const [obj, method] = c.callee.split(".");
    if (!obj || (method !== "include_router" && method !== "register_blueprint") || c.callee.split(".").length !== 2) continue;
    const parent = routerOf(f.path, obj), child = c.args[0]?.kind === "id" ? routerOf(f.path, c.args[0].value!) : undefined;
    if (parent && child && parent !== child) child.parent = { key: parent.key, prefix: str(c.kwargs?.prefix) ?? str(c.kwargs?.url_prefix) ?? "" };
  }
  const prefixOf = (r: Router, depth = 0): string =>
    join(r.parent && depth < 5 ? prefixOf(routers.get(r.parent.key)!, depth + 1) : "", r.parent?.prefix ?? "", r.prefix);

  const out = new Map<string, Endpoint[]>();
  for (const f of py) for (const d of f.decls) {
    for (const dec of d.decorators ?? []) {
      const parts = dec.callee.split(".");
      if (parts.length !== 2) continue;
      const [obj, verb] = parts as [string, string];
      const router = routerOf(f.path, obj);
      const path = str(dec.args[0]) ?? str(dec.kwargs?.rule) ?? str(dec.kwargs?.path);
      if (!router || path === undefined) continue;
      let methods: string[];
      if (verb === "websocket") methods = ["WS"];
      else if (VERBS.has(verb)) methods = [verb.toUpperCase()];
      else if (verb === "route") methods = (dec.kwargs?.methods?.items ?? []).flatMap((m) => (m.kind === "string" ? [m.value!.toUpperCase()] : [])).filter(Boolean);
      else continue;
      if (verb === "route" && !methods.length) methods = ["GET"];
      const auth = (d.depends ?? []).some((n) => AUTH.test(n));
      const base = prefixOf(router);
      for (const method of methods) {
        const list = out.get(`${f.path}#${d.name}`) ?? [];
        list.push({ method, path: join(base, path), framework: router.framework, auth, line: d.range.start });
        out.set(`${f.path}#${d.name}`, list);
      }
    }
  }
  return out;
}
