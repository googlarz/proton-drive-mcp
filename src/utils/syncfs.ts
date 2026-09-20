import { open, mkdir, realpath, lstat, stat } from "node:fs/promises";
import { constants as fsc } from "node:fs";
import { join, resolve, dirname, basename, relative, isAbsolute, sep } from "node:path";

const READ_LIMIT = 1 * 1024 * 1024; // 1 MB — prevent context overflow
const WRITE_LIMIT = 5 * 1024 * 1024; // 5 MB — cap content written via MCP
const NOFOLLOW = fsc.O_NOFOLLOW ?? 0; // 0 on platforms without it (Windows)

export function getSyncRoot(): string | null {
  return process.env["PROTON_DRIVE_SYNC_PATH"] ?? null;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + sep);
}

/** Map a remote Drive path to an absolute local path inside syncRoot. Lexical only; rejects traversal. */
export function resolveSyncPath(syncRoot: string, remotePath: string): string {
  const rel = remotePath.replace(/^\//, "");
  const resolved = resolve(join(syncRoot, rel));
  const root = resolve(syncRoot);
  if (!isInside(root, resolved)) {
    throw new Error(`path resolves outside sync root: ${remotePath}`);
  }
  return resolved;
}

/**
 * realpath of the deepest existing ancestor of p, with the not-yet-existing
 * remainder appended. A dangling symlink is refused (its target is unknowable).
 */
async function realResolve(p: string, remotePath: string): Promise<string> {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = await realpath(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      let isLink = false;
      try {
        isLink = (await lstat(cur)).isSymbolicLink();
      } catch {
        /* does not exist at all */
      }
      if (isLink) throw new Error(`path resolves outside sync root: ${remotePath}`);
      const parent = dirname(cur);
      if (parent === cur) throw e;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

async function realRootOf(syncRoot: string, remotePath: string): Promise<string> {
  return realResolve(resolve(syncRoot), remotePath);
}

function assertInside(realRoot: string, real: string, remotePath: string): void {
  if (!isInside(realRoot, real)) {
    throw new Error(`path resolves outside sync root: ${remotePath}`);
  }
}

/** Lexical + realpath containment. Returns { realRoot, real } for the target. */
async function containedReal(
  syncRoot: string,
  remotePath: string
): Promise<{ realRoot: string; real: string }> {
  const full = resolveSyncPath(syncRoot, remotePath);
  const realRoot = await realRootOf(syncRoot, remotePath);
  const real = await realResolve(full, remotePath);
  assertInside(realRoot, real, remotePath);
  return { realRoot, real };
}

export async function syncFileExists(syncRoot: string, remotePath: string): Promise<boolean> {
  const { real } = await containedReal(syncRoot, remotePath);
  try {
    await stat(real);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw e;
  }
}

export async function readSyncFile(syncRoot: string, remotePath: string): Promise<string> {
  const { real } = await containedReal(syncRoot, remotePath);
  // `real` has no symlinks; O_NOFOLLOW closes the swap-after-check window on the last component.
  const fh = await open(real, fsc.O_RDONLY | NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new Error(`${remotePath} is not a regular file.`);
    }
    if (st.size > READ_LIMIT) {
      throw new Error(
        `file is ${st.size} bytes — too large to read into context (limit 1 MB). Use drive_download instead.`
      );
    }
    // Bounded read: never load more than limit+1 even if the file grows after fstat.
    const buf = Buffer.alloc(READ_LIMIT + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > READ_LIMIT) {
      throw new Error(
        `file is over ${READ_LIMIT} bytes — too large to read into context (limit 1 MB). Use drive_download instead.`
      );
    }
    const data = buf.subarray(0, total);
    // Reject binary files (contain null bytes)
    if (data.includes(0)) {
      throw new Error(`${remotePath} appears to be a binary file. Use drive_download instead.`);
    }
    return data.toString("utf8");
  } finally {
    await fh.close();
  }
}

export async function writeSyncFile(
  syncRoot: string,
  remotePath: string,
  content: string
): Promise<void> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > WRITE_LIMIT) {
    throw new Error(
      `content is ${bytes} bytes — too large to write (limit 5 MB). Use drive_upload instead.`
    );
  }
  const full = resolveSyncPath(syncRoot, remotePath);
  const realRoot = await realRootOf(syncRoot, remotePath);
  const name = basename(full);
  const parent = dirname(full);

  // Check before creating anything so mkdir cannot create directories outside the root.
  assertInside(realRoot, await realResolve(parent, remotePath), remotePath);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  assertInside(realRoot, realParent, remotePath);

  const target = join(realParent, name);
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error(`refusing to write through a symlink: ${remotePath}`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const fh = await open(
    target,
    fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | NOFOLLOW,
    0o644
  );
  try {
    if (!(await fh.stat()).isFile()) {
      throw new Error(`${remotePath} is not a regular file.`);
    }
    await fh.writeFile(content, "utf8");
  } finally {
    await fh.close();
  }
}
