import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
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
 * Out-of-band approval store (channel 2 of the 1.11.0 approval gate).
 *
 * The server writes a pending record for an operation it refused; a human approves it in a terminal
 * (`proton-drive-cli approve <code>`); the next identical call consumes the approval exactly once.
 * The code is an identifier shown to the human, not a secret: what protects the operation is that the
 * record (tool + opHash + summary) is written by the server and the human reads that stored summary.
 *
 * Layout: <dir>/{pending,approved,consumed,tmp}/<code>.json, folders 0700, files 0600.
 * State changes are atomic renames, so two processes racing on one record see exactly one winner.
 *
 * The API is SYNCHRONOUS on purpose: records are tiny, a gated call touches a handful of files, and the
 * gate (src/index.ts) needs request()/consume() to be callable inline without awaiting.
 * POSIX rename semantics are assumed (macOS, Linux); Windows is not a target of this store.
 */

export type ApprovalStatus = "pending" | "approved";

export interface ApprovalRecord {
  code: string;
  tool: string;
  opHash: string;
  summary: string;
  createdAt: number;
  /** Pending: end of the 10 min request window. Approved: end of the 5 min approval window. */
  expiresAt: number;
  /** Set once approved. */
  approvedAt?: number;
  /** Derived from the folder the record lives in; never stored in the file. */
  status: ApprovalStatus;
}

export interface ApprovalStoreOptions {
  dir: string;
  now?: () => number;
  pendingTtlMs?: number;
  approvedTtlMs?: number;
  maxPending?: number;
}

export interface ApprovalStore {
  /** `fresh`: never hand out an already approved record for this operation (it is removed); a pending one is still reused. */
  request(p: { tool: string; opHash: string; summary: string; fresh?: boolean }): { code: string; expiresAt: number; reused: boolean };
  /** Removes every pending and approved record for this tool and operation; returns how many. */
  discard(p: { tool: string; opHash: string }): number;
  consume(p: { tool: string; opHash: string }): { code: string } | null;
  list(): ApprovalRecord[];
  get(code: string): ApprovalRecord | null;
  approve(code: string): ApprovalRecord;
  deny(code: string): boolean;
}

/** Unambiguous: no I, L, O, 0, 1. 31 symbols ^ 8 = ~40 bits; the code is not a secret. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;
const FILE_RE = /^([ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4})\.json$/;
const MAX_FILE_BYTES = 1_000_000;
const MAX_SUMMARY_CHARS = 100_000;
const CONSUMED_KEEP_MS = 24 * 3_600_000;

/** PROTON_DRIVE_APPROVAL_DIR, else next to the index dir (see indexDir in services/walkIndex.ts). */
export function resolveApprovalDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  const o = env.PROTON_DRIVE_APPROVAL_DIR;
  if (o && o.trim()) return resolve(o.trim());
  if (platform === "darwin") return join(home, "Library", "Caches", "proton-drive-mcp", "approvals");
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "proton-drive-mcp", "approvals");
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
  if (st.isSymbolicLink()) throw new Error(`approval store: ${p} is a symlink; refusing to use it`);
  if (!st.isDirectory()) throw new Error(`approval store: ${p} is not a directory`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`approval store: ${p} is not owned by the current user`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(p, 0o700);
}

function parseRecord(text: string, code: string, status: ApprovalStatus): ApprovalRecord | null {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.code !== code) return null;
  if (typeof r.tool !== "string" || !r.tool || typeof r.opHash !== "string" || !r.opHash) return null;
  if (typeof r.summary !== "string") return null;
  if (typeof r.createdAt !== "number" || typeof r.expiresAt !== "number") return null;
  if (r.approvedAt !== undefined && typeof r.approvedAt !== "number") return null;
  const rec: ApprovalRecord = {
    code, tool: r.tool, opHash: r.opHash, summary: r.summary,
    createdAt: r.createdAt, expiresAt: r.expiresAt, status,
  };
  if (r.approvedAt !== undefined) rec.approvedAt = r.approvedAt as number;
  return rec;
}

