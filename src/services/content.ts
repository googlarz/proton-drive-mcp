import { mkdtemp, readdir, readFile, lstat, rm } from "node:fs/promises";
import { registerTempDir, unregisterTempDir } from "../utils/tempDirs.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveService } from "./drive.js";
import { validateLocalPath } from "../utils/validation.js";
import { callContext } from "../utils/subprocess.js";
import { retryOnLocked } from "../utils/lockRetry.js";
import { showValue } from "../utils/text.js";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

export { docxXmlToText } from "./contentExtract.js";

export const DEFAULT_MAX_CHARS = 20_000;
export const MAX_MAX_CHARS = 100_000;
const DEFAULT_READ_MAX_BYTES = 10 * 1024 * 1024;
const HARD_READ_MAX_BYTES = 50 * 1024 * 1024;
/** Text collected from a PDF/DOCX stops here (code units); the parent never holds more. */
const MAX_EXTRACT_CHARS = 2_000_000;
const DEFAULT_READ_TIMEOUT_MS = 20_000;
const MAX_READ_TIMEOUT_MS = 120_000;

const TEXT_EXTS = new Set([
  "txt", "text", "md", "markdown", "json", "jsonl", "csv", "tsv", "yaml", "yml", "xml", "html", "htm", "log", "ini", "toml", "cfg", "conf", "env",
  "rst", "tex", "srt", "vtt", "sql", "sh", "bash", "zsh", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "java", "kt", "c", "h", "cpp",
  "hpp", "cs", "go", "rs", "rb", "php", "swift", "pl", "lua", "r", "ics", "vcf",
]);
const SUPPORTED = "plain text, markdown, json, csv/tsv, yaml, xml, html, log and common code files, .docx and .pdf";

export interface ReadContentArgs { path: string; maxChars?: number; offset?: number }
export interface ReadContentResult {
  path: string; format: string; size: number; chars: number; offset: number; text: string;
  truncated: boolean; nextOffset?: number; note?: string;
}
export interface ReadContentDeps {
  /** Overrides for the PDF/DOCX worker (tests): limits, text cap, package specifiers, a hook receiving the Worker. */
  worker?: {
    maxOldGenerationSizeMb?: number; timeoutMs?: number; maxTextChars?: number;
    moduleSpecifiers?: Record<string, string>; onWorker?: (w: Worker) => void;
  };
}

/** Download cap in bytes: PROTON_DRIVE_READ_MAX_BYTES, default 10 MB, never above 50 MB. */
export function readMaxBytes(): number {
  const n = Number(process.env["PROTON_DRIVE_READ_MAX_BYTES"]);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), HARD_READ_MAX_BYTES) : DEFAULT_READ_MAX_BYTES;
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function pickFormat(path: string, mediaType: string): "text" | "docx" | "pdf" | undefined {
  const ext = extOf(path);
  if (ext === "docx") return "docx";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTS.has(ext)) return "text";
  if (/^text\//i.test(mediaType) || /^application\/(json|xml|x-yaml|yaml)$/i.test(mediaType)) return "text";
  return undefined;
}

function decodeUtf8(buf: Buffer): string {
  if (buf.includes(0)) throw new Error("not text: the file contains NUL bytes (binary)");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Error("not text: the file is not valid UTF-8");
  }
}

/** Hard timeout for one PDF/DOCX parse: PROTON_DRIVE_READ_TIMEOUT_MS, default 20 s, clamped to 1 ms .. 120 s. */
export function readTimeoutMs(): number {
  const n = Number(process.env["PROTON_DRIVE_READ_TIMEOUT_MS"]);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.floor(n), 1), MAX_READ_TIMEOUT_MS) : DEFAULT_READ_TIMEOUT_MS;
}

interface Extracted { text: string; note?: string; capped: boolean }

/**
 * Parses in a worker thread with a memory cap, a hard timeout and the request's abort signal, so a hostile
 * PDF/DOCX can take down only the worker. The bytes are copied and transferred; the worker needs no file access.
 */
