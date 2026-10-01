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
export const INDEX_VERSION = 1;
export const MAX_ENTRIES = 8;
export const MAX_BYTES = 200 * 1024 * 1024;
const FILE_NAME = "walk-index.json";

export interface IndexEntry {
  key: string;
  root: string;
  opts: { maxDepth?: number; maxCalls: number; exclude: string[] };
  completedAt: number;
  nodes: WalkNode[];
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

const lstatOrNull = (p: string) => { try { return lstatSync(p); } catch { return null; } };

const FUTURE_SKEW_MS = 5 * 60_000;
const foreignOrLoose = (st: { uid: number; mode: number }) =>
  (typeof process.getuid === "function" && st.uid !== process.getuid()) || (st.mode & 0o077) !== 0;

/** Reads and validates the index; anything wrong (missing, symlink, loose mode, foreign owner, oversize, corrupt, other version) is "no index". */
export function readIndex(o: { requireWritable?: boolean } = {}): IndexFile | undefined {
  const p = indexPath();
  const dst = lstatOrNull(indexDir());
  if (!dst || !dst.isDirectory()) return undefined;
  if (o.requireWritable) {
    // Data we cannot keep current (a read-only directory can neither be rewritten nor cleared after our own
    // writes) must not be served: a trashed or moved item would reappear in the next process.
    try { accessSync(indexDir(), constants.W_OK); accessSync(p, constants.W_OK); } catch { return undefined; }
  }
  let fd: number | undefined;
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW); // a symlink is never followed
    const st = fstatSync(fd);
    if (!st.isFile() || foreignOrLoose(st) || st.size > MAX_BYTES) return undefined; // checked before reading
    const j = JSON.parse(readFileSync(fd, "utf8")) as Partial<IndexFile> | null;
    if (!j || j.version !== INDEX_VERSION || typeof j.accountKey !== "string" || !Array.isArray(j.entries)) return undefined;
    const horizon = Date.now() + FUTURE_SKEW_MS;
    const ok = j.entries.every((e) => e && typeof e.key === "string" && typeof e.root === "string" && Number.isFinite(e.completedAt) && e.completedAt <= horizon && Array.isArray(e.nodes) && e.opts && Array.isArray(e.opts.exclude));
    return ok ? (j as IndexFile) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

let warnedSize = false;
const warnedDirs = new Set<string>();

/** Atomic write. Never throws; the result says what happened. */
export function writeIndex(file: IndexFile, o: { maxBytes?: number } = {}): "ok" | "disabled" | "refused" | "too-large" | "error" {
  if (!indexEnabled()) return "disabled";
  const dir = indexDir();
  let tmp: string | undefined;
  try {
    const trimmed: IndexFile = { ...file, entries: [...file.entries].sort((a, b) => b.completedAt - a.completedAt).slice(0, MAX_ENTRIES) };
    const body = JSON.stringify(trimmed);
    if (Buffer.byteLength(body) > (o.maxBytes ?? MAX_BYTES)) {
      if (!warnedSize) { warnedSize = true; logger.warn("Persistent walk index not saved: it would exceed the size cap."); }
      return "too-large";
    }
    const existing = lstatOrNull(dir);
    if (existing) {
      // Never chmod or take over a directory this code did not create.
      if (!existing.isDirectory() || foreignOrLoose(existing)) {
        if (!warnedDirs.has(dir)) {
          warnedDirs.add(dir);
          logger.warn(`Persistent walk index not saved: ${dir} must be a real directory owned by you with no group/other access (mode 0700). Use a dedicated directory.`);
        }
        return "refused";
      }
    } else {
      mkdirSync(dirname(dir), { recursive: true });
      mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700); // umask-proof; safe because we just created it
      const made = lstatSync(dir);
      if (!made.isDirectory() || foreignOrLoose(made)) return "refused";
    }
    const target = join(dir, FILE_NAME);
    const tst = lstatOrNull(target);
    if (tst && !tst.isFile()) return "refused"; // symlink or directory in the way
    tmp = join(dir, `${FILE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(tmp, "wx", 0o600); // O_EXCL: never follows a pre-planted link
    try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
    tmp = undefined;
    const fin = lstatSync(target);
    if (!fin.isFile() || (fin.mode & 0o077) !== 0) { try { unlinkSync(target); } catch { /* best effort */ } return "refused"; }
    return "ok";
  } catch (err) {
    logger.warn("Persistent walk index write failed:", err instanceof Error ? err.message : String(err));
    return "error";
  } finally {
    if (tmp) { try { unlinkSync(tmp); } catch { /* already gone */ } }
  }
}

/** Deletes the index file (a symlink is removed itself, never followed). */
export function deleteIndex(): { path: string; deleted: boolean; bytes: number } {
  const path = indexPath();
  const st = lstatOrNull(path);
  if (!st) return { path, deleted: false, bytes: 0 };
  try { unlinkSync(path); return { path, deleted: true, bytes: st.size }; } catch { return { path, deleted: false, bytes: 0 }; }
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
