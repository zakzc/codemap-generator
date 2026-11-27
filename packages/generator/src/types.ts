export type Diagnostic = { level: "info" | "warn" | "error"; code: string; message: string; path?: string; line?: number };

export type ArgFact = { kind: "string" | "template" | "id" | "call" | "fn" | "object" | "list" | "other"; value?: string; props?: Record<string, ArgFact>; items?: ArgFact[] };
export type Decl = {
  name: string; kind: "function" | "class" | "type" | "const" | "alias";
  range: { start: number; end: number }; exported: boolean; doc?: string;
  methods?: string[]; declaredAs?: string;
  extends?: string;                                          // class heritage text
  init?: { callee: string; args: ArgFact[]; kwargs?: Record<string, ArgFact>; lazy?: string }; // const initialised by a call (createSlice, memo, lazy…)
  decorators?: { callee: string; args: ArgFact[]; kwargs?: Record<string, ArgFact> }[]; // Python decorators
  depends?: string[];                                        // names passed to Depends(...) in decorators or signature
  target?: string;                                           // alias: `const { a } = slice.actions` → "slice.actions"
};
export type FileFacts = {
  path: string; lang: string; hash: string; loc: number;
  imports: { spec: string; names: string[]; line: number; dynamic?: boolean; reexport?: boolean; bindings?: { local: string; imported: string }[] }[];
  decls: Decl[];
  defaultExport?: string;                                    // name of the default-exported decl
  calls: { callee: string; line: number; inDecl?: string; args: ArgFact[]; kwargs?: Record<string, ArgFact> }[]; // bare names and dotted member calls
  jsx: { name: string; line: number; inDecl?: string; conditional: boolean }[];
  annotations?: { feature: string; line: number }[];         // `@feature <id>` comments
  entry?: boolean;                                           // Python: `if __name__ == "__main__"` or `uvicorn.run`
  errors: { line: number; message: string }[];
};

export type Config = {
  project?: string; ignore?: string[]; entrypoints?: string[]; hubFanIn?: number; detail?: { full?: string[] };
  [key: string]: unknown; // remaining keys are consumed by later milestones (features, notes, edges…)
};

export type Node = {
  id: string; kind: string; name: string; parent: string | null; path?: string; range?: { start: number; end: number };
  exported?: boolean; doc?: string;
  tags?: string[]; metrics?: Record<string, number>; meta?: Record<string, unknown>;
};
export type Edge = {
  from: string; to: string; kind: string; confidence?: string; count?: number;
  at?: { path: string; line: number }[]; meta?: Record<string, unknown>;
};

export type Member = { node: string; role: "entry" | "core" | "support" | "shared"; distance?: number; origin?: "auto" | "user" | "history"; commits?: number };
export type Feature = {
  id: string; name: string; description?: string; members: Member[];
};
