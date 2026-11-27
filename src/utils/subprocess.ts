import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { DriveCliError, DriveCliNotFoundError, DriveNotAuthenticatedError, DriveParseError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 60_000;
// Upload and download transfer actual file bytes — use a much longer timeout.
const TRANSFER_TIMEOUT_MS = 30 * 60_000; // 30 minutes
const MAX_BUFFER = 50 * 1024 * 1024;
const MAX_ERROR_CHARS = 1500;

// copy/move can process large folder trees server-side (re-encrypting or
// re-sharing many files), just like upload/download — they need the same
// extended timeout. Previously only upload/download got it; a large
// drive_copy or drive_move would be SIGKILL'd after the 60s default,
// potentially leaving Drive in a partially-copied/moved state.
const TRANSFER_COMMANDS = new Set(["upload", "download", "copy", "move"]);
const TRANSFER_GROUPS = new Set(["filesystem", "photo"]);

// Trash, restore and delete take longer the more items one call names; empty-trash names none, so the caller passes the count.
const BATCH_COMMANDS = new Set(["trash", "restore", "delete"]);
const PER_ITEM_TIMEOUT_MS = 5_000;
const MAX_BATCH_TIMEOUT_MS = 10 * 60_000;

export interface RunOptions {
  /** How many items the command touches, when the arguments do not say. */
  items?: number;
}

export function timeoutFor(args: string[], opts: RunOptions = {}): number {
  // args[0] is the group (e.g. "filesystem"), args[1] is the subcommand
  if (args[0] === "filesystem" && args[1] === "empty-trash") {
    return opts.items === undefined ? MAX_BATCH_TIMEOUT_MS : Math.min(MAX_BATCH_TIMEOUT_MS, 2 * DEFAULT_TIMEOUT_MS + PER_ITEM_TIMEOUT_MS * opts.items);
  }
  if (args[0] === "filesystem" && BATCH_COMMANDS.has(args[1] ?? "")) {
    return Math.min(MAX_BATCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS + PER_ITEM_TIMEOUT_MS * (args.length - 2));
  }
  if (args[0] && TRANSFER_GROUPS.has(args[0]) && args[1] && TRANSFER_COMMANDS.has(args[1])) {
    return TRANSFER_TIMEOUT_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}

// An empty value counts as unset: some clients pass "" for an optional setting.
const configuredBinary = (): string | undefined => {
  const v = process.env["PROTON_DRIVE_BIN"];
  return v?.trim() ? v : undefined;
};

// A binary nobody asked for by path is only run when other users cannot replace it: a regular executable file (symlinks
// followed) that is not world-writable, in folders (of the link and of its target) that are not world-writable either.
// Group-writable is accepted: Homebrew's bin folders are writable by the admin group.
function isSafeExecutable(file: string): boolean {
  try {
    const st = statSync(file);
    if (!st.isFile()) return false;
    if (process.platform === "win32") return true;
    accessSync(file, constants.X_OK);
    return [st, statSync(dirname(file)), statSync(dirname(realpathSync(file)))].every((s) => (s.mode & 0o002) === 0);
  } catch {
    return false;
  }
}

/**
 * The CLI to run when PROTON_DRIVE_BIN is not set: PATH first, then the usual install folders (Claude Desktop starts
 * servers with a minimal PATH). Only absolute folders are searched, so nothing is ever picked up from the current directory.
 * `viaFallback` is true when it was found outside PATH.
 */
export function findDriveCli(
  opts: { path?: string; home?: string; wellKnownDirs?: string[] } = {}
): { path: string; viaFallback: boolean } | undefined {
  const home = opts.home ?? homedir();
  const wellKnown = opts.wellKnownDirs ?? wellKnownCliDirs(home);
  const name = process.platform === "win32" ? "proton-drive.exe" : "proton-drive";
  const search = (dirs: string[]) => dirs.filter((d) => isAbsolute(d)).map((d) => join(d, name)).find(isSafeExecutable);
  const onPath = search((opts.path ?? process.env["PATH"] ?? "").split(delimiter));
  if (onPath) return { path: onPath, viaFallback: false };
  const fallback = search(wellKnown);
  return fallback ? { path: fallback, viaFallback: true } : undefined;
}

export function wellKnownCliDirs(home: string = homedir()): string[] {
  // A relative or empty HOME must not turn into a folder under the current directory.
  return [...(isAbsolute(home) ? [join(home, ".local", "bin")] : []), "/opt/homebrew/bin", "/usr/local/bin"];
}

/** The command a user types in a terminal to sign in; the full path when a bare `proton-drive` might not be found. */
export function signInCommand(): string {
  const configured = configuredBinary();
  const found = configured ? undefined : findDriveCli();
  const path = configured ?? (found?.viaFallback ? found.path : undefined);
  return path && isAbsolute(path) ? `'${path.replace(/'/g, `'\\''`)}' auth login` : "proton-drive auth login";
}

/** The "not found" / "cannot be run" error for the binary that failed to start (`undefined`: nothing was found). */
export function cliLaunchError(binary: string | undefined = configuredBinary()): DriveCliNotFoundError {
  if (!binary) return new DriveCliNotFoundError();
  return new DriveCliNotFoundError({ path: binary, exists: !isAbsolute(binary) ? false : existsSync(binary) });
}

// Per-request context: lets the MCP dispatch hand the request's AbortSignal to
// whichever CLI process that request spawns, without threading a parameter
// through every DriveService method.
export const callContext = new AsyncLocalStorage<{ signal?: AbortSignal; startedAt?: number }>();

const running = new Set<ChildProcess>();

/** Lets another module's detached child (the OCR engine) die with the server like the CLI processes; returns the untrack function. */
export function trackChild(child: ChildProcess): () => void {
  running.add(child);
  return () => { running.delete(child); };
}

export function killTree(child: ChildProcess): void {
  try {
    // Children are spawned detached (own process group) so the whole tree dies,
    // not just the direct child — SIGKILL on the child alone left grandchildren.
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/** Kill every CLI process this server started (shutdown / client disconnect). */
export function killAllChildren(): void {
  for (const child of running) killTree(child);
  running.clear();
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

const AUTH_PHRASES = [
  "not authenticated",
  "not logged in",
  "you need to login first",
  "session expired",
  "session has expired",
  "login required",
  "authentication required",
  "please log in",
  "unauthorized",
];

export function isAuthError(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTH_PHRASES.some((p) => lower.includes(p));
}

type ExecError = NodeJS.ErrnoException & {
  killed?: boolean;
  stderr?: string;
  stdout?: string;
  signal?: string;
  cancelled?: boolean;
};

function execCli(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const signal = callContext.getStore()?.signal;
    if (signal?.aborted) {
      const e: ExecError = new Error("cancelled");
      e.cancelled = true;
      reject(e);
      return;
    }

    let timedOut = false;
    let cancelled = false;
    let overflow = false;
    let settled = false;
    const out: Buffer[] = [];
    const errBuf: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;

    // Resolved per call, so a CLI installed after the server started is picked up.
    const binary = configuredBinary() ?? findDriveCli()?.path;
    if (!binary) {
      reject(cliLaunchError(undefined));
      return;
    }

    // stdin is ignored: the CLI must never sit waiting on an interactive prompt.
    const child = spawn(binary, args, {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.add(child);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(child);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_BUFFER) { overflow = true; killTree(child); return; }
      out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > MAX_BUFFER) { overflow = true; killTree(child); return; }
      errBuf.push(chunk);
    });

    child.on("error", (err) => {
      finish(() => reject(err));
    });
    child.on("close", (code, sig) => {
      finish(() => {
        const stdout = Buffer.concat(out).toString("utf8");
        const stderr = Buffer.concat(errBuf).toString("utf8");
        if (code === 0 && !sig && !timedOut && !cancelled && !overflow) {
          resolve({ stdout, stderr });
          return;
        }
        const e: ExecError = new Error("CLI exited abnormally");
        e.stdout = stdout;
        e.stderr = stderr;
        if (typeof code === "number") e.code = code as unknown as string;
        if (sig) e.signal = sig;
        if (timedOut) { e.killed = true; e.code = "ETIMEDOUT"; }
        if (overflow) e.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        if (cancelled) e.cancelled = true;
        reject(e);
      });
    });
  });
}

// execFile's own e.message is "Command failed: <bin> <every argv>\n<stderr>" —
// that leaked --password / --message values (and the binary path) straight to
// the MCP client, and buried the real cause. Build the message from the CLI's
// own output instead. Confirmed live: some failures write the actual cause
// ("ENOENT: no such file ...") to *stdout* and only a "=====" banner to stderr.
function describeFailure(e: ExecError, args: string[]): string {
  const stderr = redactSecrets(stripAnsi(e.stderr ?? ""));
  const stdout = stripAnsi(e.stdout ?? "");

  const lines: string[] = [];
  const push = (block: string) => {
    for (const raw of block.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^[=\-_*\s]+$/.test(line)) continue; // banner rules
      if (/^at\s/.test(line)) continue; // stack frames
      // Bundled CLI source excerpts ("20075 |   code…" plus a "^" marker line)
      // and an empty "Error details: {}" say nothing about what went wrong.
      if (/^\d+\s*\|/.test(line) || /^\^+$/.test(line)) continue;
      if (/^Error details:\s*(\{\})?$/.test(line) || line === "{}") continue;
      if (!lines.includes(line)) lines.push(line);
    }
  };

  push(stderr);
  // stdout on failure is either a structured {"error": ...} or plain crash text.
  const trimmedOut = stdout.trim();
  if (trimmedOut) {
    try {
      const parsed = JSON.parse(trimmedOut) as unknown;
      const obj = Array.isArray(parsed) ? parsed[0] : parsed;
      if (obj && typeof obj === "object") {
        const o = obj as Record<string, unknown>;
        const err = o["error"];
        if (typeof err === "string") push(err);
        else if (err && typeof err === "object") push(String((err as Record<string, unknown>)["message"] ?? (err as Record<string, unknown>)["name"] ?? ""));
        else if (typeof o["message"] === "string") push(o["message"]);
      }
    } catch {
      // Unparsable sharing output can hold the link password in any shape: never repeat it.
      if (args[0] !== "sharing") push(redactSecrets(trimmedOut));
    }
  }

  let text = redactSecrets(lines.slice(0, 8).join("\n"));
  if (!text) {
    const code = typeof e.code === "number" ? ` (exit ${e.code})` : "";
    const binary = configuredBinary() ?? findDriveCli()?.path;
    text = e.signal
      ? `CLI was terminated by ${e.signal}`
      : `CLI failed with no output${code}. The program that was run is "${binary}". If that is not the proton-drive tool, ` +
        `fix the "proton-drive CLI path" setting (Claude Desktop > Settings > Extensions > Proton Drive; PROTON_DRIVE_BIN elsewhere) ` +
        "with the path printed by `which proton-drive`.";
  }
  text = text.replace(/(--(?:password|message)[= ])\S+/g, "$1***");
  return text.length > MAX_ERROR_CHARS ? text.slice(0, MAX_ERROR_CHARS) + "…" : text;
}

// Normalizes a raw exec failure into one of our typed errors. Shared by
// runDrive and runDriveRaw so both entry points fail the same way.
const INTERRUPTIBLE = new Set(["trash", "restore", "delete", "empty-trash", "move"]);

function interruption(what: string, args: string[]): DriveCliError {
  if (args[0] !== "filesystem" || !INTERRUPTIBLE.has(args[1] ?? "")) return new DriveCliError(what, "");
  return new DriveCliError(`${what}. The outcome is unknown: the change may have been applied partly or completely. List the folder or the trash before retrying.`, "", true);
}

function normalizeExecError(err: unknown, args: string[], opts: RunOptions = {}): never {
  if (
    err instanceof DriveCliError ||
    err instanceof DriveCliNotFoundError ||
    err instanceof DriveNotAuthenticatedError ||
    err instanceof DriveParseError
  ) {
    throw err;
  }

  const e = err as ExecError;

  if (e.cancelled) {
    throw interruption("Cancelled by client", args);
  }

  // The program never started: missing, a folder, not executable, wrong format.
  if (e.code === "ENOENT" || e.syscall?.startsWith("spawn")) {
    throw cliLaunchError(configuredBinary() ?? findDriveCli()?.path);
  }

  if (e.killed === true || e.code === "ETIMEDOUT") {
    throw interruption(`CLI process timed out after ${timeoutFor(args, opts) / 1000}s`, args);
  }

  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    throw interruption("CLI output exceeded buffer limit (50 MB)", args);
  }

  if (isAuthError(`${e.stderr ?? ""}\n${e.stdout ?? ""}`)) {
    throw new DriveNotAuthenticatedError(signInCommand());
  }

  throw new DriveCliError(describeFailure(e, args), "");
}

// The CLI sometimes prints ANSI/progress noise before the JSON, so fall back to
// parsing from the first line that starts a JSON value.
function parseJsonLoose(raw: string): unknown {
  try { return JSON.parse(raw); } catch { /* try harder */ }
  const cleaned = stripAnsi(raw);
  try { return JSON.parse(cleaned); } catch { /* try harder */ }
  const lines = cleaned.split(/\r?\n/);
  let tried = 0;
  for (let i = 0; i < lines.length && tried < 20; i++) {
    const start = lines[i].trimStart()[0];
    if (start !== "{" && start !== "[") continue;
    tried++;
    try { return JSON.parse(lines.slice(i).join("\n")); } catch { /* next candidate */ }
  }
  const value = parseBeforeTrailer(lines);
  if (value !== undefined) return value;
  throw new Error("no JSON found");
}

const MAX_TRAILING_LINES = 3;
// A line that could belong to a JSON document; anything else after a complete value is a notice such as "Update available".
const JSON_LIKE_LINE = /^[{}[\]",:]/;

const isTrailer = (lines: string[]): boolean => {
  const text = lines.map((l) => l.trim()).filter(Boolean);
  return text.length <= MAX_TRAILING_LINES && text.every((l) => !JSON_LIKE_LINE.test(l));
};

// JSON followed by a notice. Only the first line that opens a JSON value is tried: starting further down could return an
// inner value of a cut-off document.
function parseBeforeTrailer(lines: string[]): unknown {
  const start = lines.findIndex((l) => /^\s*[{[]/.test(l));
  if (start < 0) return undefined;
  for (let end = lines.length - 1; end > start; end--) {
    if (!isTrailer(lines.slice(end))) return undefined;
    try { return JSON.parse(lines.slice(start, end).join("\n")); } catch { /* keep trimming */ }
  }
  return undefined;
}

// Sharing output carries the public link and its password; keep both out of errors and logs.
const SECRET_VALUE_RE = /(["']?\b(?:customPassword|password|url)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[^\s,}\]]+)/gi;
const PUBLIC_LINK_RE = /https?:\/\/drive\.proton\.(?:me|black)\/urls\/[^\s"']*/gi;

function redactSecrets(text: string): string {
  return text.replace(PUBLIC_LINK_RE, "***").replace(SECRET_VALUE_RE, '$1"***"');
}

// Transient failures seen live (several clients on one CLI session, slow API):
// "database is locked" (SQLite cache), a single API request timing out inside
// the CLI ("Request timed out: GET https://drive-api.proton.me/..."), and
// rate limiting. Strings below come from the CLI binary's own text (v0.8.0):
//   "Too many requests limit reached" / "Too many server requests, please try again later"
//   "Too many server errors, please try again later", "429 Too Many Requests",
//   "502 Bad Gateway", "503 Service Unavailable",
//   ": Timeout error, retrying" / ": Network error, retrying" / ": Offline error, retrying"
//   and Node/Bun socket codes ECONNRESET, ETIMEDOUT, EAI_AGAIN, "socket hang up".
// The CLI already retries some of these internally; we only see the ones that
// ended up failing.
const TRANSIENT_RE = new RegExp([
  "database is locked", "SQLITE_BUSY",
  "(?:http|status|error)[ :]*429\\b", "429 too many", "too many (server )?requests", "rate.?limit",
  "\\b50[234] (?:bad gateway|service unavailable|gateway)", "(?:http|status|error)[ :]*50[234]\\b", "bad gateway", "service unavailable",
  "request timed out", "timeout error", "network error", "offline error",
  "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "socket hang up",
].join("|"), "i");
const RETRY_AFTER_RE = /retry[- ]after\D{0,3}(\d+(?:\.\d+)?)/i;
const MAX_RETRIES = 2; // 3 attempts total
const MAX_RETRY_AFTER_MS = 5_000; // never stall the MCP client longer than this per wait
// Undocumented test hook: shrink the backoff so tests run fast.
const RETRY_BASE_MS = Number(process.env.PROTON_DRIVE_RETRY_BASE_MS ?? 250);

// The single place that decides which commands may be re-run. Writes (mkdir,
// upload, move, delete, ...) are never retried: a retry could repeat a mutation.
const READ_ONLY_COMMANDS = new Set([
  "filesystem list", "filesystem info", "sharing status", "invitation list",
  "album list", "album photos", "photo timeline", "version",
]);

function isTransient(e: ExecError): boolean {
  if (e.cancelled || e.killed === true) return false; // cancelled, or our own per-call timeout
  const text = `${e.stderr ?? ""}\n${e.stdout ?? ""}`;
  if (isAuthError(text)) return false;
  return TRANSIENT_RE.test(stripAnsi(text));
}

function retryDelayMs(e: ExecError, attempt: number): number {
  const m = RETRY_AFTER_RE.exec(stripAnsi(`${e.stderr ?? ""}\n${e.stdout ?? ""}`));
  if (m) return Math.min(Number(m[1]) * 1000, MAX_RETRY_AFTER_MS);
  return RETRY_BASE_MS * (attempt + 1) + Math.random() * RETRY_BASE_MS;
}

// Resolves false if the client cancels while we wait.
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => { clearTimeout(t); resolve(false); };
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(true); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function execCliWithRetry(args: string[], cliArgs: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const readOnly = READ_ONLY_COMMANDS.has(args.slice(0, 2).join(" "));
  const signal = callContext.getStore()?.signal;
  const budget = timeoutFor(args, opts);
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      // The whole call, retries included, stays within the per-call budget.
      return await execCli(cliArgs, Math.max(1, budget - (Date.now() - started)));
    } catch (err) {
      const e = err as ExecError;
      if (!readOnly || attempt >= MAX_RETRIES || !isTransient(e)) throw err;
      const delay = retryDelayMs(e, attempt);
      if (Date.now() - started + delay >= budget) throw err;
      if (!(await sleepUnlessAborted(delay, signal))) {
        const c: ExecError = new Error("cancelled");
        c.cancelled = true;
        throw c;
      }
    }
  }
}

export async function runDrive(args: string[], opts?: RunOptions): Promise<unknown> {
  try {
    const { stdout, stderr } = await execCliWithRetry(args, [...args, "--json"], opts);

    const raw = stdout.trim();

    // Only check stderr for auth errors when stdout is empty. If the CLI wrote
    // valid JSON, we honour it even when warnings appear on stderr.
    if (!raw) {
      if (stderr && stderr.trim() && isAuthError(stderr)) {
        throw new DriveNotAuthenticatedError(signInCommand());
      }
      return null;
    }

    // Some commands (e.g. `sharing status`/`sharing remove-url` on an item
    // with no share record) call the CLI's own printObject(undefined, true)
    // helper, which does console.log(JSON.stringify(undefined)) — and
    // JSON.stringify(undefined) is the JS value undefined, so console.log
    // prints the literal 5 characters "undefined", not valid JSON. Confirmed
    // live against the real CLI (v0.8.0). Treat it the same as empty stdout.
    const [firstLine, ...rest] = raw.split(/\r?\n/);
    if (firstLine === "undefined" && isTrailer(rest)) {
      return null;
    }

    try {
      return parseJsonLoose(raw);
    } catch {
      const snippet = args[0] === "sharing"
        ? "(output hidden: sharing commands can print link passwords)"
        : redactSecrets(stripAnsi(raw)).slice(0, 200).replace(/\s+/g, " ");
      try { process.stderr.write(`[proton-drive-mcp] parse error: ${snippet}\n`); } catch { /* ignore EPIPE */ }
      throw new DriveParseError(`Failed to parse CLI output as JSON: ${snippet}`);
    }
  } catch (err) {
    normalizeExecError(err, args, opts);
  }
}

// Some CLI commands (namely `version`) ignore --json entirely and always
// print plain text. This runs without appending --json and returns raw stdout.
export async function runDriveRaw(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execCliWithRetry(args, args);
    if (!stdout.trim() && stderr && stderr.trim() && isAuthError(stderr)) {
      throw new DriveNotAuthenticatedError(signInCommand());
    }
    return stdout;
  } catch (err) {
    normalizeExecError(err, args);
  }
}

// Returns false only when the binary is not installed (ENOENT) or not executable (EACCES).
// Any other error (non-zero exit, auth required, etc.) still returns true — the binary
// is present and real errors will surface on the first actual tool call.
export async function checkCliAvailable(): Promise<{ available: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const binary = configuredBinary() ?? findDriveCli()?.path;
    if (!binary) return resolve({ available: false, reason: "not_found" });
    const child = spawn(binary, ["version"], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore"],
    });
    running.add(child);
    let done = false;
    const finish = (r: { available: boolean; reason?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      running.delete(child);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ available: true }); // present but slow: real errors surface on first call
    }, 5_000);
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return finish({ available: false, reason: "not_found" });
      if (code === "EACCES") return finish({ available: false, reason: "not_executable" });
      finish({ available: true });
    });
    child.on("close", () => finish({ available: true }));
  });
}
