import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomInt, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Undo journal (1.12.0, PLAN-1.12.0 section 3.6): a local record of what a trash / move / rename batch
 * changed, so `drive_undo` can put it back. One file per batch: <dir>/<id>.json, folder 0700, files 0600.
 *
 * Like the approval store (approvalStore.ts) the API is SYNCHRONOUS, writes are atomic (temp file in
 * <dir>/tmp created with O_EXCL, then link/rename), symlinked folders and records are refused, and a
 * corrupt file is ignored, never thrown on. POSIX semantics are assumed (macOS, Linux).
 *
 * Account key: pass the key the change snapshots use. In src/services/changes.ts that is
 * `await currentAccountKey(drive)` (exported from src/services/walk.ts): a fingerprint of the account
 * root listing, `undefined` when the account cannot be identified. W1 must skip journalling (and say so)
 * when it is undefined; this module needs a non-empty string and throws otherwise. get()/list() hide
 * batches written under another key.
 *
 * Contains the names of items the user changed, in plain text (same precedent as approval summaries).
 * The id is an identifier shown to the human, not a secret.
 */

export type UndoKind = "trash" | "move" | "rename";
/** `partial` after complete(): some items failed and were left out. After markUndone(): some items were not restored. */
export type UndoStatus = "pending" | "applied" | "partial" | "undone";

export interface UndoItem {
  uid: string;
  /** Uid of the folder the item lived in before the change. */
  parentUid?: string;
  /** Path before the change. */
  from: string;
  /** Path after the change (move / rename; for trash the trash location if known). */
  to?: string;
  name: string;
  size?: number;
  /** false when the item cannot be put back reliably (for example its name is already in trash, see 3.5). */
  restorable: boolean;
  reason?: string;
}

export interface UndoBatch {
  v: 1;
  id: string;
  account: string;
  createdAt: number;
  tool: string;
  kind: UndoKind;
  status: UndoStatus;
  items: UndoItem[];
}

/** What list() returns: no file names. */
export interface UndoSummary {
  id: string;
  createdAt: number;
  tool: string;
  kind: UndoKind;
  status: UndoStatus;
  itemCount: number;
}

export interface UndoJournalOptions {
  dir: string;
  account: string;
  now?: () => number;
  /** Default 30 days. */
  maxAgeMs?: number;
  /** Default 50, per account and per class: bulk and single-item batches each have this many slots. */
  maxBatches?: number;
  /** Default true. Pass `undoEnabled(process.env)`; false gives the no-op journal (begin returns null, nothing touches disk). */
  enabled?: boolean;
}

export interface UndoJournal {
  /** false for the no-op journal. */
  readonly enabled: boolean;
  /**
   * Writes a `pending` batch and returns its id; null when journalling is disabled.
   * Throws on invalid input or when the folder cannot be used safely (the caller decides whether to go on without undo).
   */
  begin(p: { tool: string; kind: UndoKind; items: UndoItem[] }): { id: string } | null;
  /**
   * Finishes a pending batch. With `succeededUids` only those items are kept; when that drops any item the status is
   * forced to "partial". A batch left with no items is removed (nothing to undo). Returns false when the batch is
   * unknown, hidden (other account) or not `pending`. Throws on a malformed id.
   */
  complete(id: string, p: { succeededUids?: string[]; status: "applied" | "partial" }): boolean;
  /** Newest first. Expired and other-account batches are not listed. */
  list(): UndoSummary[];
  /** Full batch, or null when unknown, expired, corrupt, wrong schema version or another account. Throws only on a malformed id. */
  get(id: string): UndoBatch | null;
  /**
   * Marks a batch undone (default) or partially undone. Returns false when the batch is unknown / hidden or is
   * already `undone` (a second undo is refused). Allowed from pending, applied and partial. Throws on a malformed id.
   * The check-and-write is not atomic across processes; the real guard against a double restore is the uid check in the engine.
   */
  markUndone(id: string, status?: "undone" | "partial"): boolean;
  /**
   * Removes batches older than maxAgeMs and, per account, all but the newest maxBatches bulk and the newest maxBatches single-item
   * batches; returns how many files it removed.
   */
  purge(): number;
}

