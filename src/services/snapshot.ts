import { joinRemote, splitRemotePath, type DriveService } from "./drive.js";
import { DriveCliError } from "../utils/errors.js";
import { copySyncFile } from "../utils/syncfs.js";

// Only the CLI's own "Node not found" / "Item not found" answer means the path does not exist. Anything else that merely
// contains "not found" (CLI missing from PATH, a bad session) is an unknown state, so the caller must fail closed.
const isNotFound = (err: unknown) => err instanceof DriveCliError && /\b(node|item) not found\b/i.test(err.message);

/** PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE: opt-in, "1" or "true". */
export function snapshotEnabled(): boolean {
  const v = (process.env.PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export type Snapshot = { snapshot?: string };

const versionName = (name: string) => `${name}.${new Date().toISOString().replace(/[-:]/g, "")}`; // 20261101T123456.789Z

/**
 * Copies the existing remote file to <same parent>/.versions/<name>.<UTC timestamp> before something overwrites it.
 * Throws when a copy was needed and could not be made (including a folder, which is not versioned and is never skipped
 * silently); the caller must then refuse the overwrite. Nothing to preserve (no remote file yet) returns {}.
 * `allow` vets the .versions folder against PROTON_DRIVE_REMOTE_ROOTS.
 */
export async function snapshotBeforeOverwrite(drive: DriveService, remotePath: string, allow: (path: string) => boolean): Promise<Snapshot> {
  let node: unknown;
  try {
    node = await drive.info(remotePath);
  } catch (err) {
    if (isNotFound(err)) return {};
    throw err;
  }
  if ((node as { type?: unknown } | null)?.type === "folder") throw new Error(`${remotePath} is a folder, which is not versioned`);

  const { parent, name } = splitRemotePath(remotePath);
  const dir = joinRemote(parent, ".versions");
  const copyName = versionName(name);
  const copy = joinRemote(dir, copyName);
  if (!allow(dir) || !allow(copy)) throw new Error(`${dir} is outside PROTON_DRIVE_REMOTE_ROOTS`);
  try {
    await drive.info(dir);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await drive.mkdir(dir);
  }
  await drive.copy(remotePath, dir, copyName);
  return { snapshot: copy };
}

/**
 * Copies the existing LOCAL sync-folder file to <same dir>/.versions/<name>.<UTC timestamp> before drive_write_file
 * overwrites it (the sync client then uploads the copy). Unlike the remote copy this keeps unsynced local edits, and
 * works for a file that was never uploaded. Never replaces an existing snapshot. Throws when the copy cannot be made;
 * the caller must then refuse the overwrite. `remotePath` is in the /my-files form; `allow` vets the .versions folder.
 */
export async function snapshotLocalBeforeOverwrite(syncRoot: string, remotePath: string, allow: (path: string) => boolean): Promise<Snapshot> {
  const { parent, name } = splitRemotePath(remotePath);
  const dir = joinRemote(parent, ".versions");
  const copy = joinRemote(dir, versionName(name));
  if (!allow(dir) || !allow(copy)) throw new Error(`${dir} is outside PROTON_DRIVE_REMOTE_ROOTS`);
  await copySyncFile(syncRoot, remotePath, copy);
  return { snapshot: copy };
}