/** Reads a record file without following symlinks; null for anything that is not a plain, small, own file. */
function readRecordFile(path: string, code: string, status: ApprovalStatus): ApprovalRecord | null {
  let fd: number;
  try { fd = openSync(path, fsConstants.O_RDONLY | NOFOLLOW); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    if (uid !== undefined && st.uid !== uid) return null;
    return parseRecord(readFileSync(fd, "utf8"), code, status);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Creates a new file (O_EXCL, so an existing file or symlink at the path is an error), mode 0600. */
function writeNewFile(path: string, data: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
  try { writeSync(fd, data); } finally { closeSync(fd); }
}

function unlinkQuiet(path: string): boolean {
  try { unlinkSync(path); return true; } catch { return false; }
}

function normalizeCode(code: string): string {
  const c = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (!CODE_RE.test(c)) throw new Error("invalid approval code (expected the form K7Q2-M9XD)");
  return c;
}

function newCode(): string {
  const pick = () => ALPHABET[randomInt(ALPHABET.length)];
  let a = "", b = "";
  for (let i = 0; i < 4; i++) { a += pick(); b += pick(); }
  return `${a}-${b}`;
}

export function createApprovalStore(opts: ApprovalStoreOptions): ApprovalStore {
  const dir = opts.dir;
  const now = opts.now ?? Date.now;
  const pendingTtlMs = opts.pendingTtlMs ?? 10 * 60_000;
  const approvedTtlMs = opts.approvedTtlMs ?? 5 * 60_000;
  const maxPending = opts.maxPending ?? 20;
  const sub = (s: string) => join(dir, s);
  const file = (s: string, code: string) => join(dir, s, `${code}.json`);

  /** Verified on every operation, so a folder swapped for a symlink later is caught. */
  function ready(): void {
    ensureDir(dir);
    for (const s of ["pending", "approved", "consumed", "tmp"]) ensureDir(sub(s));
  }

  function readAll(status: ApprovalStatus | "consumed"): ApprovalRecord[] {
    let names: string[];
    try { names = readdirSync(sub(status)); } catch { return []; }
    const out: ApprovalRecord[] = [];
    for (const n of names) {
      const m = FILE_RE.exec(n);
      if (!m) continue;
      const rec = readRecordFile(join(sub(status), n), m[1], status === "consumed" ? "approved" : status);
      if (rec) out.push(rec);
    }
    return out;
  }

  function purge(t: number): void {
    for (const s of ["pending", "approved"] as const) {
      for (const r of readAll(s)) if (r.expiresAt <= t) unlinkQuiet(file(s, r.code));
    }
    for (const r of readAll("consumed")) if (r.expiresAt + CONSUMED_KEEP_MS <= t) unlinkQuiet(file("consumed", r.code));
  }

  function codeTaken(code: string): boolean {
    for (const s of ["pending", "approved", "consumed", "tmp"]) {
      try { lstatSync(file(s, code)); return true; } catch { /* free */ }
    }
    return false;
  }

  return {
    request({ tool, opHash, summary, fresh }) {
      if (!tool || typeof tool !== "string" || !opHash || typeof opHash !== "string" || typeof summary !== "string") {
        throw new Error("approval request needs tool, opHash and summary strings");
      }
      if (summary.length > MAX_SUMMARY_CHARS) throw new Error("approval summary is too long");
      ready();
      const t = now();
      purge(t);
      if (fresh) {
        for (const r of readAll("approved")) if (r.tool === tool && r.opHash === opHash) unlinkQuiet(file("approved", r.code));
      }
      for (const s of ["approved", "pending"] as const) {
        const hit = readAll(s).find((r) => r.tool === tool && r.opHash === opHash && r.expiresAt > t);
        if (hit) return { code: hit.code, expiresAt: hit.expiresAt, reused: true };
      }
      const pending = readAll("pending").filter((r) => r.expiresAt > t).length;
      if (pending >= maxPending) {
        throw new Error(
          `too many pending approvals (${maxPending}); deny or wait for some to expire (run: proton-drive-cli approvals)`,
        );
      }
      let code = newCode();
      while (codeTaken(code)) code = newCode();
      const expiresAt = t + pendingTtlMs;
      writeNewFile(file("pending", code), JSON.stringify({ code, tool, opHash, summary, createdAt: t, expiresAt }));
      return { code, expiresAt, reused: false };
    },

    list() {
      ready();
      purge(now());
      return [...readAll("pending"), ...readAll("approved")].sort((a, b) => a.createdAt - b.createdAt);
    },

    get(codeIn) {
      const code = normalizeCode(codeIn);
      ready();
      const t = now();
      for (const s of ["approved", "pending"] as const) {
        const r = readRecordFile(file(s, code), code, s);
        if (r && r.expiresAt > t) return r;
      }
      return null;
    },

    approve(codeIn) {
      const code = normalizeCode(codeIn);
      ready();
      const t = now();
      const fail = () => new Error(`no pending approval ${code} (unknown, expired, already approved or denied)`);
      // Claim the pending file by rename: only one approver (or denier) can win it.
      const claim = join(sub("tmp"), `${code}.claim-${randomBytes(6).toString("hex")}`);
      try { renameSync(file("pending", code), claim); } catch { throw fail(); }
      const rec = readRecordFile(claim, code, "pending");
      if (!rec || rec.expiresAt <= t) { unlinkQuiet(claim); throw fail(); }
      const approved: ApprovalRecord = { ...rec, status: "approved", approvedAt: t, expiresAt: t + approvedTtlMs };
      const { status: _s, ...onDisk } = approved;
      const stage = join(sub("tmp"), `${code}.stage-${randomBytes(6).toString("hex")}`);
      try {
        writeNewFile(stage, JSON.stringify(onDisk));
        renameSync(stage, file("approved", code));
      } catch (e) {
        unlinkQuiet(stage);
        throw e;
      } finally {
        unlinkQuiet(claim);
      }
      return approved;
    },

    discard({ tool, opHash }) {
      ready();
      let n = 0;
      for (const s of ["pending", "approved"] as const) {
        for (const r of readAll(s)) {
          if (r.tool !== tool || r.opHash !== opHash) continue;
          try { unlinkSync(file(s, r.code)); n++; } catch { /* another process removed or consumed it */ }
        }
      }
      return n;
    },

    deny(codeIn) {
      const code = normalizeCode(codeIn);
      ready();
      let removed = false;
      for (const s of ["pending", "approved"]) {
        try { unlinkSync(file(s, code)); removed = true; } catch { /* not there */ }
      }
      return removed;
    },

    consume({ tool, opHash }) {
      ready();
      const t = now();
      for (const r of readAll("approved")) {
        if (r.tool !== tool || r.opHash !== opHash || r.expiresAt <= t) continue;
        try {
          // The single decision point: rename is atomic, so exactly one caller (thread or process) moves the file.
          renameSync(file("approved", r.code), file("consumed", r.code));
        } catch {
          continue; // another consumer won, or the record vanished
        }
        return { code: r.code };
      }
      return null;
    },
  };
}
