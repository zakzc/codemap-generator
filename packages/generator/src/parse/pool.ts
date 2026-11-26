import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { SourceFile } from "../discover/files.ts";
import type { FileFacts } from "../types.ts";
import { parseFiles } from "./parse.ts";

/** Below this many files, starting workers (each loads the wasm grammars) costs more than it saves. */
export const POOL_MIN_FILES = 60;

function runWorker(chunk: SourceFile[]): Promise<FileFacts[]> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { workerData: chunk });
    w.once("message", (facts) => { resolve(facts); void w.terminate(); });
    w.once("error", reject);
  });
}

/** Parses in `availableParallelism() - 1` workers; if a worker fails the chunk is parsed here (one bad worker never stops the run). */
export async function parseParallel(files: SourceFile[], workers = Math.max(1, availableParallelism() - 1)): Promise<FileFacts[]> {
  if (workers < 2 || files.length < POOL_MIN_FILES) return parseFiles(files);
  const chunks: SourceFile[][] = Array.from({ length: Math.min(workers, files.length) }, () => []);
  files.forEach((f, i) => chunks[i % chunks.length]!.push(f));
  const parts = await Promise.all(chunks.map((c) => runWorker(c).catch(() => parseFiles(c))));
  return parts.flat();
}
