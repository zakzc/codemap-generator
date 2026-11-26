import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";
import { pythonFacts } from "../lang/python.ts";
import { typescriptFacts } from "../lang/typescript.ts";
import type { FileFacts } from "../types.ts";
import type { SourceFile } from "../discover/files.ts";

const wasm = (name: string) => createRequire(import.meta.url).resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${name}.wasm`);
export const grammarOf = (path: string) => (path.endsWith(".py") ? "python" : path.endsWith(".tsx") ? "tsx" : /\.[mc]?ts$/.test(path) ? "typescript" : "javascript");

let parser: Parser | undefined;
const langs = new Map<string, Language>();

/** Parses TS/JS files into facts. Errors in one file never stop the run (Spec 1 §4.3). */
export async function parseFiles(files: SourceFile[]): Promise<FileFacts[]> {
  if (!files.some((f) => f.lang === "typescript" || f.lang === "python")) return [];
  if (!parser) { await Parser.init(); parser = new Parser(); }
  const out: FileFacts[] = [];
  for (const f of files) {
    if (f.lang !== "typescript" && f.lang !== "python") continue;
    const g = grammarOf(f.path);
    if (!langs.has(g)) langs.set(g, await Language.load(wasm(g)));
    parser.setLanguage(langs.get(g)!);
    const tree = parser.parse(f.content);
    const loc = f.content === "" ? 0 : f.content.split("\n").length - (f.content.endsWith("\n") ? 1 : 0);
    const facts = tree ? (f.lang === "python" ? pythonFacts(tree.rootNode) : typescriptFacts(tree.rootNode)) : { imports: [], decls: [], calls: [], jsx: [], errors: [{ line: 1, message: "parse failed" }] };
    tree?.delete();
    out.push({ path: f.path, lang: f.lang, hash: f.hash, loc, ...facts });
  }
  return out;
}
