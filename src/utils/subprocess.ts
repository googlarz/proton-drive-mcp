import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { DriveCliError, DriveCliNotFoundError, DriveNotAuthenticatedError, DriveParseError } from "./errors.js";

const CLI_BINARY = process.env["PROTON_DRIVE_BIN"] ?? "proton-drive";
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

export function timeoutFor(args: string[]): number {
  // args[0] is the group (e.g. "filesystem"), args[1] is the subcommand
  if (args[0] && TRANSFER_GROUPS.has(args[0]) && args[1] && TRANSFER_COMMANDS.has(args[1])) {
    return TRANSFER_TIMEOUT_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}

// Per-request context: lets the MCP dispatch hand the request's AbortSignal to
// whichever CLI process that request spawns, without threading a parameter
// through every DriveService method.
export const callContext = new AsyncLocalStorage<{ signal?: AbortSignal }>();

const running = new Set<ChildProcess>();

function killTree(child: ChildProcess): void {
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

    // stdin is ignored: the CLI must never sit waiting on an interactive prompt.
    const child = spawn(CLI_BINARY, args, {
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
function describeFailure(e: ExecError): string {
  const stderr = stripAnsi(e.stderr ?? "");
  const stdout = stripAnsi(e.stdout ?? "");

  const lines: string[] = [];
  const push = (block: string) => {
    for (const raw of block.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^[=\-_*\s]+$/.test(line)) continue; // banner rules
      if (/^at\s/.test(line)) continue; // stack frames
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
      push(trimmedOut);
    }
  }

  let text = lines.slice(0, 8).join("\n");
  if (!text) {
    const code = typeof e.code === "number" ? ` (exit ${e.code})` : "";
    text = e.signal ? `CLI was terminated by ${e.signal}` : `CLI failed with no output${code}`;
  }
  text = text.replace(/(--(?:password|message)[= ])\S+/g, "$1***");
  return text.length > MAX_ERROR_CHARS ? text.slice(0, MAX_ERROR_CHARS) + "…" : text;
}

// Normalizes a raw exec failure into one of our typed errors. Shared by
// runDrive and runDriveRaw so both entry points fail the same way.
function normalizeExecError(err: unknown, args: string[]): never {
  if (
    err instanceof DriveCliError ||
    err instanceof DriveNotAuthenticatedError ||
    err instanceof DriveParseError
  ) {
    throw err;
  }

  const e = err as ExecError;

  if (e.cancelled) {
    throw new DriveCliError("Cancelled by client", "");
  }

  if (e.code === "ENOENT") {
    throw new DriveCliNotFoundError();
  }

  if (e.killed === true || e.code === "ETIMEDOUT") {
    const secs = timeoutFor(args) / 1000;
    throw new DriveCliError(`CLI process timed out after ${secs}s`, "");
  }

  if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    throw new DriveCliError("CLI output exceeded buffer limit (50 MB)", "");
  }

  if (isAuthError(`${e.stderr ?? ""}\n${e.stdout ?? ""}`)) {
    throw new DriveNotAuthenticatedError();
  }

  throw new DriveCliError(describeFailure(e), "");
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
  throw new Error("no JSON found");
}

export async function runDrive(args: string[]): Promise<unknown> {
  try {
    const { stdout, stderr } = await execCli([...args, "--json"], timeoutFor(args));

    const raw = stdout.trim();

    // Only check stderr for auth errors when stdout is empty. If the CLI wrote
    // valid JSON, we honour it even when warnings appear on stderr.
    if (!raw) {
      if (stderr && stderr.trim() && isAuthError(stderr)) {
        throw new DriveNotAuthenticatedError();
      }
      return null;
    }

    // Some commands (e.g. `sharing status`/`sharing remove-url` on an item
    // with no share record) call the CLI's own printObject(undefined, true)
    // helper, which does console.log(JSON.stringify(undefined)) — and
    // JSON.stringify(undefined) is the JS value undefined, so console.log
    // prints the literal 5 characters "undefined", not valid JSON. Confirmed
    // live against the real CLI (v0.8.0). Treat it the same as empty stdout.
    if (raw === "undefined") {
      return null;
    }

    try {
      return parseJsonLoose(raw);
    } catch {
      const snippet = stripAnsi(raw).slice(0, 200).replace(/\s+/g, " ");
      try { process.stderr.write(`[proton-drive-mcp] parse error: ${snippet}\n`); } catch { /* ignore EPIPE */ }
      throw new DriveParseError(`Failed to parse CLI output as JSON: ${snippet}`);
    }
  } catch (err) {
    normalizeExecError(err, args);
  }
}

// Some CLI commands (namely `version`) ignore --json entirely and always
// print plain text. This runs without appending --json and returns raw stdout.
export async function runDriveRaw(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execCli(args, timeoutFor(args));
    if (!stdout.trim() && stderr && stderr.trim() && isAuthError(stderr)) {
      throw new DriveNotAuthenticatedError();
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
    const child = spawn(CLI_BINARY, ["version"], {
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
