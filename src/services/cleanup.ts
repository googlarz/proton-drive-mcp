import { createHash } from "node:crypto";
import { findDuplicateCandidates, keeperOf, type DuplicateGroup } from "./analytics.js";
import { baseName, parentPath, DEFAULT_EXCLUDE, type WalkNode } from "./walk.js";
import { canonical } from "../utils/audit.js";

// ---- drive_cleanup: the pure planner --------------------------------------------------------------------------
// No I/O. The server walks the drive, lists /trash, optionally verifies duplicate groups, and hands the results here.
// The model never names a path: every item below comes from the walk, and the keeper of a duplicate group is never listed.

export type CleanupFix = "duplicates" | "empty-folders";
export type CleanupKind = "duplicate" | "empty-folder";

export const CLEANUP_CAP = 200;
export const TRASH_NAME_REASON = "name already in trash (not reliably restorable)";

export interface CleanupItem {
  path: string;
  uid: string;
  parentUid?: string;
  /** Unescaped item name (what `filesystem restore` and /trash list by). */
  name: string;
  size: number;
  kind: CleanupKind;
  /** Duplicates only: path of the copy that stays. */
  keeps?: string;
}

export interface CleanupInput {
  nodes: WalkNode[];
  rootPath: string;
  fixes: CleanupFix[];
  /** Result of verifyGroups for `verify: true`. When given, it is the ONLY source of duplicate groups (kind "verified"). */
  verifiedGroups?: (DuplicateGroup & { verifyNote?: string })[];
  /** Name -> number of items of that name in /trash right now. */
  trashNames: Map<string, number>;
  /** WalkResult.complete. */
  complete: boolean;
  /** true when anything under rootPath was skipped (WalkResult.skipped touching the path). */
  skippedUnderPath?: boolean;
  /** WalkResult.stale or partial. */
  stale?: boolean;
  /**
   * Whether rootPath itself, or any folder above it, is shared or under a shared link. The walk lists children only, so it cannot
   * tell; the caller must look it up. Anything but an explicit `false` is treated as shared (fail safe).
   */
  rootShared: boolean;
  /** Folder names the walk did not descend into (default: the walk's DEFAULT_EXCLUDE). A folder that holds one is never "empty". */
  exclude?: string[];
  /** Smallest file considered for duplicates (default 1024, as drive_find_duplicates). */
  minSize?: number;
  /** Items per call (default 200). */
  cap?: number;
}

export type CleanupPlanOk = {
  ok: true;
  items: CleanupItem[];
  /** Describe `items` (this call), not everything eligible. */
  counts: { duplicates: number; emptyFolders: number };
  bytes: number;
  skipped: { count: number; reason: string }[];
  /** Eligible items beyond the cap, still to do in later calls. */
  remaining: number;
};
export type CleanupPlan = { ok: false; reason: string } | CleanupPlanOk;

const REASON = {
  outside: "outside the cleanup path",
  notIdentical: "needs verify: not provably identical",
  shared: "needs verify: shared, in a shared folder or link, or share status unknown",
  notVerified: "not verified (verify budget reached, download failed or group changed)",
  staleVerified: "verified group no longer matches the current listing",
  sharedFolder: "shared, in a shared folder or link, or share status unknown (left for a manual decision)",
};

const refuse = (reason: string): CleanupPlan => ({ ok: false, reason });
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const normRoot = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);

/** 0 = known unshared, 1 = unknown, 2 = shared. Unknown means the listing gave no share flag at all. */
type Share = 0 | 1 | 2;
const ownShare = (n: WalkNode): Share =>
  n.isShared === true || n.isSharedByUrl === true ? 2 : n.isShared === undefined && n.isSharedByUrl === undefined ? 1 : 0;