async function extractInWorker(format: "pdf" | "docx", buf: Buffer, opts: NonNullable<ReadContentDeps["worker"]>): Promise<Extracted> {
  const tooBig = new Error(`${format.toUpperCase()} is too large or complex to read safely`);
  const signal = callContext.getStore()?.signal;
  if (signal?.aborted) throw new Error("cancelled");
  const bytes = new Uint8Array(buf.length); // not buf.buffer: small Buffers share a pooled ArrayBuffer
  bytes.set(buf);
  const w = new Worker(fileURLToPath(new URL("./contentWorker.js", import.meta.url)), {
    workerData: { kind: format, bytes, maxChars: opts.maxTextChars ?? MAX_EXTRACT_CHARS, moduleSpecifiers: opts.moduleSpecifiers },
    transferList: [bytes.buffer],
    resourceLimits: { maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb ?? 512, maxYoungGenerationSizeMb: 32 },
  });
  opts.onWorker?.(w);
  let onAbort: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<Extracted>((resolve, reject) => {
      timer = setTimeout(() => reject(tooBig), opts.timeoutMs ?? readTimeoutMs());
      onAbort = () => reject(new Error("cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      w.once("message", (m: { ok: boolean; error?: string } & Extracted) => (m.ok ? resolve(m) : reject(new Error(m.error ?? "read failed"))));
      w.once("error", () => reject(tooBig)); // ERR_WORKER_OUT_OF_MEMORY or a crash inside the parser
      w.once("exit", () => reject(tooBig)); // no-op once settled
    });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    await w.terminate();
  }
}

/** Slices by code points (never splits a surrogate pair) and counts the total in one pass. */
export function sliceCodePoints(s: string, offset: number, max: number): { text: string; total: number; end: number } {
  let cp = 0, i = 0, startIdx = -1, endIdx = s.length, endCp = -1;
  while (i < s.length) {
    if (cp === offset) startIdx = i;
    if (cp === offset + max) { endIdx = i; endCp = cp; }
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
    cp++;
  }
  if (cp === offset) startIdx = s.length;
  if (cp === offset + max) { endIdx = s.length; endCp = cp; }
  if (startIdx < 0) return { text: "", total: cp, end: cp }; // offset beyond the end
  return { text: s.slice(startIdx, endIdx), total: cp, end: endCp < 0 ? cp : endCp };
}

/** Downloads into a private temp dir; the dir is always removed, also on abort or error. */
async function downloadBytes(drive: DriveService, path: string, cap: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "pdmcp-read-"));
  registerTempDir(dir);
  try {
    validateLocalPath(dir);
    const signal = callContext.getStore()?.signal;
    const r = await drive.download(path, dir, "rename", "skip");
    if (signal?.aborted) throw new Error("cancelled");
    if (r.failed > 0 || r.downloaded < 1) throw new Error("download failed");
    const names = await readdir(dir);
    if (names.length !== 1) throw new Error("unexpected download result");
    const file = join(dir, names[0]!);
    const st = await lstat(file); // lstat: a symlink is not a regular file
    if (!st.isFile()) throw new Error("unexpected download result");
    if (st.size > cap) throw new Error(`downloaded file is ${st.size} bytes, over the read cap of ${cap} bytes`);
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
    unregisterTempDir(dir);
  }
}

export async function readDriveContent(drive: DriveService, args: ReadContentArgs, deps: ReadContentDeps = {}): Promise<ReadContentResult> {
  const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
  const offset = args.offset ?? 0;
  const path = args.path;
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_MAX_CHARS) throw new Error(`maxChars must be an integer from 1 to ${MAX_MAX_CHARS}`);
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  const node = ((await drive.info(path)) ?? {}) as Record<string, any>;
  const mediaType = typeof node.mediaType === "string" ? node.mediaType : "";
  if (node.type === "folder" || node.type === "album") throw new Error(`${showValue(path)} is a folder; drive_read_content reads files (use drive_list).`);
  if (/^application\/vnd\.proton\./i.test(mediaType)) {
    throw new Error(`${showValue(path)} is a Proton Docs/Sheets document; the CLI cannot download these, so its text cannot be read.`);
  }
  const format = pickFormat(path, mediaType);
  if (!format) throw new Error(`unsupported format for ${showValue(path)}${mediaType ? ` (${showValue(mediaType, 60, 20)})` : ""}. Supported: ${SUPPORTED}.`);
  const cap = readMaxBytes();
  // claimedSize is uploader-controlled: a lying claim only costs download bandwidth, since the
  // post-download lstat size check (and the worker limits) still apply to the real bytes.
  const declared = node.activeRevision?.claimedSize;
  if (typeof declared === "number" && declared > cap) {
    throw new Error(`${showValue(path)} is ${declared} bytes, over the read cap of ${cap} bytes (PROTON_DRIVE_READ_MAX_BYTES, max ${HARD_READ_MAX_BYTES}). Use drive_download.`);
  }

  const buf = await retryOnLocked(() => downloadBytes(drive, path, cap));
  let text: string;
  let note: string | undefined;
  let capped = false;
  if (format === "text") text = decodeUtf8(buf);
  else {
    ({ text, note, capped } = await extractInWorker(format, buf, deps.worker ?? {}));
    if (capped) note = [note, `text capped at ${deps.worker?.maxTextChars ?? MAX_EXTRACT_CHARS} characters; the rest of the file was not read`].filter(Boolean).join("; ");
  }
  text = text.replaceAll("\0", "");

  const s = sliceCodePoints(text, offset, maxChars);
  const truncated = s.end < s.total || capped;
  return {
    path, format, size: buf.length, chars: s.total, offset, text: s.text, truncated,
    ...(truncated ? { nextOffset: s.end } : {}),
    ...(note ? { note } : {}),
  };
}
