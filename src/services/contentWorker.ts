// worker_threads entry for drive_read_content: parses a PDF or DOCX from bytes it is handed, so a
// hostile file can only exhaust this thread's resource limits (set by the parent), never the server.
import { parentPort, workerData } from "node:worker_threads";
import { extractDocx, extractPdf } from "./contentExtract.js";

interface Job { kind: "pdf" | "docx"; bytes: Uint8Array; maxChars: number; moduleSpecifiers?: Record<string, string> }
const job = workerData as Job;
// Optional packages are imported here, never in the parent. moduleSpecifiers is a test hook.
const load = (name: string): Promise<any> => import(job.moduleSpecifiers?.[name] ?? name);

try {
  const r = job.kind === "pdf" ? await extractPdf(job.bytes, load, job.maxChars) : await extractDocx(job.bytes, load, job.maxChars);
  parentPort!.postMessage({ ok: true, ...r });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
