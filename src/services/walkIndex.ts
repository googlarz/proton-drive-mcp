import { accessSync, chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { WalkNode } from "./walk.js";
import { logger } from "../utils/logger.js";

/**
 * Opt-in on-disk copy of completed Drive walks (PROTON_DRIVE_INDEX=1). It holds
 * file names, paths and hashes of an end-to-end-encrypted drive in PLAINTEXT, so
 * it is off by default; the file is 0600 in a 0700 directory that this code created or that was already private to the user.
 */
export const INDEX_VERSION = 2; // 2 adds per-folder listing times (and partial entries); version 1 files are still read
export const MAX_ENTRIES = 8;
export const MAX_BYTES = 200 * 1024 * 1024;
const FILE_NAME = "walk-index.json";

export interface IndexEntry {
  key: string;
  root: string;
  opts: { maxDepth?: number; maxCalls: number; exclude: string[] };
  /** When the entry was last written; the tree's age is the oldest value of `listed` (or this, for entries without it). */
  completedAt: number;
  nodes: WalkNode[];
  /**
   * Folder path -> ms its listing was read, for every listed folder. A folder node without a value was never listed (an
   * unfinished refresh), so the entry is only a partial tree. Absent in version 1 files: those saved complete walks only,
   * so every folder counts as listed at completedAt.
   */
  listed?: Record<string, number>;
}
export interface IndexFile { version: number; accountKey: string; savedAt: number; entries: IndexEntry[] }

export function indexEnabled(): boolean {
  const v = (process.env.PROTON_DRIVE_INDEX ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export function indexDir(): string {
  const d = process.env.PROTON_DRIVE_INDEX_DIR;
  if (d && d.trim()) return d;
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "proton-drive-mcp");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "proton-drive-mcp");
}
export const indexPath = () => join(indexDir(), FILE_NAME);

/** Max age of disk data we will serve, ms (PROTON_DRIVE_INDEX_MAX_AGE_H, default 24 h; 0 disables use). */
export function indexMaxAgeMs(): number {
  const h = Number(process.env.PROTON_DRIVE_INDEX_MAX_AGE_H ?? 24);
  return (Number.isFinite(h) && h >= 0 ? h : 24) * 3_600_000;
}

/** Max age of a saved folder listing an incremental refresh reuses, ms (PROTON_DRIVE_INDEX_FOLDER_MAX_AGE_H, default 24; 0 = reuse none). */
export function folderMaxAgeMs(): number {
  const h = Number(process.env.PROTON_DRIVE_INDEX_FOLDER_MAX_AGE_H ?? 24);
  return (Number.isFinite(h) && h >= 0 ? h : 24) * 3_600_000;
}

const lstatOrNull = (p: string) => { try { return lstatSync(p); } catch { return null; } };

const FUTURE_SKEW_MS = 5 * 60_000;
const foreignOrLoose = (st: { uid: number; mode: number }) =>
  (typeof process.getuid === "function" && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0;

/** Reads a JSON file from the private index directory; anything wrong (missing, symlink, loose mode, foreign owner, oversize, corrupt) is undefined. */
export function readPrivateJson(fileName: string, maxBytes = MAX_BYTES): unknown {
  const p = join(indexDir(), fileName);
  const dst = lstatOrNull(indexDir());
  if (!dst || !dst.isDirectory()) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW); // a symlink is never followed
    const st = fstatSync(fd);
    if (!st.isFile() || foreignOrLoose(st) || st.size > maxBytes) return undefined; // checked before reading
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

const validListed = (l: unknown): boolean =>
  l === undefined || (typeof l === "object" && l !== null && !Array.isArray(l) && Object.values(l).every((t) => typeof t === "number" && Number.isFinite(t)));

/** Reads and validates the index; anything wrong (missing, symlink, loose mode, foreign owner, oversize, corrupt, other version) is "no index". */
export function readIndex(o: { requireWritable?: boolean } = {}): IndexFile | undefined {
  if (o.requireWritable) {
    // Data we cannot keep current (a read-only directory can neither be rewritten nor cleared after our own
    // writes) must not be served: a trashed or moved item would reappear in the next process.
    try { accessSync(indexDir(), constants.W_OK); accessSync(indexPath(), constants.W_OK); } catch { return undefined; }
  }
  const j = readPrivateJson(FILE_NAME) as Partial<IndexFile> | null | undefined;
  if (!j || (j.version !== INDEX_VERSION && j.version !== 1) || typeof j.accountKey !== "string" || !Array.isArray(j.entries)) return undefined;
  const horizon = Date.now() + FUTURE_SKEW_MS;
  const ok = j.entries.every((e) => e && typeof e.key === "string" && typeof e.root === "string" && Number.isFinite(e.completedAt) && e.completedAt <= horizon && Array.isArray(e.nodes) && e.opts && Array.isArray(e.opts.exclude) && validListed(e.listed));
  if (!ok) return undefined;
  // A listing time ahead of the clock (it moved back) cannot be trusted: it counts as old.
  for (const e of j.entries) if (e.listed) for (const k of Object.keys(e.listed)) if (e.listed[k]! > horizon) e.listed[k] = 0;
  return j as IndexFile;
}

let warnedSize = false;
const warnedDirs = new Set<string>();

/** Thrown by a writePrivateStream callback that hit its size cap; the temp file is discarded. */
export class TooLargeError extends Error {}

/**
 * Creates the private index directory (0700) when missing; false when it exists but is not a real directory owned by you
 * with no group/other access. Never chmods or takes over a directory this code did not create.
 */
export function ensurePrivateIndexDir(): boolean {
  const dir = indexDir();
  const existing = lstatOrNull(dir);
  if (existing) {
    if (!existing.isDirectory() || foreignOrLoose(existing)) {
      if (!warnedDirs.has(dir)) {
        warnedDirs.add(dir);
        logger.warn(`Persistent walk index not saved: ${dir} must be a real directory owned by you with no group/other access (mode 0700). Use a dedicated directory.`);
      }
      return false;
    }
    return true;
  }
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700); // umask-proof; safe because we just created it
  const made = lstatSync(dir);
  return made.isDirectory() && !foreignOrLoose(made);
}

/**
 * Atomic 0600 write into the private index directory: `fill` writes the content to the temp file's descriptor (it may
 * throw TooLargeError), then the file is fsynced and renamed over the target. Never throws; the result says what happened.
 */
export function writePrivateStream(fileName: string, fill: (fd: number) => void): "ok" | "too-large" | "refused" | "error" {
  const dir = indexDir();
  let tmp: string | undefined;
  try {
    if (!ensurePrivateIndexDir()) return "refused";
    const target = join(dir, fileName);
    const tst = lstatOrNull(target);
    if (tst && !tst.isFile()) return "refused"; // symlink or directory in the way
    tmp = join(dir, `${fileName}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(tmp, "wx", 0o600); // O_EXCL: never follows a pre-planted link
    try { fill(fd); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
    tmp = undefined;
    const fin = lstatSync(target);
    if (!fin.isFile() || (fin.mode & 0o077) !== 0) { try { unlinkSync(target); } catch { /* best effort */ } return "refused"; }
    return "ok";
  } catch (err) {
    if (err instanceof TooLargeError) return "too-large";
    logger.warn("Persistent walk index write failed:", err instanceof Error ? err.message : String(err));
    return "error";
  } finally {
    if (tmp) { try { unlinkSync(tmp); } catch { /* already gone */ } }
  }
}

/** Atomic 0600 write of `body` into the private index directory. Never throws; the result says what happened. */
export function writePrivateFile(fileName: string, body: string, maxBytes = MAX_BYTES): "ok" | "too-large" | "refused" | "error" {
  if (Buffer.byteLength(body) > maxBytes) return "too-large";
  return writePrivateStream(fileName, (fd) => { writeSync(fd, body); });
}

/**
 * Opens a file of the private index directory for reading (a symlink is never followed). undefined = it does not exist.
 * Throws when it exists but is unsafe (not a regular file, foreign owner, group/other access, over maxBytes), so a caller
 * that must not silently ignore it can say so. The caller closes the descriptor.
 */
export function openPrivateRead(fileName: string, maxBytes: number): { fd: number; size: number } | undefined {
  const p = join(indexDir(), fileName);
  if (!lstatOrNull(p)) return undefined;
  const dst = lstatOrNull(indexDir());
  if (!dst || !dst.isDirectory() || foreignOrLoose(dst)) throw new Error(`${indexDir()} must be a real directory owned by you with no group/other access (mode 0700)`);
  let fd: number | undefined;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || foreignOrLoose(st)) throw new Error(`${p} must be a regular file owned by you with no group/other access (mode 0600)`);
    if (st.size > maxBytes) throw new Error(`${p} is ${st.size} bytes, over the size cap of ${maxBytes} bytes`);
    return { fd, size: st.size };
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    throw err;
  }
}

/** Atomic write. Never throws; the result says what happened. */
export function writeIndex(file: IndexFile, o: { maxBytes?: number } = {}): "ok" | "disabled" | "refused" | "too-large" | "error" {
  if (!indexEnabled()) return "disabled";
  const trimmed: IndexFile = { ...file, entries: [...file.entries].sort((a, b) => b.completedAt - a.completedAt).slice(0, MAX_ENTRIES) };
  const r = writePrivateFile(FILE_NAME, JSON.stringify(trimmed), o.maxBytes);
  if (r === "too-large" && !warnedSize) { warnedSize = true; logger.warn("Persistent walk index not saved: it would exceed the size cap."); }
  return r;
}

/** Deletes the index file (a symlink is removed itself, never followed). */
export function deleteIndex(): { path: string; deleted: boolean; bytes: number } {
  const path = indexPath();
  const st = lstatOrNull(path);
  if (!st) return { path, deleted: false, bytes: 0 };
  try { unlinkSync(path); return { path, deleted: true, bytes: st.size }; } catch { return { path, deleted: false, bytes: 0 }; }
}

/** Deletes another private file of this directory (a symlink is removed itself, never followed). */
export function deletePrivateFile(fileName: string): boolean {
  const p = join(indexDir(), fileName);
  if (!lstatOrNull(p)) return false;
  try { unlinkSync(p); return true; } catch { return false; }
}

export function indexStatus() {
  const path = indexPath();
  const st = lstatOrNull(path);
  const base = { enabled: indexEnabled(), path, maxAgeHours: indexMaxAgeMs() / 3_600_000 };
  if (!st) return { ...base, exists: false as const };
  const idx = readIndex();
  return {
    ...base, exists: true as const, bytes: st.size, valid: !!idx,
    ...(idx ? {
      savedAt: new Date(idx.savedAt).toISOString(), ageMs: Date.now() - idx.savedAt,
      entries: idx.entries.map((e) => ({ root: e.root, nodes: e.nodes.length, completedAt: new Date(e.completedAt).toISOString() })),
    } : { entries: [] as { root: string; nodes: number; completedAt: string }[] }),
  };
}
