import type { Decl } from "../types.ts";
import type { Classified } from "./react.ts";

/** `createSlice({ reducers })` / `configureStore({ reducer })` consts become `store` nodes (Spec 1 §4.5). */
export function classifyRedux(d: Decl): Classified | undefined {
  const callee = d.init?.callee;
  const arg = d.init?.args[0];
  if (callee === "createSlice") return { kind: "store", meta: { framework: "redux", actions: Object.keys(arg?.props?.reducers?.props ?? {}).sort() } };
  if (callee === "configureStore") return { kind: "store", meta: { framework: "redux", stateKeys: Object.keys(arg?.props?.reducer?.props ?? {}).sort() } };
}

export const isSelectorHook = (callee: string) => /^use\w*Selector$/.test(callee);
