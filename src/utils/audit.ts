import { createHash } from "node:crypto";
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const GENESIS = "0".repeat(64);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface AuditEntry {
  ts: string;
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  outcome: "ok" | "error" | "refused";
  code?: string;
  durationMs: number;
  prev: string;
  hash: string;
}

export type AuditVerification = { ok: true; entries: number; head: string } | { ok: false; brokenSeq: number; reason: string };

/** JSON with sorted keys at every level, so the hash does not depend on property order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const hashOf = (e: Omit<AuditEntry, "hash">) => sha256(e.prev + canonical(e));

/**
 * What goes in the log for a call. Nothing secret or free-text: passwords and message bodies are replaced, file text is
 * reduced to its size, and arguments the tool does not declare are recorded as present but never by value.
 */
export function redactArgs(tool: string, args: Record<string, unknown>, declared: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (tool === "drive_write_file" && k === "content" && typeof v === "string") {
      out.content = "[redacted]";
      out.contentBytes = Buffer.byteLength(v);
    } else if (k === "password" || k === "message") out[k] = "[redacted]";
    else if (!Object.hasOwn(declared, k)) out[k] = "[unknown argument]";
    else {
      const size = JSON.stringify(v)?.length ?? 0;
      out[k] = size > 20_000 ? `[omitted: ${size} chars]` : v;
    }
  }
  return out;
}

/** realpath of the deepest existing ancestor of `p` with the missing remainder appended. */
function realResolve(p: string): string {
  const rest: string[] = [];
  for (let cur = resolve(p); ; cur = dirname(cur)) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch (err) {
      const parent = dirname(cur);
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || parent === cur) return resolve(p);
      rest.unshift(basename(cur));
    }
  }
}

