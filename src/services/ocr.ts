import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { setPriority, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerTempDir, unregisterTempDir } from "../utils/tempDirs.js";
import { callContext, killTree, trackChild } from "../utils/subprocess.js";
import { Semaphore } from "../utils/semaphore.js";
import { ensurePrivateIndexDir, indexDir } from "./walkIndex.js";

/**
 * Opt-in local OCR (PROTON_DRIVE_OCR=1) for scanned PDFs and images. Everything runs on this machine in a child process
 * started with an argument array (never a shell) on a file inside a private temp dir; no text leaves the machine here.
 * Engines: the macOS Vision framework through a small Swift helper compiled on first use (src/ocr/vision-ocr.swift),
 * or tesseract (+ pdftoppm for PDFs). See README "OCR for scans (opt-in)".
 */
export type OcrEngine = "vision" | "tesseract";

export interface OcrDeps {
  /** Resolves a command to an absolute path, or undefined when it is not installed (tests). Default: PATH plus the usual Homebrew dirs. */
  which?: (cmd: string) => string | undefined;
  platform?: NodeJS.Platform;
  /** An OCR run that gets the engine slot after this time is not started (OcrDeferredError). */
  deadlineAt?: number;
}
export interface OcrResult { text: string; engine: OcrEngine; pagesOcrd: number; capped: boolean; note?: string }

/** The OCR slot was free only after the caller's time budget: nothing was run, the file should simply be tried again later. */
export class OcrDeferredError extends Error {
  constructor() { super("OCR deferred: the time budget ran out before the OCR engine was free"); }
}
/** The Vision helper cannot be built or run here (no swiftc, compile failure); the next engine, if any, is tried. */
class VisionUnavailableError extends Error {}

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_PAGES = 30;
const MAX_MAX_PAGES = 200;
const DEFAULT_MAX_BYTES = 30 * 1024 * 1024;
const HARD_MAX_BYTES = 50 * 1024 * 1024;
/** Engine output beyond this is a runaway process, not a document. */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const COMPILE_TIMEOUT_MS = 180_000;
const PDF_DPI = "200";
/** pdftoppm renders only this many pixels per side: a hostile page size cannot exhaust memory. */
const MAX_RENDER_PIXELS = "4000";
const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"]; // Claude Desktop starts servers with a minimal PATH
const LANGS_RE = /^[A-Za-z_+]+$/;

export const NO_ENGINE = "OCR is enabled (PROTON_DRIVE_OCR=1) but no OCR engine was found. Install one: on macOS the Xcode command line tools (`xcode-select --install`, gives the built-in Vision engine) or `brew install tesseract tesseract-lang`; on Linux `apt install tesseract-ocr tesseract-ocr-pol poppler-utils` (or your distribution's equivalent).";
const TESSERACT_HINT = "Install it with `brew install tesseract tesseract-lang` (macOS) or `apt install tesseract-ocr` (Linux).";

const envInt = (name: string, def: number, min: number, max: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(Math.floor(n), min), max) : def;
};

