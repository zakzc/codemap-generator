import { parentPort, workerData } from "node:worker_threads";
import { parseFiles } from "./parse.ts";

parseFiles(workerData).then((facts) => parentPort!.postMessage(facts));
