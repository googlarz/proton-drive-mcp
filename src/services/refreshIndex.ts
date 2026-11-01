import type { DriveService } from "./drive.js";
import { walkTree, settleIndexWrites, type WalkResult } from "./walk.js";
import { indexEnabled, indexMaxAgeMs, folderMaxAgeMs } from "./walkIndex.js";
import type { WalkFn } from "./analytics.js";

export const DEFAULT_BUDGET_MS = 25_000;
const MAX_BUDGET_MS = 120_000;
// The time budget is the real limit of a slice; this only keeps the per-walk call cap out of the way.
const REFRESH_MAX_CALLS = 1_000_000;
const ACCOUNT_ROOT = "/my-files";

export const REFRESH_NEEDS_INDEX = "drive_refresh_index needs PROTON_DRIVE_INDEX=1: it keeps folder listings, with the time each was read, in the plaintext local index (the same private folder and trade-off as the walk index). Set PROTON_DRIVE_INDEX=1 and restart the server.";

export interface RefreshIndexArgs { path?: string; timeBudgetMs?: number; maxAgeHours?: number; changes?: boolean }

/**
 * One slice of an incremental refresh of the saved folder index: lists the folders whose saved listing is older than
 * `maxAgeHours` (or was never read), oldest first, until the time budget is used, and saves the progress. Repeat until
 * `complete`. Folders younger than the age are not listed, so changes below them are not seen yet.
 */
export async function driveRefreshIndex(drive: DriveService, o: RefreshIndexArgs, deps: { walk?: WalkFn; settle?: () => Promise<boolean> } = {}) {
  if (!indexEnabled() || indexMaxAgeMs() <= 0) throw new Error(REFRESH_NEEDS_INDEX);
  const path = o.path ?? ACCOUNT_ROOT;
  if (path !== ACCOUNT_ROOT && !path.startsWith(`${ACCOUNT_ROOT}/`)) throw new Error(`path must be ${ACCOUNT_ROOT} or a folder below it: the index only saves walks inside your Drive`);
  const budget = o.timeBudgetMs ?? DEFAULT_BUDGET_MS;
  if (!Number.isInteger(budget) || budget < 1000 || budget > MAX_BUDGET_MS) throw new Error(`timeBudgetMs must be an integer from 1000 to ${MAX_BUDGET_MS}`);
  const maxAgeHours = o.maxAgeHours ?? folderMaxAgeMs() / 3_600_000;
  if (typeof maxAgeHours !== "number" || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    throw new Error("maxAgeHours must be a number above 0 (with PROTON_DRIVE_INDEX_FOLDER_MAX_AGE_H=0, which disables reuse, pass it explicitly)");
  }
  const started = Date.now();
  const walk: WalkResult = await (deps.walk ?? walkTree)(drive, path, {
    resumable: true, budgetMs: budget, maxCalls: REFRESH_MAX_CALLS, maxListingAgeMs: maxAgeHours * 3_600_000, trackChanges: o.changes === true,
  });
  const saved = await (deps.settle ?? settleIndexWrites)();

  const refreshed = walk.foldersRefreshed ?? 0;
  const remaining = walk.foldersRemaining ?? 0;
  const failures = walk.skipped.filter((s) => !/^not (listed|refreshed)/.test(s.reason));
  const notes: string[] = [];
  if (!saved) notes.push("The progress could not be saved (a write through this server during the slice, a full size cap, or an index folder that is not private); the next call starts from the last saved state.");
  if (failures.length > 0) notes.push("Some folders could not be listed; they stay as they were and the next call retries them.");
  if (!walk.complete && refreshed === 0 && failures.length === 0) notes.push("Nothing was listed in this slice; raise timeBudgetMs.");
  if (o.changes) notes.push("changes covers only the folders re-listed in this call, compared with their previous saved listing; a folder listed for the first time reports all its entries as added.");
  return {
    path,
    complete: walk.complete,
    ...(walk.partial ? { partial: true, continuing: true } : {}),
    foldersRefreshed: refreshed,
    foldersReused: walk.foldersReused ?? 0,
    foldersRemaining: remaining,
    oldestListingAgeMs: walk.oldestListingAgeMs ?? walk.ageMs,
    maxAgeHours,
    // Calls still needed at this call's pace; folders found below new folders can raise it.
    etaCalls: remaining === 0 ? 0 : refreshed > 0 ? Math.ceil(remaining / refreshed) : null,
    entries: walk.nodes.length,
    callsMade: walk.callsMade,
    saved,
    elapsedMs: Date.now() - started,
    ...(failures.length ? { failedCount: failures.length, failed: failures.slice(0, 10) } : {}),
    ...(walk.changes ? { changes: walk.changes } : {}),
    note: notes.join(" ") || undefined,
  };
}