export function ocrEnabled(): boolean {
  const v = (process.env["PROTON_DRIVE_OCR"] ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}
/** Wall clock for one file, engine steps together: PROTON_DRIVE_OCR_TIMEOUT_MS, default 90 s. */
export const ocrTimeoutMs = (): number => envInt("PROTON_DRIVE_OCR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
/** PROTON_DRIVE_OCR_MAX_PAGES, default 30. */
export const ocrMaxPages = (): number => envInt("PROTON_DRIVE_OCR_MAX_PAGES", DEFAULT_MAX_PAGES, 1, MAX_MAX_PAGES);
/** Largest input OCR accepts, in bytes: PROTON_DRIVE_OCR_MAX_BYTES, default 30 MB, never above 50 MB. */
export const ocrMaxBytes = (): number => envInt("PROTON_DRIVE_OCR_MAX_BYTES", DEFAULT_MAX_BYTES, 1, HARD_MAX_BYTES);

/** PROTON_DRIVE_OCR_LANGS, e.g. "eng" or "eng+pol"; undefined when unset. Anything but letters, "_" and "+" is refused. */
export function ocrLanguages(): string | undefined {
  const v = (process.env["PROTON_DRIVE_OCR_LANGS"] ?? "").trim();
  if (v === "") return undefined;
  if (v.length > 64 || !LANGS_RE.test(v)) throw new Error("PROTON_DRIVE_OCR_LANGS must be language codes joined by +, for example eng or eng+pol (letters, _ and + only)");
  return v;
}

// ---- engine selection ---------------------------------------------------------------------------------------------------

/** Absolute path of an installed command: PATH first, then the usual Homebrew dirs. */
export function resolveTool(cmd: string): string | undefined {
  const dirs = (process.env["PATH"] ?? "").split(delimiter).filter((d) => d !== "" && isAbsolute(d));
  for (const d of [...dirs, ...EXTRA_BIN_DIRS]) {
    const p = join(d, cmd);
    try { accessSync(p, constants.X_OK); if (lstatSync(p).isDirectory()) continue; return p; } catch { /* not here */ }
  }
  return undefined;
}

/** Engines to try, in order. Pure apart from the lookups it is given. */
export function chooseEngines(o: { engine?: string; platform: NodeJS.Platform; which: (cmd: string) => string | undefined }): { engines: OcrEngine[] } | { error: string } {
  const want = (o.engine ?? "auto").trim().toLowerCase() || "auto";
  if (want !== "auto" && want !== "vision" && want !== "tesseract") return { error: `PROTON_DRIVE_OCR_ENGINE must be auto, vision or tesseract (got "${want.slice(0, 20)}")` };
  const vision = o.platform === "darwin" && o.which("swiftc") !== undefined;
  const tesseract = o.which("tesseract") !== undefined;
  if (want === "vision") return vision ? { engines: ["vision"] } : { error: "PROTON_DRIVE_OCR_ENGINE=vision needs macOS and swiftc (install the Xcode command line tools: `xcode-select --install`)." };
  if (want === "tesseract") return tesseract ? { engines: ["tesseract"] } : { error: `PROTON_DRIVE_OCR_ENGINE=tesseract but tesseract was not found. ${TESSERACT_HINT}` };
  const engines: OcrEngine[] = [];
  if (vision) engines.push("vision");
  if (tesseract) engines.push("tesseract");
  return engines.length ? { engines } : { error: NO_ENGINE };
}

const enginesFor = (deps: OcrDeps) => chooseEngines({ engine: process.env["PROTON_DRIVE_OCR_ENGINE"], platform: deps.platform ?? process.platform, which: deps.which ?? resolveTool });

// ---- which files OCR can read -------------------------------------------------------------------------------------------

const EXT_ALIAS: Record<string, string> = { png: "png", jpg: "jpg", jpeg: "jpg", tif: "tiff", tiff: "tiff", bmp: "bmp", webp: "webp", heic: "heic" };
const MEDIA_ALIAS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/tiff": "tiff", "image/bmp": "bmp", "image/webp": "webp", "image/heic": "heic", "image/heif": "heic",
};

/** Canonical extension of an image OCR can read with the available engines (heic only with Vision), else undefined. Not gated on PROTON_DRIVE_OCR. */
export function ocrImageExt(ext: string, mediaType: string, deps: OcrDeps = {}): string | undefined {
  const e = EXT_ALIAS[ext] ?? MEDIA_ALIAS[mediaType.toLowerCase().split(";")[0]!.trim()];
  if (!e) return undefined;
  if (e !== "heic") return e;
  const r = enginesFor(deps);
  return "engines" in r && r.engines.includes("vision") ? e : undefined;
}

/** A PDF's own text layer counts as missing below ~20 non-blank characters per page on average. */
export function isSparsePdfText(text: string, pages: number): boolean {
  return text.replace(/\s/g, "").length < 20 * Math.max(1, pages);
}

// ---- running an engine --------------------------------------------------------------------------------------------------

const slot = new Semaphore(1); // one OCR at a time per process: it is heavy on CPU and memory
const oneLine = (m: string) => (m.split("\n").find((l) => l.trim()) ?? m).trim().slice(0, 200);

interface ToolOpts { deadline: number; maxStdout?: number; what: string }

/**
 * Runs a command from an argument array (spawn, never a shell). Hard deadline, stdout cap, low priority, abort-aware; the child
 * leads its own process group, so on a timeout, an abort or too much output the whole tree is killed.
 */
export function runOcrTool(file: string, args: string[], o: ToolOpts): Promise<{ stdout: string; stderr: string }> {
  const signal = callContext.getStore()?.signal;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const remaining = o.deadline - Date.now();
    const timeoutError = () => new Error(`OCR timed out after ${ocrTimeoutMs() / 1000} s`);
    if (remaining <= 0) return reject(timeoutError());
    const cap = o.maxStdout ?? MAX_STDOUT_BYTES;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0, errBytes = 0;
    let timedOut = false, aborted = false, overflow = false, settled = false;
    const child = spawn(file, args, { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const untrackChild = trackChild(child);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, remaining);
    const onAbort = (): void => { aborted = true; killTree(child); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      untrackChild();
      fn();
    };
    child.stdout.on("data", (c: Buffer) => { outBytes += c.length; if (outBytes > cap) { overflow = true; killTree(child); } else out.push(c); });
    child.stderr.on("data", (c: Buffer) => { errBytes += c.length; if (errBytes <= 64 * 1024) err.push(c); }); // only the first line is ever shown
    child.on("error", (e) => finish(() => reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${o.what} was not found`) : new Error(`${o.what} could not be started`))));
    child.on("close", (code, sig) => finish(() => {
      if (timedOut) return reject(timeoutError());
      if (aborted) return reject(new Error("cancelled"));
      if (overflow) return reject(new Error(`${o.what} produced more output than expected`));
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0 && !sig) return resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr });
      reject(new Error(`${o.what} failed${stderr.trim() ? `: ${oneLine(stderr)}` : sig ? ` (${sig})` : ""}`));
    }));
    if (child.pid !== undefined) { try { setPriority(child.pid, 10); } catch { /* already gone or not allowed */ } }
  });
}

const swiftSource = (): string => fileURLToPath(new URL("../ocr/vision-ocr.swift", import.meta.url));
const compiling = new Map<string, Promise<string>>();

const trustedBinary = (p: string): boolean => {
  try {
    const st = lstatSync(p);
    return st.isFile() && (st.mode & 0o022) === 0 && (typeof process.getuid !== "function" || st.uid === process.getuid());
  } catch { return false; }
};

/** Compiles the Vision helper once (concurrent callers share the build) into the private cache dir; the name carries a hash of the source. */
async function visionBinary(swiftc: string): Promise<string> {
  let src: Buffer;
  try { src = readFileSync(swiftSource()); } catch { throw new VisionUnavailableError("the Vision OCR helper source is missing from this installation"); }
  const dir = indexDir();
  let ok = false;
  try { ok = ensurePrivateIndexDir(); } catch { /* reported below */ }
  if (!ok) throw new VisionUnavailableError(`${dir} must be a real directory owned by you with no group/other access (mode 0700); the Vision OCR helper is kept there (set PROTON_DRIVE_INDEX_DIR to another directory)`);
  const name = `vision-ocr-${createHash("sha256").update(src).digest("hex").slice(0, 16)}`;
  const bin = join(dir, name);
  if (trustedBinary(bin)) return bin;
  let job = compiling.get(bin);
  if (!job) {
    job = (async () => {
      const tmp = `${bin}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        await runOcrTool(swiftc, ["-O", swiftSource(), "-o", tmp], { deadline: Date.now() + COMPILE_TIMEOUT_MS, maxStdout: 1 << 20, what: "swiftc" });
        await chmod(tmp, 0o700);
        await rename(tmp, bin);
      } catch (e) {
        await unlink(tmp).catch(() => undefined);
        throw new VisionUnavailableError(`Could not compile the macOS Vision OCR helper (is Xcode or the Xcode command line tools installed? Try \`xcode-select --install\`): ${e instanceof Error ? oneLine(e.message) : String(e)}`);
      }
      for (const old of readdirSync(dir)) if (old.startsWith("vision-ocr-") && old !== name) await unlink(join(dir, old)).catch(() => undefined); // older versions of the helper
      return bin;
    })().finally(() => compiling.delete(bin));
    compiling.set(bin, job);
  }
  return job;
}