export function planCleanup(input: CleanupInput): CleanupPlan {
  const cap = input.cap ?? CLEANUP_CAP;
  if (!Number.isInteger(cap) || cap < 1) return refuse("invalid cap");
  if (!input.complete) return refuse("the drive walk is incomplete; cleanup needs a complete listing of the path");
  if (input.skippedUnderPath) return refuse("part of the path was not listed (skipped); cleanup needs a complete listing");
  if (input.stale) return refuse("the drive listing is stale or partial; run the plan again on fresh data");
  const fixes = new Set(input.fixes);
  if (fixes.size === 0) return refuse("no fixes requested");
  for (const f of fixes) if (f !== "duplicates" && f !== "empty-folders") return refuse(`unknown fix: ${String(f)}`);

  const root = normRoot(input.rootPath);
  const inside = (p: string) => p !== root && (root === "/" ? p.startsWith("/") : p.startsWith(root + "/"));
  // Fail closed: a node we cannot identify under the path could be the only child of a "empty" folder or a hidden group member.
  const usable = (n: WalkNode) => typeof n.uid === "string" && n.uid !== "";
  const under = input.nodes.filter((n) => typeof n.path === "string" && (n.path === root || inside(n.path)));
  if (under.some((n) => !usable(n))) return refuse("the listing has an entry without a usable uid under the path; cleanup needs every entry identified");
  if (new Set(under.map((n) => n.uid)).size !== under.length) return refuse("the listing has two entries with the same uid under the path; cleanup needs unique entries");
  const nodes = input.nodes.filter(usable); // only entries outside the path can be uid-less here, and they are ignored below
  const byUid = new Map<string, WalkNode>();
  const byPath = new Map<string, WalkNode>();
  for (const n of nodes) { byUid.set(n.uid, n); byPath.set(n.path, n); }

  const skipped = new Map<string, number>();
  const skip = (reason: string, n: number) => { if (n > 0) skipped.set(reason, (skipped.get(reason) ?? 0) + n); };

  // Sharing along the parentUid chain (path-parent as a fallback), ending at rootShared.
  const shareMemo = new Map<string, Share>();
  const rootBase: Share = input.rootShared === false ? 0 : 2;
  const chainShare = (n: WalkNode, seen = new Set<string>()): Share => {
    const hit = shareMemo.get(n.uid);
    if (hit !== undefined) return hit;
    if (seen.has(n.uid)) return 2; // parent cycle: never provable
    seen.add(n.uid);
    if (n.path === root) { // the walk root itself, when the listing includes it: the caller's answer covers it and everything above
      const s: Share = Math.max(rootBase, ownShare(n) === 2 ? 2 : 0) as Share;
      shareMemo.set(n.uid, s);
      return s;
    }
    const pPath = parentPath(n.path);
    // parentUid, when given, must name a node we have AND agree with the path; the walk root's own uid is not in the listing.
    const viaUid = n.parentUid ? byUid.get(n.parentUid) : undefined;
    const parent = n.parentUid ? (viaUid && viaUid.path === pPath ? viaUid : undefined) : byPath.get(pPath);
    const above: Share = parent ? chainShare(parent, seen) : pPath === root && (!n.parentUid || !viaUid) ? rootBase : 1;
    const s = Math.max(ownShare(n), above) as Share;
    shareMemo.set(n.uid, s);
    return s;
  };

  const eligible: CleanupItem[] = [];
  const keeperUids = new Set<string>();
  const itemOf = (n: WalkNode, kind: CleanupKind, keeps?: string): CleanupItem => ({
    path: n.path, uid: n.uid, parentUid: n.parentUid, name: baseName(n.path), size: kind === "duplicate" ? n.size ?? 0 : 0, kind,
    ...(keeps === undefined ? {} : { keeps }),
  });

  if (fixes.has("duplicates")) {
    const take = (members: WalkNode[], identical: boolean, checkShare: boolean) => {
      const keeper = keeperOf(members);
      keeperUids.add(keeper.uid);
      const rest = members.filter((m) => m.uid !== keeper.uid);
      if (!members.every((m) => inside(m.path))) return skip(REASON.outside, rest.length);
      if (!identical) return skip(REASON.notIdentical, rest.length);
      if (checkShare && !members.every((m) => chainShare(m) === 0)) return skip(REASON.shared, rest.length);
      for (const m of rest) eligible.push(itemOf(m, "duplicate", keeper.path));
    };

    if (input.verifiedGroups) {
      // verify: true -> only sha256-confirmed groups count; every member must still match the current listing.
      for (const g of input.verifiedGroups) {
        if (g.kind !== "verified" || g.verifyNote) { skip(REASON.notVerified, Math.max(0, g.members.length - 1)); continue; }
        const members = g.members.map((m) => byUid.get(m.uid));
        const first = members[0];
        const current = members.length >= 2 && g.members.every((m, i) => {
          const w = members[i];
          return w !== undefined && w.type === "file" && w.path === m.path && w.size === m.size && w.sha1 === m.sha1 && w.size !== undefined && w.size === first?.size;
        });
        if (!current) { skip(REASON.staleVerified, Math.max(0, g.members.length - 1)); continue; }
        take(members as WalkNode[], true, false);
      }
    } else {
      for (const g of findDuplicateCandidates(nodes, input.minSize ?? 1024)) {
        take(g.members, g.kind === "claimed-sha1" && g.members.every((m) => m.size === g.members[0].size), true);
      }
    }
  }

  if (fixes.has("empty-folders")) {
    const exclude = new Set(input.exclude ?? DEFAULT_EXCLUDE);
    const folders = nodes.filter((n) => n.type === "folder" && inside(n.path));
    const kids = new Map<string, Map<string, WalkNode>>();
    const addKid = (key: string, n: WalkNode) => { (kids.get(key) ?? kids.set(key, new Map()).get(key)!).set(n.uid, n); };
    for (const n of nodes) {
      if (!inside(n.path)) continue;
      addKid("p:" + parentPath(n.path), n);
      if (n.parentUid) addKid("u:" + n.parentUid, n);
    }
    const childrenOf = (f: WalkNode): WalkNode[] => {
      const m = new Map<string, WalkNode>();
      for (const k of ["p:" + f.path, "u:" + f.uid]) for (const [u, c] of kids.get(k) ?? []) if (u !== f.uid) m.set(u, c);
      return [...m.values()];
    };

    // "Empty" = no file anywhere below, and no folder the walk did not open (excluded names such as .git).
    const emptyMemo = new Map<string, boolean>();
    const isEmpty = (f: WalkNode, seen = new Set<string>()): boolean => {
      const hit = emptyMemo.get(f.uid);
      if (hit !== undefined) return hit;
      if (seen.has(f.uid)) return false;
      seen.add(f.uid);
      const r = !exclude.has(baseName(f.path)) && childrenOf(f).every((c) => c.type === "folder" && isEmpty(c, seen));
      emptyMemo.set(f.uid, r);
      return r;
    };
    const subMemo = new Map<string, Share>();
    const subtreeShare = (f: WalkNode): Share => {
      const hit = subMemo.get(f.uid);
      if (hit !== undefined) return hit;
      const r = childrenOf(f).reduce<Share>((s, c) => Math.max(s, subtreeShare(c)) as Share, chainShare(f));
      subMemo.set(f.uid, r);
      return r;
    };

    const emptySet = folders.filter((f) => isEmpty(f));
    const emptyUids = new Set(emptySet.map((f) => f.uid));
    const parentOfFolder = (f: WalkNode) => (f.parentUid ? byUid.get(f.parentUid) : undefined) ?? byPath.get(parentPath(f.path));
    const propose = (f: WalkNode) => {
      if (subtreeShare(f) === 0) { eligible.push(itemOf(f, "empty-folder")); return; }
      skip(REASON.sharedFolder, 1);
      if (chainShare(f) === 0) for (const c of childrenOf(f)) if (c.type === "folder") propose(c);
    };
    for (const f of emptySet) {
      const p = parentOfFolder(f);
      if (p && emptyUids.has(p.uid)) continue; // inside a bigger empty folder: only the topmost is proposed
      propose(f);
    }
  }

  // Name collisions: with something already in /trash, or between two items of this batch. `restore` finds items by name only.
  const batchNames = new Map<string, number>();
  for (const it of eligible) batchNames.set(it.name, (batchNames.get(it.name) ?? 0) + 1);
  const seenUids = new Set<string>();
  const items: CleanupItem[] = [];
  for (const it of eligible) {
    if (keeperUids.has(it.uid) || seenUids.has(it.uid) || !inside(it.path)) continue; // never a keeper, a repeat or anything outside the path
    seenUids.add(it.uid);
    if ((input.trashNames.get(it.name) ?? 0) > 0 || (batchNames.get(it.name) ?? 0) > 1) { skip(TRASH_NAME_REASON, 1); continue; }
    items.push(it);
  }
  items.sort((a, b) => cmp(a.path, b.path) || cmp(a.uid, b.uid));

  const page = items.slice(0, cap);
  return {
    ok: true,
    items: page,
    counts: { duplicates: page.filter((i) => i.kind === "duplicate").length, emptyFolders: page.filter((i) => i.kind === "empty-folder").length },
    bytes: page.reduce((s, i) => s + i.size, 0),
    skipped: [...skipped].map(([reason, count]) => ({ count, reason })).sort((a, b) => cmp(a.reason, b.reason)),
    remaining: items.length - page.length,
  };
}

/** Stable hash of the item list: the server plans again after approval and compares. Any change to any item changes it. */
export function planFingerprint(plan: CleanupPlanOk): string {
  return createHash("sha256").update(canonical(plan.items)).digest("hex");
}

/** Approval-dialog lines, one per item, raw strings (the gate escapes them). Never truncated: what is shown is what is trashed. */
export function summarizeForDialog(plan: CleanupPlanOk): string[] {
  return plan.items.map((i) => (i.kind === "duplicate" ? `${i.path}  (keeps ${i.keeps})` : `${i.path}  (empty folder)`));
}

/** Plan-output samples ("trash X (keeps Y)"), at most `n` (plan 3.2 / 3.8: 10). */
export function planSamples(plan: CleanupPlanOk, n = 10): string[] {
  return plan.items.slice(0, n).map((i) => (i.kind === "duplicate" ? `trash ${i.path} (keeps ${i.keeps})` : `trash ${i.path} (empty folder)`));
}
