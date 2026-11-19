import type { DriveService } from "./drive.js";
import { ROOT_PATHS, splitRemotePath } from "./drive.js";
import { walkTree, DEFAULT_EXCLUDE, staleFields, type WalkResult } from "./walk.js";
import { driveSharingAudit, findDuplicateCandidates, makeDriveHasher, summarizeTrash, verifyGroups, type DuplicateGroup } from "./analytics.js";
import { computeCheckup, checkupFindingPage, type CheckupFinding, type SharingAuditInput } from "./checkup.js";
import { planCleanup, type CleanupFix, type CleanupPlanOk } from "./cleanup.js";
import { callContext } from "../utils/subprocess.js";

/**
 * Server-side orchestration of drive_checkup and the plan step of drive_cleanup (1.12.0). Read-only: nothing here changes Drive.
 * The pure logic lives in checkup.ts and cleanup.ts; this file only gathers their inputs (walk, trash, sharing).
 */

export interface CheckupRunOptions {
  path: string;
  finding?: CheckupFinding;
  limit?: number;
  offset?: number;
  olderThanDays?: number;
  minSizeMB?: number;
  sharing: boolean;
  refresh?: boolean;
  /** PROTON_DRIVE_REMOTE_ROOTS is set: the trash is account-wide, so it is not read. */
  skipTrash: boolean;
}

const distinctNames = (items: Record<string, unknown>[]): number => {
  const seen = new Set<string>();
  for (const it of items) for (const k of ["path", "keeper", "sharedVia"]) if (typeof it[k] === "string") seen.add(it[k] as string);
  return seen.size;
};

/** `drive_checkup`: the summary (plan 3.1) or one page of a finding. Same walk cache and time budget as drive_usage. */
export async function runCheckup(drive: DriveService, o: CheckupRunOptions, now = Date.now()): Promise<unknown> {
  const walk = await walkTree(drive, o.path, { refresh: o.refresh });
  const files = walk.nodes.filter((n) => n.type === "file");
  const scanInfo = {
    files: files.length,
    folders: walk.nodes.length - files.length,
    bytes: files.reduce((s, f) => s + (f.size ?? 0), 0),
    complete: walk.complete,
    ...(walk.partial ? { partial: true } : {}),
    ageMs: walk.ageMs,
  };
  const extraCaveats: string[] = [];
  if (walk.stale) extraCaveats.push("The listing comes from the saved folder index and can be out of date; pass refresh=true for a current one.");

  // A partial scan returns at once ("call again"): the sharing audit would only add calls to a result that is incomplete anyway.
  const wantSharing = o.sharing && !walk.partial;
  const needsAudit = o.finding === undefined || o.finding === "public-links" || o.finding === "outside-access";
  let audit: SharingAuditInput | undefined;
  if (wantSharing && needsAudit) {
    try {
      // The audit reads the walk it is given: no second walk, no second time budget.
      audit = await driveSharingAudit(drive, { path: o.path }, { walk: async () => walk });
    } catch (e) {
      extraCaveats.push(`The sharing audit failed (${e instanceof Error ? e.message : String(e)}), so link expiry and invitee details are unknown.`);
    }
  }

  if (o.finding !== undefined) {
    const page = checkupFindingPage(walk.nodes, o.finding, {
      limit: o.limit, offset: o.offset, olderThanDays: o.olderThanDays, minSizeMB: o.minSizeMB, now,
      rootPath: o.path, complete: walk.complete && !walk.partial, sharingAudit: audit,
    });
    const caveats = [...extraCaveats];
    if (walk.partial) caveats.push("The scan is partial (the drive walk was still running): call again in a minute for the full list.");
    else if (!walk.complete) caveats.push("The scan is incomplete (some folders could not be listed), so the list can be too short.");
    if (!o.sharing && (o.finding === "public-links" || o.finding === "outside-access")) caveats.push("Sharing details were skipped (sharing: false): expiry and external invitees are unknown.");
    return { path: o.path, scanned: scanInfo, ...page, namesInResult: distinctNames(page.items), caveats, ...staleFields(walk) };
  }

  let trash = { count: 0, bytes: 0 };
  if (o.skipTrash) {
    extraCaveats.push("The trash is not included while PROTON_DRIVE_REMOTE_ROOTS is set (it holds items from the whole account).");
  } else {
    try {
      const t = summarizeTrash(await drive.listTrash());
      trash = { count: t.count, bytes: t.bytes };
    } catch (e) {
      extraCaveats.push(`The trash could not be read (${e instanceof Error ? e.message : String(e)}).`);
    }
  }
  const summary = computeCheckup({
    nodes: walk.nodes, rootPath: o.path, trash, sharingAudit: audit,
    opts: { olderThanDays: o.olderThanDays, minSizeMB: o.minSizeMB, now, sharing: wantSharing, scanInfo },
  });
  summary.caveats.push(...extraCaveats);
  return summary;
}

