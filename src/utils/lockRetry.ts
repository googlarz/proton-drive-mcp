const LOCKED_RE = /database is locked|SQLITE_BUSY/i;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The CLI's SQLite cache can report "database is locked" at startup when several downloads run
 * at once; nothing has been transferred then, so a fresh attempt is safe (max 4 tries).
 * `once` must be self-contained (own temp dir): each attempt starts clean.
 */
export async function retryOnLocked<T>(once: () => Promise<T>): Promise<T> {
  const base = Number(process.env["PROTON_DRIVE_RETRY_BASE_MS"] ?? 250);
  for (let attempt = 1; ; attempt++) {
    try {
      return await once();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt >= 4 || !LOCKED_RE.test(msg)) throw e;
      await sleep(base * attempt + Math.random() * base);
    }
  }
}
