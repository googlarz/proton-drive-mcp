import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";

const READ_LIMIT = 1 * 1024 * 1024; // 1 MB — prevent context overflow

export function getSyncRoot(): string | null {
  return process.env["PROTON_DRIVE_SYNC_PATH"] ?? null;
}

/** Map a remote Drive path to an absolute local path inside syncRoot. Rejects traversal. */
export function resolveSyncPath(syncRoot: string, remotePath: string): string {
  const relative = remotePath.replace(/^\//, "");
  const resolved = resolve(join(syncRoot, relative));
  const root = resolve(syncRoot);
  if (resolved !== root && !resolved.startsWith(root + "/")) {
    throw new Error(`path resolves outside sync root: ${remotePath}`);
  }
  return resolved;
}

export async function readSyncFile(syncRoot: string, remotePath: string): Promise<string> {
  const fullPath = resolveSyncPath(syncRoot, remotePath);
  const buf = await readFile(fullPath);
  if (buf.length > READ_LIMIT) {
    throw new Error(
      `file is ${buf.length} bytes — too large to read into context (limit 1 MB). Use drive_download instead.`
    );
  }
  // Reject binary files (contain null bytes)
  if (buf.includes(0)) {
    throw new Error(`${remotePath} appears to be a binary file. Use drive_download instead.`);
  }
  return buf.toString("utf8");
}

export async function writeSyncFile(
  syncRoot: string,
  remotePath: string,
  content: string
): Promise<void> {
  const fullPath = resolveSyncPath(syncRoot, remotePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
}