/**
 * Whether `path` or any folder above it is shared or under a public link. The walk lists children only, so this reads the
 * listing flags of `path` and of each ancestor (one listing per level, the same flags the walk uses). Anything that cannot be
 * determined counts as shared (fail closed), as the cleanup planner expects.
 */
export async function pathOrAncestorShared(drive: DriveService, path: string): Promise<boolean> {
  try {
    for (let p = path; p !== "/" && !ROOT_PATHS.has(p); p = splitRemotePath(p).parent) {
      const entry = (await drive.listEntries(splitRemotePath(p).parent)).find((e) => e.file.path === p);
      if (!entry) return true;
      const { isShared, isSharedByUrl } = entry.item;
      if (isShared === true || isSharedByUrl === true) return true;
      if (isShared === undefined && isSharedByUrl === undefined) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export type CleanupRun = { plan: CleanupPlanOk; verified: boolean } | { refusal: string };

/**
 * The plan step of drive_cleanup: a fresh, complete walk (never the saved index, no time budget), the names in /trash, the share
 * state above the path and, with `verify`, sha256-confirmed duplicate groups. Anything incomplete is refused, never planned.
 */
export async function computeCleanupPlan(drive: DriveService, o: { path: string; fixes: CleanupFix[]; verify: boolean }): Promise<CleanupRun> {
  const walk: WalkResult = await walkTree(drive, o.path, { refresh: true, noDisk: true, budgetMs: 0, exclude: DEFAULT_EXCLUDE });
  const stale = walk.stale === true || walk.partial === true;
  if (stale) return { refusal: "the drive listing is partial or stale; run the plan again for a fresh one" };
  if (!walk.complete || walk.skipped.length > 0) {
    const why = walk.skipped[0] ? ` (${walk.skipped.length} folder(s) not listed, first: ${walk.skipped[0].path}: ${walk.skipped[0].reason})` : "";
    return { refusal: `part of ${o.path} could not be listed${why}; cleanup needs a complete listing, so nothing is proposed. Try again or pick a smaller folder.` };
  }
  const trashNames = new Map<string, number>();
  for (const t of await drive.listTrash()) trashNames.set(t.name, (trashNames.get(t.name) ?? 0) + 1);
  const rootShared = await pathOrAncestorShared(drive, o.path);

  let verifiedGroups: (DuplicateGroup & { verifyNote?: string })[] | undefined;
  if (o.verify && o.fixes.includes("duplicates")) {
    verifiedGroups = await verifyGroups(findDuplicateCandidates(walk.nodes, 1024), makeDriveHasher(drive), {
      maxVerifyBytes: 50_000_000, signal: callContext.getStore()?.signal,
    });
  }
  const res = planCleanup({
    nodes: walk.nodes, rootPath: o.path, fixes: o.fixes, verifiedGroups, trashNames,
    complete: walk.complete, skippedUnderPath: walk.skipped.length > 0, stale,
    rootShared, exclude: DEFAULT_EXCLUDE,
  });
  return res.ok ? { plan: res, verified: verifiedGroups !== undefined } : { refusal: res.reason };
}
