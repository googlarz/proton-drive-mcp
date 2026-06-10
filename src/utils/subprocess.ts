import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DriveCliError, DriveCliNotFoundError, DriveNotAuthenticatedError, DriveParseError } from "./errors.js";

const execFileAsync = promisify(execFile);

const CLI_BINARY = "proton-drive";
const DEFAULT_TIMEOUT_MS = 60_000;

export async function runDrive(args: string[]): Promise<unknown> {
  try {
    const { stdout, stderr } = await execFileAsync(
      CLI_BINARY,
      [...args, "--json"],
      { timeout: DEFAULT_TIMEOUT_MS }
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

    const e = err as NodeJS.ErrnoException;

    if (e.code === "ENOENT") {
      throw new DriveCliNotFoundError();
    }

    const stderr = (e as { stderr?: string }).stderr ?? "";
    const lower = stderr.toLowerCase();
    if (lower.includes("not authenticated") || lower.includes("not logged in")) {
      throw new DriveNotAuthenticatedError();
    }

    throw new DriveCliError(e.message ?? String(e), stderr);
  }
}

export async function checkCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync(CLI_BINARY, ["version"], { timeout: 5_000 });
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code !== "ENOENT";
  }
}
