import { mkdtemp, readdir, readFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriveService } from "./drive.js";
import { validateLocalPath } from "../utils/validation.js";
import { callContext } from "../utils/subprocess.js";
import { retryOnLocked } from "../utils/lockRetry.js";

export const DEFAULT_MAX_CHARS = 20_000;
export const MAX_MAX_CHARS = 100_000;
const DEFAULT_READ_MAX_BYTES = 10 * 1024 * 1024;
const HARD_READ_MAX_BYTES = 50 * 1024 * 1024;
const DOCX_MAX_UNCOMPRESSED = 20 * 1024 * 1024;
const PDF_MAX_PAGES = 100;

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
  /** Loads an optional package ("fflate", "unpdf"); defaults to a dynamic import. */
  loadModule?: (name: string) => Promise<any>;
}

/** Download cap in bytes: PROTON_DRIVE_READ_MAX_BYTES, default 10 MB, never above 50 MB. */
export function readMaxBytes(): number {
  const n = Number(process.env["PROTON_DRIVE_READ_MAX_BYTES"]);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), HARD_READ_MAX_BYTES) : DEFAULT_READ_MAX_BYTES;
}

const defaultLoad = (name: string): Promise<any> => import(name);

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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
  });
}

/** Text of word/document.xml: one line per paragraph, w:t runs, w:tab and w:br handled minimally. */
export function docxXmlToText(xml: string): string {
  const paras = xml.split("</w:p>");
  paras.pop(); // text after the last paragraph end is the closing body markup
  const run = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)\b[^>]*\/?>/g;
  return paras
    .map((p) => {
      let line = "";
      for (const m of p.matchAll(run)) line += m[1] !== undefined ? decodeEntities(m[1]) : m[0].startsWith("<w:tab") ? "\t" : "\n";
      return line;
    })
    .join("\n");
}

async function docxText(buf: Buffer, load: (n: string) => Promise<any>): Promise<string> {
  let fflate: any;
  try { fflate = await load("fflate"); } catch { throw new Error("DOCX support needs the optional package fflate (npm install fflate)"); }
  let tooBig = false;
  let files: Record<string, Uint8Array>;
  try {
    files = fflate.unzipSync(new Uint8Array(buf), {
      filter: (f: { name: string; originalSize: number }) => {
        if (f.name !== "word/document.xml") return false;
        if (f.originalSize > DOCX_MAX_UNCOMPRESSED) { tooBig = true; return false; }
        return true;
      },
    });
  } catch {
    throw new Error("not a valid .docx (could not unzip)");
  }
  if (tooBig) throw new Error(`refused: word/document.xml is larger than ${DOCX_MAX_UNCOMPRESSED / 1048576} MB uncompressed`);
  const entry = files["word/document.xml"];
  if (!entry) throw new Error("not a valid .docx (no word/document.xml)");
  return docxXmlToText(new TextDecoder("utf-8").decode(entry));
}

async function pdfText(buf: Buffer, load: (n: string) => Promise<any>): Promise<{ text: string; note?: string }> {
  let unpdf: any;
  try { unpdf = await load("unpdf"); } catch { throw new Error("PDF support needs the optional package unpdf (npm install unpdf)"); }
  const pdf = await unpdf.getDocumentProxy(new Uint8Array(buf));
  try {
    const pages = Math.min(pdf.numPages as number, PDF_MAX_PAGES);
    const parts: string[] = [];
    for (let i = 1; i <= pages; i++) {
      const tc = await (await pdf.getPage(i)).getTextContent();
      parts.push(tc.items.map((it: { str?: string; hasEOL?: boolean }) => (it.str ?? "") + (it.hasEOL ? "\n" : "")).join(""));
    }
    const text = parts.join("\n\n");
    const notes: string[] = [];
    if (!text.trim()) notes.push("no text layer (scanned?)");
    if (pdf.numPages > PDF_MAX_PAGES) notes.push(`only the first ${PDF_MAX_PAGES} of ${pdf.numPages} pages were read`);
    return { text, note: notes.join("; ") || undefined };
  } finally {
    await pdf.destroy?.();
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
  if (node.type === "folder" || node.type === "album") throw new Error(`${path} is a folder; drive_read_content reads files (use drive_list).`);
  if (/^application\/vnd\.proton\./i.test(mediaType)) {
    throw new Error(`${path} is a Proton Docs/Sheets document; the CLI cannot download these, so its text cannot be read.`);
  }
  const format = pickFormat(path, mediaType);
  if (!format) throw new Error(`unsupported format for ${path}${mediaType ? ` (${mediaType})` : ""}. Supported: ${SUPPORTED}.`);
  const cap = readMaxBytes();
  const declared = node.activeRevision?.claimedSize;
  if (typeof declared === "number" && declared > cap) {
    throw new Error(`${path} is ${declared} bytes, over the read cap of ${cap} bytes (PROTON_DRIVE_READ_MAX_BYTES, max ${HARD_READ_MAX_BYTES}). Use drive_download.`);
  }

  const buf = await retryOnLocked(() => downloadBytes(drive, path, cap));
  const load = deps.loadModule ?? defaultLoad;
  let text: string;
  let note: string | undefined;
  if (format === "text") text = decodeUtf8(buf);
  else if (format === "docx") text = await docxText(buf, load);
  else ({ text, note } = await pdfText(buf, load));
  text = text.replaceAll("\0", "");

  const s = sliceCodePoints(text, offset, maxChars);
  const truncated = s.end < s.total;
  return {
    path, format, size: buf.length, chars: s.total, offset, text: s.text, truncated,
    ...(truncated ? { nextOffset: s.end } : {}),
    ...(note ? { note } : {}),
  };
}
