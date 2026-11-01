import { joinRemote, splitRemotePath, type DriveService } from "./drive.js";

const isNotFound = (err: unknown) => err instanceof Error && /not found/i.test(err.message);

/** PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE: opt-in, "1" or "true". */
export function snapshotEnabled(): boolean {
  const v = (process.env.PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

export type Snapshot = { snapshot?: string; warning?: string };

/**
 * Copies the existing remote file to <same parent>/.versions/<name>.<UTC timestamp> before something overwrites it.
 * Throws when a copy was needed and could not be made; the caller must then refuse the overwrite. Nothing to preserve
 * (no remote file yet) returns {}; a folder is not copied and returns a warning.
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
  if ((node as { type?: unknown } | null)?.type === "folder") return { warning: `snapshot skipped: ${remotePath} is a folder` };

  const { parent, name } = splitRemotePath(remotePath);
  const dir = joinRemote(parent, ".versions");
  const copyName = `${name}.${new Date().toISOString().replace(/[-:]/g, "")}`; // 20261101T123456.789Z
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