interface Job { input: string; ext: string; dir: string; deadline: number; maxChars: number; maxPages: number; langs: string | undefined; which: (cmd: string) => string | undefined }

const joinPages = (pages: string[], maxChars: number): { text: string; capped: boolean } => {
  const text = pages.map((p) => p.trim()).filter(Boolean).join("\n\n");
  return text.length > maxChars ? { text: text.slice(0, maxChars), capped: true } : { text, capped: false };
};

async function runVision(j: Job): Promise<OcrResult> {
  const swiftc = j.which("swiftc");
  if (!swiftc) throw new VisionUnavailableError("swiftc was not found (install the Xcode command line tools: `xcode-select --install`)");
  const bin = await visionBinary(swiftc);
  const { stdout } = await runOcrTool(bin, [j.input, String(j.maxPages), (j.langs ?? "").split("+").join(",")], { deadline: j.deadline, what: "The Vision OCR helper" });
  let out: { pages?: unknown; totalPages?: unknown };
  try { out = JSON.parse(stdout); } catch { throw new Error("The Vision OCR helper returned an unreadable answer"); }
  if (!Array.isArray(out.pages) || !out.pages.every((p) => p && typeof p.text === "string")) throw new Error("The Vision OCR helper returned an unreadable answer");
  const pages = out.pages as { text: string }[];
  const { text, capped } = joinPages(pages.map((p) => p.text), j.maxChars);
  const total = typeof out.totalPages === "number" ? out.totalPages : pages.length;
  return { text, engine: "vision", pagesOcrd: pages.length, capped, note: total > pages.length ? `OCR read the first ${pages.length} of ${total} pages (PROTON_DRIVE_OCR_MAX_PAGES)` : undefined };
}

