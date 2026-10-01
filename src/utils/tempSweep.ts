import { readdir, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = /^pdmcp-(?:read|dup)-/;

/**
 * Best-effort: removes pdmcp-read-* / pdmcp-dup-* temp dirs left by a killed process (SIGTERM mid-download).
 * Only real directories (lstat, never followed) owned by this uid and older than maxAgeMs are touched.
 */
export async function sweepStaleTempDirs(dir = tmpdir(), maxAgeMs = 3600_000): Promise<void> {
  const uid = process.getuid?.();
  let names: string[];
  try { names = (await readdir(dir)).filter((n) => PREFIX.test(n)); } catch { return; }
  for (const n of names) {
    try {
      const p = join(dir, n);
      const st = await lstat(p);
      if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || Date.now() - st.mtimeMs < maxAgeMs) continue;
      await rm(p, { recursive: true, force: true });
    } catch { /* gone, busy or not ours: skip */ }
  }
}
