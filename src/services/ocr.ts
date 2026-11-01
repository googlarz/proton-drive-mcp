import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, readdirSync } from "node:fs";
import { chmod, mkdtemp, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { setPriority, tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerTempDir, unregisterTempDir } from "../utils/tempDirs.js";
import { callContext, killTree, trackChild } from "../utils/subprocess.js";
import { Semaphore } from "../utils/semaphore.js";
import { ensurePrivateIndexDir, indexDir } from "./walkIndex.js";
import { logger } from "../utils/logger.js";

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
const DEFAULT_MAX_MB = 30;
const HARD_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_PIXELS = 100_000_000;
const MAX_MAX_PIXELS = 1_000_000_000;
/** Engine output beyond this is a runaway process, not a document. */
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const COMPILE_TIMEOUT_MS = 180_000;
const PDF_DPI = 200;
/** A rendered PDF page is at most this many pixels on its long side: a huge page is scaled down (never cropped), so a hostile page size cannot exhaust memory. */
const MAX_RENDER_SIDE = 4000;
/** The first run of a newly built Vision helper (macOS prepares its model) is allowed this long; it never counts against a file's timeout. */
const WARMUP_TIMEOUT_MS = 180_000;
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
/** Largest image or scanned PDF OCR accepts, in bytes: PROTON_DRIVE_OCR_MAX_MB (megabytes, may be fractional), default 30, never above 50. Independent of the 10 MB read cap. */
export const ocrMaxBytes = (): number => {
  const mb = Number(process.env["PROTON_DRIVE_OCR_MAX_MB"]);
  return Number.isFinite(mb) && mb > 0 ? Math.min(Math.max(Math.floor(mb * 1048576), 1), HARD_MAX_BYTES) : DEFAULT_MAX_MB * 1048576;
};
/** Largest image OCR accepts in pixels (width x height): PROTON_DRIVE_OCR_MAX_PIXELS, default 100 million. */
export const ocrMaxPixels = (): number => envInt("PROTON_DRIVE_OCR_MAX_PIXELS", DEFAULT_MAX_PIXELS, 1, MAX_MAX_PIXELS);

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

// ---- image size, from the header only -----------------------------------------------------------------------------------

type Dims = { width: number; height: number };

function jpegDims(b: Buffer): Dims | undefined {
  let i = 2;
  for (let n = 0; n < 1000 && i + 4 <= b.length; n++) {
    if (b[i] !== 0xff) return undefined;
    const m = b[i + 1]!;
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; } // markers without a length
    if (m === 0xd9 || m === 0xda) return undefined; // end of image / start of scan: no frame header was found
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return undefined;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return undefined;
}

function tiffDims(b: Buffer): Dims | undefined {
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (!le && !(b[0] === 0x4d && b[1] === 0x4d)) return undefined;
  const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u16(2) !== 42) return undefined; // classic TIFF only
  const ifd = u32(4);
  const count = Math.min(u16(ifd), 256);
  let width: number | undefined, height: number | undefined;
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + 12 * i;
    const tag = u16(e), type = u16(e + 2);
    const v = type === 3 ? u16(e + 8) : type === 4 ? u32(e + 8) : undefined;
    if (tag === 256) width = v; else if (tag === 257) height = v;
  }
  return width !== undefined && height !== undefined ? { width, height } : undefined;
}