async function runTesseract(j: Job): Promise<OcrResult> {
  const tesseract = j.which("tesseract");
  if (!tesseract) throw new Error(`tesseract was not found. ${TESSERACT_HINT}`);
  const lang = j.langs ?? "eng";
  const recognize = async (img: string): Promise<string> => (await runOcrTool(tesseract, [img, "stdout", "-l", lang], { deadline: j.deadline, what: "tesseract" })).stdout;
  let images = [j.input];
  let limited = false;
  if (j.ext === "pdf") {
    const pdftoppm = j.which("pdftoppm");
    if (!pdftoppm) throw new Error("pdftoppm was not found, so a PDF cannot be rasterized for tesseract. Install poppler: `brew install poppler` (macOS) or `apt install poppler-utils` (Linux).");
    await runOcrTool(pdftoppm, ["-r", PDF_DPI, "-png", "-f", "1", "-l", String(j.maxPages), "-W", MAX_RENDER_PIXELS, "-H", MAX_RENDER_PIXELS, j.input, join(j.dir, "pg")], { deadline: j.deadline, what: "pdftoppm" });
    images = (await readdir(j.dir)).filter((n) => /^pg-\d+\.png$/.test(n)).sort((a, b) => parseInt(a.slice(3), 10) - parseInt(b.slice(3), 10)).map((n) => join(j.dir, n));
    limited = images.length >= j.maxPages;
  }
  const texts: string[] = [];
  let chars = 0;
  for (const img of images) {
    const t = await recognize(img);
    texts.push(t);
    chars += t.length;
    if (chars >= j.maxChars) break;
  }
  const { text, capped } = joinPages(texts, j.maxChars);
  return { text, engine: "tesseract", pagesOcrd: texts.length, capped, note: limited ? `OCR read at most the first ${j.maxPages} pages (PROTON_DRIVE_OCR_MAX_PAGES)` : undefined };
}

/**
 * Recognizes the text of a PDF (ext "pdf") or an image (ext from ocrImageExt). The bytes go into a private temp dir under a fixed
 * name (`in.<ext>`, an absolute path that never starts with "-" and never contains anything from Drive), the dir is removed afterwards.
 */
export async function ocrBuffer(buf: Buffer, ext: string, maxChars: number, deps: OcrDeps = {}): Promise<OcrResult> {
  if (ext !== "pdf" && !Object.values(EXT_ALIAS).includes(ext)) throw new Error("OCR: unsupported input type");
  const r = enginesFor(deps);
  if ("error" in r) throw new Error(r.error);
  const langs = ocrLanguages();
  const signal = callContext.getStore()?.signal;
  const release = await slot.acquire(signal);
  try {
    if (deps.deadlineAt !== undefined && Date.now() >= deps.deadlineAt) throw new OcrDeferredError();
    const dir = await mkdtemp(join(tmpdir(), "pdmcp-ocr-")); // mode 0700
    registerTempDir(dir);
    try {
      const input = join(dir, `in.${ext}`);
      if (!isAbsolute(input)) throw new Error("OCR: the temp directory is not absolute");
      await writeFile(input, buf, { mode: 0o600, flag: "wx" });
      const job: Job = { input, ext, dir, deadline: Date.now() + ocrTimeoutMs(), maxChars, maxPages: ocrMaxPages(), langs, which: deps.which ?? resolveTool };
      for (let i = 0; i < r.engines.length; i++) {
        try {
          return await (r.engines[i] === "vision" ? runVision(job) : runTesseract(job));
        } catch (e) {
          if (!(e instanceof VisionUnavailableError)) throw e;
          if (i === r.engines.length - 1) throw new Error(e.message);
        }
      }
      throw new Error(NO_ENGINE);
    } finally {
      await rm(dir, { recursive: true, force: true });
      unregisterTempDir(dir);
    }
  } finally {
    release();
  }
}
