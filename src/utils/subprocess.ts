import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DriveCliError, DriveCliNotFoundError, DriveNotAuthenticatedError, DriveParseError } from "./errors.js";

const execFileAsync = promisify(execFile);

const CLI_BINARY = process.env["PROTON_DRIVE_BIN"] ?? "proton-drive";
const DEFAULT_TIMEOUT_MS = 60_000;
// Upload and download transfer actual file bytes — use a much longer timeout.
const TRANSFER_TIMEOUT_MS = 30 * 60_000; // 30 minutes

const TRANSFER_COMMANDS = new Set(["upload", "download"]);
const TRANSFER_GROUPS = new Set(["filesystem", "photo"]);

function timeoutFor(args: string[]): number {
  // args[0] is the group (e.g. "filesystem"), args[1] is the subcommand
  if (args[0] && TRANSFER_GROUPS.has(args[0]) && args[1] && TRANSFER_COMMANDS.has(args[1])) {
    return TRANSFER_TIMEOUT_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}

function isAuthError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("not authenticated") ||
    lower.includes("not logged in") ||
    lower.includes("you need to login first")
  );
}

// Normalizes a raw execFile failure into one of our typed errors. Shared by
// runDrive and runDriveRaw so both entry points fail the same way.
function normalizeExecError(err: unknown, args: string[]): never {
  if (
    err instanceof DriveCliError ||
    err instanceof DriveNotAuthenticatedError ||
    err instanceof DriveParseError
  ) {
    throw err;
  }

  const e = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string; signal?: string };

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

  const stderr = e.stderr ?? "";
  if (isAuthError(stderr)) {
    throw new DriveNotAuthenticatedError();
  }

  throw new DriveCliError(e.message ?? String(e), stderr);
}

export async function runDrive(args: string[]): Promise<unknown> {
  try {
    const { stdout, stderr } = await execFileAsync(
      CLI_BINARY,
      [...args, "--json"],
      { timeout: timeoutFor(args), maxBuffer: 50 * 1024 * 1024, killSignal: "SIGKILL" }
    );

    const raw = stdout.trim();

    // Only check stderr for auth errors when stdout is empty. If the CLI wrote
    // valid JSON, we honour it even when warnings appear on stderr.
    if (!raw) {
      if (stderr && stderr.trim() && isAuthError(stderr)) {
        throw new DriveNotAuthenticatedError();
      }
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch {
      try { process.stderr.write(`[proton-drive-mcp] parse error: ${raw.slice(0, 500)}\n`); } catch { /* ignore EPIPE */ }
      throw new DriveParseError("Failed to parse CLI output as JSON");
    }
  } catch (err) {
    normalizeExecError(err, args);
  }
}

// Some CLI commands (namely `version`) ignore --json entirely and always
// print plain text. This runs without appending --json and returns raw stdout.
export async function runDriveRaw(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      CLI_BINARY,
      args,
      { timeout: timeoutFor(args), maxBuffer: 50 * 1024 * 1024, killSignal: "SIGKILL" }
    );
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
  try {
    await execFileAsync(CLI_BINARY, ["version"], { timeout: 5_000 });
    return { available: true };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { available: false, reason: "not_found" };
    if (err.code === "EACCES") return { available: false, reason: "not_executable" };
    return { available: true };
  }
}
