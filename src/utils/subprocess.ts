import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DriveCliError, DriveCliNotFoundError, DriveNotAuthenticatedError, DriveParseError } from "./errors.js";

const execFileAsync = promisify(execFile);

const CLI_BINARY = "proton-drive";
const DEFAULT_TIMEOUT_MS = 60_000;
// Upload and download transfer actual file bytes — use a much longer timeout.
const TRANSFER_TIMEOUT_MS = 30 * 60_000; // 30 minutes

const TRANSFER_COMMANDS = new Set(["upload", "download"]);

function timeoutFor(args: string[]): number {
  // args[0] is the group (e.g. "filesystem"), args[1] is the subcommand
  if (args[0] === "filesystem" && args[1] && TRANSFER_COMMANDS.has(args[1])) {
    return TRANSFER_TIMEOUT_MS;
  }
  return DEFAULT_TIMEOUT_MS;
}

export async function runDrive(args: string[]): Promise<unknown> {
  try {
    const { stdout, stderr } = await execFileAsync(
      CLI_BINARY,
      [...args, "--json"],
      { timeout: timeoutFor(args) }
    );

    if (stderr && stderr.trim()) {
      const lower = stderr.toLowerCase();
      if (lower.includes("not authenticated") || lower.includes("not logged in")) {
        throw new DriveNotAuthenticatedError();
      }
    }

    const raw = stdout.trim();
    if (!raw) return null;

    try {
      return JSON.parse(raw);
    } catch {
      throw new DriveParseError(raw);
    }
  } catch (err) {
    if (
      err instanceof DriveCliError ||
      err instanceof DriveNotAuthenticatedError ||
      err instanceof DriveParseError
    ) {
      throw err;
    }

    const e = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };

    if (e.code === "ENOENT") {
      throw new DriveCliNotFoundError();
    }

    if (e.killed === true) {
      const secs = timeoutFor(args) / 1000;
      throw new DriveCliError(`CLI process timed out after ${secs}s`, "");
    }

    const stderr = e.stderr ?? "";
    const lower = stderr.toLowerCase();
    if (lower.includes("not authenticated") || lower.includes("not logged in")) {
      throw new DriveNotAuthenticatedError();
    }

    throw new DriveCliError(e.message ?? String(e), stderr);
  }
}

// Returns false only when the binary is not installed (ENOENT). Any other
// error (non-zero exit, auth required, etc.) still returns true — the binary
// is present and real errors will surface on the first actual tool call.
export async function checkCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync(CLI_BINARY, ["version", "--json"], { timeout: 5_000 });
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code !== "ENOENT";
  }
}