function webpDims(b: Buffer): Dims | undefined {
  const kind = b.toString("latin1", 12, 16);
  if (kind === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return undefined;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return undefined;
}

/**
 * The size an image declares in its header (PNG, JPEG, GIF, BMP, TIFF, WebP), read without decoding anything.
 * undefined = unknown format, damaged or truncated header, a size of zero, or HEIC (which Vision checks itself).
 */
export function imageDimensions(b: Buffer): Dims | undefined {
  try {
    let d: Dims | undefined;
    const head = b.toString("latin1", 0, 6);
    if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString("latin1", 12, 16) === "IHDR") d = { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    else if (b[0] === 0xff && b[1] === 0xd8) d = jpegDims(b);
    else if (head === "GIF87a" || head === "GIF89a") d = { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    else if (b[0] === 0x42 && b[1] === 0x4d) {
      const size = b.readUInt32LE(14);
      d = size === 12 ? { width: b.readUInt16LE(18), height: b.readUInt16LE(20) } : size >= 40 ? { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) } : undefined;
    } else if (head.startsWith("RIFF") && b.toString("latin1", 8, 12) === "WEBP") d = webpDims(b);
    else d = tiffDims(b);
    return d && d.width > 0 && d.height > 0 ? d : undefined;
  } catch {
    return undefined; // a header cut short
  }
}

const megapixels = (px: number): string => String(Number((px / 1e6).toFixed(3)));

/** Refuses an image above PROTON_DRIVE_OCR_MAX_PIXELS, or whose size cannot be read (formats we parse fail closed), before any engine sees it. */
function checkPixels(buf: Buffer, ext: string): void {
  const d = imageDimensions(buf);
  if (!d) {
    if (ext === "heic") return; // HEIC: left to the Vision helper, which applies the same limit to the decoded size
    throw new Error("OCR refused: the image size could not be determined (unsupported or damaged image header)");
  }
  const limit = ocrMaxPixels();
  if (d.width * d.height > limit) throw new Error(`OCR refused: the image is ${d.width} x ${d.height} pixels (${megapixels(d.width * d.height)} megapixels), over the limit of ${megapixels(limit)} megapixels (PROTON_DRIVE_OCR_MAX_PIXELS)`);
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
const PRUNE_AFTER_MS = 3_600_000;

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
      // Older versions of the helper go, but only finished binaries last touched over an hour ago: another process may still use one,
      // and a .tmp file is somebody's build in progress.
      const cutoff = Date.now() - PRUNE_AFTER_MS;
      for (const old of readdirSync(dir)) {
        if (!/^vision-ocr-[0-9a-f]{16}$/.test(old) || old === name) continue;
        try { if (lstatSync(join(dir, old)).mtimeMs < cutoff) await unlink(join(dir, old)); } catch { /* gone or not ours to remove */ }
      }
      return bin;
    })().finally(() => compiling.delete(bin));
    compiling.set(bin, job);
  }
  return job;
}