/** True when `file` is `dir` itself or lies below it, symlinks resolved. */
export function auditLogInside(file: string, dir: string): boolean {
  if (!isAbsolute(file)) return false; // unusable anyway: AuditLog refuses a relative path
  const rel = relative(realResolve(dir), realResolve(file));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

const STALE_LOCK_MS = 2_000; // a holder keeps the lock for a few milliseconds
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Last line of the file, or undefined when empty. Throws when the file does not end in a newline (a torn write). */
function lastLine(fd: number, size: number): string | undefined {
  if (size === 0) return undefined;
  const one = Buffer.alloc(1);
  readSync(fd, one, 0, 1, size - 1);
  if (one[0] !== 0x0a) throw new Error("audit log does not end with a newline (torn write?)");
  let end = size - 1, buf = Buffer.alloc(0);
  while (end > 0) {
    const start = Math.max(0, end - 65_536);
    const chunk = Buffer.alloc(end - start);
    readSync(fd, chunk, 0, chunk.length, start);
    buf = Buffer.concat([chunk, buf]);
    end = start;
    const nl = buf.lastIndexOf(0x0a);
    if (nl >= 0) return buf.subarray(nl + 1).toString("utf8");
  }
  return buf.toString("utf8");
}

/** Append-only JSONL log; each line commits to the previous one's hash, so editing or removing an entry breaks the chain. */
export class AuditLog {
  private readonly lockWaitMs: number;

  constructor(readonly file: string, opts: { lockWaitMs?: number } = {}) {
    this.lockWaitMs = opts.lockWaitMs ?? 4_000;
  }

  /** null when PROTON_DRIVE_AUDIT_LOG is unset or blank. A set but unusable value still yields a log whose writes fail (fail closed). */
  static fromEnv(raw: string | undefined): AuditLog | null {
    return raw === undefined || raw.trim() === "" ? null : new AuditLog(raw);
  }

  /** Opens for append+read; creates the directory 0700 and the file 0600, and tightens an existing file to 0600. */
  private open(): number {
    if (!isAbsolute(this.file)) throw new Error("PROTON_DRIVE_AUDIT_LOG must be an absolute file path");
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const fd = openSync(this.file, "a+", 0o600);
    try {
      if ((fstatSync(fd).mode & 0o077) !== 0) chmodSync(this.file, 0o600);
    } catch (err) {
      closeSync(fd);
      throw err;
    }
    return fd;
  }

  /**
   * Exclusive lock (file.lock, created with O_EXCL) so two server processes cannot both read the same tail and write the
   * same seq. Retries with backoff for lockWaitMs, then throws (a write failure). A lock older than STALE_LOCK_MS belongs
   * to a crashed process and is removed. Returns the release function.
   */
  private lock(): () => void {
    const path = this.file + ".lock";
    const deadline = Date.now() + this.lockWaitMs;
    for (let delay = 1; ; delay = Math.min(delay * 2, 50)) {
      try {
        closeSync(openSync(path, "wx", 0o600));
        return () => { try { unlinkSync(path); } catch { /* already gone */ } };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) { unlinkSync(path); continue; }
      } catch { continue; /* released meanwhile */ }
      if (Date.now() >= deadline) throw new Error(`audit log is locked by another process (${path})`);
      sleepSync(delay);
    }
  }

  private tail(fd: number): { seq: number; hash: string } {
    const line = lastLine(fd, fstatSync(fd).size);
    if (line === undefined) return { seq: 0, hash: GENESIS };
    const last = JSON.parse(line) as Partial<AuditEntry>;
    if (typeof last.seq !== "number" || typeof last.hash !== "string") throw new Error("last audit log entry is malformed");
    return { seq: last.seq, hash: last.hash };
  }

  /** Error text when a new entry could not be appended right now, else undefined. */
  checkWritable(): string | undefined {
    try {
      const fd = this.open();
      try {
        const release = this.lock(); // also proves a later append will not time out on a stuck lock
        try { this.tail(fd); } finally { release(); }
      } finally { closeSync(fd); }
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** The tail is re-read under a lock on every append so several server processes sharing one file keep a single chain. Throws on failure. */
  append(rec: { tool: string; args: Record<string, unknown>; outcome: AuditEntry["outcome"]; code?: string; durationMs: number }): void {
    const fd = this.open();
    try {
      const release = this.lock();
      try {
        const { seq, hash: prev } = this.tail(fd);
        const body: Omit<AuditEntry, "hash"> = { ts: new Date().toISOString(), seq: seq + 1, ...rec, prev };
        writeSync(fd, JSON.stringify({ ...body, hash: hashOf(body) }) + "\n");
      } finally {
        release();
      }
    } finally {
      closeSync(fd);
    }
  }

  private lines(): string[] {
    try {
      return readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  /** Last `n` entries (unparseable lines are skipped; verify() reports them). */
  last(n: number): AuditEntry[] {
    const out: AuditEntry[] = [];
    for (const line of this.lines().slice(-n)) {
      try { out.push(JSON.parse(line) as AuditEntry); } catch { /* reported by verify() */ }
    }
    return out;
  }

  /**
   * Recomputes the whole chain. Detects edited, inserted, removed-from-the-middle and reordered entries; it cannot detect
   * removal of the newest entries, so keep `head` somewhere else if that matters.
   */
  verify(): AuditVerification {
    let prev = GENESIS;
    const lines = this.lines();
    for (let i = 0; i < lines.length; i++) {
      const seq = i + 1;
      let e: AuditEntry;
      try { e = JSON.parse(lines[i]!) as AuditEntry; } catch { return { ok: false, brokenSeq: seq, reason: "unparseable line" }; }
      if (e.seq !== seq) return { ok: false, brokenSeq: seq, reason: `expected seq ${seq}, found ${e.seq}` };
      if (e.prev !== prev) return { ok: false, brokenSeq: seq, reason: "prev hash does not match the previous entry" };
      const { hash, ...body } = e;
      if (hash !== hashOf(body)) return { ok: false, brokenSeq: seq, reason: "entry content does not match its hash" };
      prev = hash;
    }
    return { ok: true, entries: lines.length, head: prev };
  }
}