/** Same alphabet and shape as approval codes: no I, L, O, 0, 1. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ID_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;
const FILE_RE = /^([ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4})\.json$/;
const MAX_FILE_BYTES = 5_000_000;
const MAX_ITEMS = 5000;
const TMP_KEEP_MS = 3_600_000;
const DAY_MS = 86_400_000;
const KINDS: readonly string[] = ["trash", "move", "rename"];
const STATUSES: readonly string[] = ["pending", "applied", "partial", "undone"];

/** PROTON_DRIVE_UNDO_DIR, else `undo/` next to the approvals folder (same private cache dir as resolveApprovalDir). */
export function resolveUndoDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  const o = env.PROTON_DRIVE_UNDO_DIR;
  if (o && o.trim()) return resolve(o.trim());
  if (platform === "darwin") return join(home, "Library", "Caches", "proton-drive-mcp", "undo");
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "proton-drive-mcp", "undo");
}

/** PROTON_DRIVE_UNDO=0 (also "false", "off", "no") switches journalling off; anything else leaves it on. */
export function undoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.PROTON_DRIVE_UNDO ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

const uid = process.getuid?.();
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Creates (0700) or verifies a folder: never a symlink, a real directory, ours, mode tightened to 0700. */
function ensureDir(p: string): void {
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    if (!isEnoent(e)) throw e;
    mkdirSync(p, { recursive: true, mode: 0o700 });
    st = lstatSync(p);
  }
  if (st.isSymbolicLink()) throw new Error(`undo journal: ${p} is a symlink; refusing to use it`);
  if (!st.isDirectory()) throw new Error(`undo journal: ${p} is not a directory`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`undo journal: ${p} is not owned by the current user`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(p, 0o700);
}

/** Like ensureDir but never creates: false when the folder does not exist yet. Throws for a symlink or a foreign folder. */
function verifyDirIfPresent(p: string): boolean {
  try { lstatSync(p); } catch (e) { if (isEnoent(e)) return false; throw e; }
  ensureDir(p);
  return true;
}

function normalizeId(id: string): string {
  const c = typeof id === "string" ? id.trim().toUpperCase() : "";
  if (!ID_RE.test(c)) throw new Error("invalid undo code (expected the form K7Q2-M9XD)");
  return c;
}

function newId(): string {
  const pick = () => ALPHABET[randomInt(ALPHABET.length)];
  let a = "", b = "";
  for (let i = 0; i < 4; i++) { a += pick(); b += pick(); }
  return `${a}-${b}`;
}

function str(v: unknown): v is string {
  return typeof v === "string";
}

function parseItem(o: unknown): UndoItem | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (!str(r.uid) || !r.uid || !str(r.from) || !str(r.name) || typeof r.restorable !== "boolean") return null;
  if (r.parentUid !== undefined && !str(r.parentUid)) return null;
  if (r.to !== undefined && !str(r.to)) return null;
  if (r.reason !== undefined && !str(r.reason)) return null;
  if (r.size !== undefined && (typeof r.size !== "number" || !Number.isFinite(r.size))) return null;
  const it: UndoItem = { uid: r.uid, from: r.from, name: r.name, restorable: r.restorable };
  if (r.parentUid !== undefined) it.parentUid = r.parentUid as string;
  if (r.to !== undefined) it.to = r.to as string;
  if (r.size !== undefined) it.size = r.size as number;
  if (r.reason !== undefined) it.reason = r.reason as string;
  return it;
}

/** Validates the on-disk shape; the id must equal the file name. Account is checked by the caller. */
function parseBatch(text: string, id: string): UndoBatch | null {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 1 || r.id !== id) return null;
  if (!str(r.account) || !r.account || !str(r.tool) || !r.tool) return null;
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return null;
  if (!str(r.kind) || !KINDS.includes(r.kind) || !str(r.status) || !STATUSES.includes(r.status)) return null;
  if (!Array.isArray(r.items) || r.items.length > MAX_ITEMS) return null;
  const items: UndoItem[] = [];
  for (const x of r.items) {
    const it = parseItem(x);
    if (!it) return null;
    items.push(it);
  }
  return {
    v: 1, id, account: r.account, createdAt: r.createdAt, tool: r.tool,
    kind: r.kind as UndoKind, status: r.status as UndoStatus, items,
  };
}