// A freshly built helper is slow on its first run (macOS prepares its Vision model per binary: ~25 s). That run is made once, on a tiny
// blank image, before a file's timeout starts, so neither the build nor the preparation counts against any file.
const preparing = new Map<string, Promise<string>>();
const prepared = new Set<string>();

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** An 8 x 8 white PNG, generated here: no user data is ever read for the warm-up. */
function blankPng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; // 8 bits, grayscale
  const rows = Buffer.alloc(8 * 9, 0xff); // per row: filter byte, then 8 pixels
  for (let r = 0; r < 8; r++) rows[r * 9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

async function warmHelper(bin: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pdmcp-ocr-"));
  registerTempDir(dir);
  try {
    const input = join(dir, "warm.png");
    await writeFile(input, blankPng(), { mode: 0o600, flag: "wx" });
    await runOcrTool(bin, [input, "1", "", String(ocrMaxPixels())], { deadline: Date.now() + WARMUP_TIMEOUT_MS, what: "The Vision OCR helper" });
  } catch (e) {
    logger.debug("Vision OCR helper warm-up failed:", e instanceof Error ? oneLine(e.message) : String(e)); // the real read reports its own error
  } finally {
    await rm(dir, { recursive: true, force: true });
    unregisterTempDir(dir);
  }
}

/** The compiled helper, after its one-time warm-up (concurrent callers share it). */
async function readyVisionBinary(swiftc: string): Promise<string> {
  const bin = await visionBinary(swiftc);
  if (prepared.has(bin)) return bin;
  let job = preparing.get(bin);
  if (!job) {
    job = warmHelper(bin).then(() => { prepared.add(bin); return bin; }).finally(() => preparing.delete(bin));
    preparing.set(bin, job);
  }
  return job;
}

interface Job { input: string; ext: string; dir: string; /** Set by the engine once it is ready to read: the file's timeout starts then. */ deadline: number; maxChars: number; maxPages: number; langs: string | undefined; which: (cmd: string) => string | undefined }

const joinPages = (pages: string[], maxChars: number): { text: string; capped: boolean } => {
  const text = pages.map((p) => p.trim()).filter(Boolean).join("\n\n");
  return text.length > maxChars ? { text: text.slice(0, maxChars), capped: true } : { text, capped: false };
};

async function runVision(j: Job): Promise<OcrResult> {
  const swiftc = j.which("swiftc");
  if (!swiftc) throw new VisionUnavailableError("swiftc was not found (install the Xcode command line tools: `xcode-select --install`)");
  const bin = await readyVisionBinary(swiftc);
  j.deadline = Date.now() + ocrTimeoutMs();
  const { stdout } = await runOcrTool(bin, [j.input, String(j.maxPages), (j.langs ?? "").split("+").join(","), String(ocrMaxPixels())], { deadline: j.deadline, what: "The Vision OCR helper" });
  let out: { pages?: unknown; totalPages?: unknown };
  try { out = JSON.parse(stdout); } catch { throw new Error("The Vision OCR helper returned an unreadable answer"); }
  if (!Array.isArray(out.pages) || !out.pages.every((p) => p && typeof p.text === "string")) throw new Error("The Vision OCR helper returned an unreadable answer");
  const pages = out.pages as { text: string }[];
  const { text, capped } = joinPages(pages.map((p) => p.text), j.maxChars);
  const total = typeof out.totalPages === "number" ? out.totalPages : pages.length;
  return { text, engine: "vision", pagesOcrd: pages.length, capped, note: total > pages.length ? `OCR read the first ${pages.length} of ${total} pages (PROTON_DRIVE_OCR_MAX_PAGES)` : undefined };
}

/**
 * pdftoppm arguments that keep a page within MAX_RENDER_SIDE pixels by scaling it, never by cropping. With pdfinfo the dpi is lowered just
 * enough for the largest page; without it every page is scaled to that long side.
 */
async function pageSizeArgs(j: Job): Promise<{ r: [string]; scaleTo: string[] }> {
  const pdfinfo = j.which("pdfinfo");
  if (pdfinfo) {
    try {
      const { stdout } = await runOcrTool(pdfinfo, ["-f", "1", "-l", String(j.maxPages), j.input], { deadline: j.deadline, what: "pdfinfo" });
      let side = 0;
      for (const m of stdout.matchAll(/^Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm)) side = Math.max(side, Number(m[1]), Number(m[2]));
      if (side > 0 && Number.isFinite(side)) return { r: [String(Math.max(1, Math.min(PDF_DPI, Math.floor((MAX_RENDER_SIDE * 72) / side))))], scaleTo: [] };
    } catch (e) {
      if (e instanceof Error && e.message === "cancelled") throw e;
      // pdfinfo could not read it: fall back to scaling every page
    }
  }
  return { r: [String(PDF_DPI)], scaleTo: ["-scale-to", String(MAX_RENDER_SIDE)] };
}

async function runTesseract(j: Job): Promise<OcrResult> {
  const tesseract = j.which("tesseract");
  if (!tesseract) throw new Error(`tesseract was not found. ${TESSERACT_HINT}`);
  j.deadline = Date.now() + ocrTimeoutMs();
  const lang = j.langs ?? "eng";
  const recognize = async (img: string): Promise<string> => (await runOcrTool(tesseract, [img, "stdout", "-l", lang], { deadline: j.deadline, what: "tesseract" })).stdout;
  let images = [j.input];
  let limited = false;
  if (j.ext === "pdf") {
    const pdftoppm = j.which("pdftoppm");
    if (!pdftoppm) throw new Error("pdftoppm was not found, so a PDF cannot be rasterized for tesseract. Install poppler: `brew install poppler` (macOS) or `apt install poppler-utils` (Linux).");
    const size = await pageSizeArgs(j);
    await runOcrTool(pdftoppm, ["-r", ...size.r, "-png", "-f", "1", "-l", String(j.maxPages), ...size.scaleTo, j.input, join(j.dir, "pg")], { deadline: j.deadline, what: "pdftoppm" });
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
  if (ext !== "pdf") checkPixels(buf, ext); // before any engine, and before anything is written
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
      const job: Job = { input, ext, dir, deadline: 0, maxChars, maxPages: ocrMaxPages(), langs, which: deps.which ?? resolveTool };
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

/** Throws the one clear error a missing engine or an invalid PROTON_DRIVE_OCR_LANGS would cause for every single file. */
export function ocrPreflight(deps: OcrDeps = {}): void {
  const r = enginesFor(deps);
  if ("error" in r) throw new Error(r.error);
  ocrLanguages();
}

/**
 * Builds and warms the Vision helper in the background (call shortly after server start when PROTON_DRIVE_OCR=1), so the first
 * read does not pay for it. Reads no user data, never throws, does nothing for other engines.
 */
export async function warmUpOcr(deps: OcrDeps = {}): Promise<void> {
  try {
    if (!ocrEnabled()) return;
    const r = enginesFor(deps);
    if ("error" in r || r.engines[0] !== "vision") return;
    const swiftc = (deps.which ?? resolveTool)("swiftc");
    if (swiftc) await readyVisionBinary(swiftc);
  } catch (e) {
    logger.debug("OCR warm-up skipped:", e instanceof Error ? oneLine(e.message) : String(e));
  }
}
