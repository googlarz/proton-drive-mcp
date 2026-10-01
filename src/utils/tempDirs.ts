import { rmSync } from "node:fs";

const live = new Set<string>();

/** Tracks a temp dir that must not outlive the process (shutdown() skips the callers' `finally` blocks). */
export const registerTempDir = (dir: string): void => { live.add(dir); };
export const unregisterTempDir = (dir: string): void => { live.delete(dir); };

/** Synchronous so it can run right before process.exit. */
export function removeAllTempDirsSync(): void {
  for (const dir of live) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  live.clear();
}