/** Reads a record without following symlinks; null for anything that is not a plain, small, own file. */
function readBatchFile(path: string, id: string): UndoBatch | null {
  let fd: number;
  try { fd = openSync(path, fsConstants.O_RDONLY | NOFOLLOW); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    if (uid !== undefined && st.uid !== uid) return null;
    return parseBatch(readFileSync(fd, "utf8"), id);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Creates a new file (O_EXCL, so an existing file or symlink at the path is an error), mode 0600, flushed to disk. */
function writeNewFile(path: string, data: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
  try {
    writeSync(fd, data);
    try { fsyncSync(fd); } catch { /* best effort */ }
  } finally {
    closeSync(fd);
  }
}

function unlinkQuiet(path: string): boolean {
  try { unlinkSync(path); return true; } catch { return false; }
}

function validateItems(items: unknown): UndoItem[] {
  if (!Array.isArray(items) || items.length === 0) throw new Error("undo journal: a batch needs at least one item");
  if (items.length > MAX_ITEMS) throw new Error(`undo journal: a batch holds at most ${MAX_ITEMS} items`);
  return items.map((x, i) => {
    const it = parseItem(x);
    if (!it) throw new Error(`undo journal: item ${i} is malformed (needs uid, from, name, restorable)`);
    return it;
  });
}

const DISABLED: UndoJournal = {
  enabled: false,
  begin: () => null,
  complete: () => false,
  list: () => [],
  get: () => null,
  markUndone: () => false,
  purge: () => 0,
};

/** A bulk record (several items, or written by drive_cleanup or a bulk tool) is not evicted by single-item calls. */
function isBulk(tool: string, items: number): boolean {
  return items > 1 || tool === "drive_cleanup" || tool.startsWith("drive_bulk_");
}

export function createUndoJournal(opts: UndoJournalOptions): UndoJournal {
  if (opts.enabled === false) return DISABLED;
  const dir = opts.dir;
  const account = opts.account;
  if (!account || typeof account !== "string") throw new Error("undo journal: an account key is required");
  const now = opts.now ?? Date.now;
  const maxAgeMs = opts.maxAgeMs ?? 30 * DAY_MS;
  const maxBatches = opts.maxBatches ?? 50;
  const tmpDir = join(dir, "tmp");
  const file = (id: string) => join(dir, `${id}.json`);

  function ready(): void {
    ensureDir(dir);
    ensureDir(tmpDir);
  }

  /** Every valid-looking record in the folder, any account, any age. Corrupt files are skipped. */
  function readAll(): Array<{ id: string; batch: UndoBatch | null; path: string }> {
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const out: Array<{ id: string; batch: UndoBatch | null; path: string }> = [];
    for (const n of names) {
      const m = FILE_RE.exec(n);
      if (!m) continue;
      const path = join(dir, n);
      out.push({ id: m[1], batch: readBatchFile(path, m[1]), path });
    }
    return out;
  }

  const expired = (b: UndoBatch, t: number) => b.createdAt + maxAgeMs <= t;

  /** `incoming`: the class of the batch begin is about to write, which gets one slot left free so it still fits under the cap. */
  function purgeNow(t: number, incoming?: boolean): number {
    let removed = 0;
    const live: UndoBatch[] = [];
    for (const { batch, path } of readAll()) {
      if (!batch) {
        // Unreadable or foreign-schema file: only removed once it is old, so a newer writer's file is not destroyed.
        try {
          const st = lstatSync(path);
          if (st.mtimeMs + maxAgeMs <= t && unlinkQuiet(path)) removed++;
        } catch { /* gone */ }
        continue;
      }
      if (expired(batch, t)) { if (unlinkQuiet(path)) removed++; continue; }
      if (batch.account === account) live.push(batch);
    }
    live.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
    for (const bulk of [true, false]) {
      const keep = Math.max(0, maxBatches - (incoming === bulk ? 1 : 0));
      for (const b of live.filter((x) => isBulk(x.tool, x.items.length) === bulk).slice(keep)) if (unlinkQuiet(file(b.id))) removed++;
    }
    try {
      for (const n of readdirSync(tmpDir)) {
        const p = join(tmpDir, n);
        try { if (lstatSync(p).mtimeMs + TMP_KEEP_MS <= t) unlinkQuiet(p); } catch { /* gone */ }
      }
    } catch { /* no tmp folder */ }
    return removed;
  }

  /** The batch when it exists, is readable, belongs to this account and has not expired. */
  function visible(id: string): UndoBatch | null {
    if (!verifyDirIfPresent(dir)) return null;
    const b = readBatchFile(file(id), id);
    if (!b || b.account !== account || expired(b, now())) return null;
    return b;
  }

  /** Atomic replace through a temp file in tmp/ (same filesystem as the record). */
  function rewrite(b: UndoBatch): void {
    ready();
    const stage = join(tmpDir, `${b.id}.stage-${randomBytes(6).toString("hex")}`);
    try {
      writeNewFile(stage, JSON.stringify(b));
      renameSync(stage, file(b.id));
    } catch (e) {
      unlinkQuiet(stage);
      throw e;
    }
  }

  return {
    enabled: true,

    begin({ tool, kind, items }) {
      if (!tool || typeof tool !== "string") throw new Error("undo journal: tool is required");
      if (!KINDS.includes(kind)) throw new Error("undo journal: kind must be trash, move or rename");
      const clean = validateItems(items);
      ready();
      const t = now();
      try { purgeNow(t, isBulk(tool, clean.length)); } catch { /* retention is best effort; never block a journal write */ }
      for (let attempt = 0; attempt < 50; attempt++) {
        const id = newId();
        const batch: UndoBatch = { v: 1, id, account, createdAt: t, tool, kind, status: "pending", items: clean };
        const data = JSON.stringify(batch);
        if (data.length > MAX_FILE_BYTES) throw new Error("undo journal: batch is too large");
        const stage = join(tmpDir, `${id}.stage-${randomBytes(6).toString("hex")}`);
        try {
          writeNewFile(stage, data);
          // link() fails with EEXIST when another writer took this id: nothing is ever overwritten.
          linkSync(stage, file(id));
          return { id };
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code === "EEXIST") continue;
          throw e;
        } finally {
          unlinkQuiet(stage);
        }
      }
      throw new Error("undo journal: could not allocate a free id");
    },

    complete(idIn, { succeededUids, status }) {
      const id = normalizeId(idIn);
      if (status !== "applied" && status !== "partial") throw new Error("undo journal: complete status must be applied or partial");
      const b = visible(id);
      if (!b || b.status !== "pending") return false;
      let items = b.items;
      let finalStatus: UndoStatus = status;
      if (succeededUids) {
        const keep = new Set(succeededUids);
        items = b.items.filter((i) => keep.has(i.uid));
        if (items.length < b.items.length) finalStatus = "partial";
      }
      if (items.length === 0) {
        unlinkQuiet(file(id));
        return true;
      }
      rewrite({ ...b, items, status: finalStatus });
      return true;
    },

    list() {
      if (!verifyDirIfPresent(dir)) return [];
      const t = now();
      return readAll()
        .map((r) => r.batch)
        .filter((b): b is UndoBatch => !!b && b.account === account && !expired(b, t))
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
        .map((b) => ({ id: b.id, createdAt: b.createdAt, tool: b.tool, kind: b.kind, status: b.status, itemCount: b.items.length }));
    },

    get(idIn) {
      return visible(normalizeId(idIn));
    },

    markUndone(idIn, status = "undone") {
      const id = normalizeId(idIn);
      if (status !== "undone" && status !== "partial") throw new Error("undo journal: markUndone status must be undone or partial");
      const b = visible(id);
      if (!b || b.status === "undone") return false;
      rewrite({ ...b, status });
      return true;
    },

    purge() {
      if (!verifyDirIfPresent(dir)) return 0;
      ready();
      return purgeNow(now());
    },
  };
}
