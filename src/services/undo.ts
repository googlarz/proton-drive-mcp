import { createHash } from "node:crypto";
import type { DriveFile } from "../types/index.js";
import { ROOT_PATHS, splitRemotePath, unescapeName, type BatchItemResult, type DriveService } from "./drive.js";
import { canonical } from "../utils/audit.js";
import type { UndoBatch, UndoItem, UndoJournal } from "../utils/undoJournal.js";

/**
 * drive_undo engine (1.12.0, PLAN-1.12.0 sections 3.4, 3.5, 3.9). Pure orchestration over DriveService and the undo journal;
 * the server (W1) owns the approval dialog, the roots predicate and the tool schema.
 *
 * Safety rules, all enforced here and tested:
 * - An item is only ever acted on when it is found BY UID where the journal says it is (in /trash, or at the path the batch moved it to).
 * - `filesystem restore` addresses a trashed item by name only (PLAN 3.5), so an item is restored only when its name is unique in /trash.
 * - Nothing is overwritten: the original folder must exist and must not already hold an item of that name.
 * - Success is never taken from the CLI's word: every item is re-checked by uid in its original folder afterwards.
 * - Every journal path is checked with the injected `isPathAllowed` (the server passes its PROTON_DRIVE_REMOTE_ROOTS check).
 */

export type UndoDrive = Pick<DriveService, "list" | "listTrash" | "restoreMany" | "moveMany" | "move" | "rename">;

export type UndoErrorCode = "invalid_id" | "not_found" | "no_batch" | "already_undone" | "approval_changed" | "nothing_restorable";

/** Thrown for every refusal the server should show as a plain message; `approval_changed` is the fingerprint mismatch. */
export class UndoError extends Error {
  constructor(readonly code: UndoErrorCode, message: string) {
    super(message);
    this.name = "UndoError";
  }
}

export interface UndoOptions {
  /** Server roots check (PROTON_DRIVE_REMOTE_ROOTS). Default: allow everything (unit tests). */
  isPathAllowed?: (path: string) => boolean;
}

export interface UndoListResult {
  action: "list";
  /** Newest 20, no file names. `items` is the number of items in the batch. */
  batches: Array<{ id: string; when: string; tool: string; kind: string; items: number; status: string }>;
}

export interface UndoPlanItem {
  /** Path before the original change (where the item goes back to). */
  path: string;
  restorable: boolean;
  /** Set when not restorable. */
  reason?: string;
  /** Not restorable because it is already at its original location (nothing to do; not a failure). */
  alreadyInPlace?: boolean;
}

export interface UndoPlanResult {
  action: "plan";
  id: string;
  when: string;
  tool: string;
  kind: string;
  status: string;
  items: UndoPlanItem[];
  restorableCount: number;
  /** Paths that would be restored from trash (approval dialog). */
  restore: string[];
  /** "<now> -> <before>" for each item that would be moved or renamed back (approval dialog). */
  moveBack: string[];
  /** Stable hash of exactly what apply would do; pass it back as `expectedFingerprint`. */
  fingerprint: string;
}

export interface UndoApplyResult {
  id: string;
  undone: number;
  /** Items that were already back at their original location (nothing to do). */
  alreadyInPlace: number;
  failed: Array<{ path: string; reason: string }>;
  status: "undone" | "partial";
  /** false when the journal could not be updated (for example another process marked the batch undone meanwhile). */
  journalUpdated: boolean;
}

type Op = "restore" | "move" | "moveRename" | "rename";

interface Planned {
  uid: string;
  from: string;
  to?: string;
  op?: Op;
  /** /trash/<name> for restore. */
  trashPath?: string;
  restorable: boolean;
  reason?: string;
  inPlace?: boolean;
}

interface Computed {
  batch: UndoBatch;
  items: Planned[];
  fingerprint: string;
}

const LIST_LIMIT = 20;
const RESTORE_CHUNK = 200;

function isNotFound(e: unknown): boolean {
  return e instanceof Error && /not found|does not exist|no such/i.test(e.message);
}

function badPath(p: string): boolean {
  return typeof p !== "string" || !p.startsWith("/") || p.length < 2 || ROOT_PATHS.has(p) || /^\/(trash|photos-trash)(\/|$)/.test(p);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const nameOf = (path: string) => unescapeName(splitRemotePath(path).name);

function getBatch(journal: UndoJournal, id?: string): UndoBatch {
  if (id === undefined) {
    const newest = journal.list().find((b) => b.status !== "undone");
    if (!newest) throw new UndoError("no_batch", "There is nothing to undo: no recorded batch that has not already been undone.");
    id = newest.id;
  }
  let batch: UndoBatch | null;
  try {
    batch = journal.get(id);
  } catch (e) {
    throw new UndoError("invalid_id", e instanceof Error ? e.message : "invalid undo code");
  }
  if (!batch) throw new UndoError("not_found", `No undo record with code ${id} (unknown, expired, or from another Proton account).`);
  if (batch.status === "undone") throw new UndoError("already_undone", `Batch ${batch.id} was already undone; a second undo is refused.`);
  return batch;
}

async function compute(drive: UndoDrive, journal: UndoJournal, id: string | undefined, isPathAllowed: (p: string) => boolean): Promise<Computed> {
  const batch = getBatch(journal, id);
  const pending = batch.status === "pending";
  const cache = new Map<string, Promise<DriveFile[] | null>>();
  /** Folder listing with uids, null when the folder does not exist; cached per folder for one planning pass. */
  const listing = (folder: string): Promise<DriveFile[] | null> => {
    let p = cache.get(folder);
    if (!p) {
      p = drive.list(folder, { includeUid: true }).catch((e) => {
        if (isNotFound(e)) return null;
        throw e;
      });
      cache.set(folder, p);
    }
    return p;
  };
  const trash = batch.kind === "trash" ? await drive.listTrash() : [];
  const seen = new Set<string>();
  /** `<parent>\0<name>` slots already promised to an earlier item of this batch. */
  const claimed = new Set<string>();
  const items: Planned[] = [];

  for (const it of batch.items) {
    items.push(await planItem(it));
  }

  async function planItem(it: UndoItem): Promise<Planned> {
    const base: Planned = { uid: it.uid, from: it.from, to: batch.kind === "trash" ? undefined : it.to, restorable: false };
    const refuse = (reason: string): Planned => ({ ...base, restorable: false, reason });
    if (seen.has(it.uid)) return refuse("duplicate entry for the same item in the journal");
    seen.add(it.uid);
    if (badPath(it.from) || (base.to !== undefined && badPath(base.to))) return refuse("the journal holds an invalid path for this item");
    if (!isPathAllowed(it.from) || (base.to !== undefined && !isPathAllowed(base.to))) {
      return refuse("outside the allowed Drive roots (PROTON_DRIVE_REMOTE_ROOTS)");
    }
    if (!it.restorable) return refuse(it.reason ?? "recorded as not restorable when it was changed");

    const { parent: fromParent, name: fromEsc } = splitRemotePath(it.from);
    const fromName = unescapeName(fromEsc);
    const slot = `${fromParent}\0${fromName}`;

    if (batch.kind === "trash") {
      const t = trash.find((x) => x.uid === it.uid);
      if (!t) {
        const here = (await listing(fromParent))?.find((e) => e.uid === it.uid && e.path === it.from);
        if (here) {
          return { ...base, inPlace: true, reason: pending ? "the batch never completed: the item is still at its original location" : "already back at its original location" };
        }
        return refuse("not in trash any more (restored elsewhere, deleted, or the trash was emptied)");
      }
      if (t.name !== fromName) return refuse("the name in trash does not match the journal");
      if (trash.filter((x) => x.name === t.name).length > 1) {
        return refuse("another item with the same name is in trash; the CLI can only restore by name, so this one is left alone");
      }
      const siblings = await listing(fromParent);
      if (!siblings) return refuse(`the original folder ${fromParent} no longer exists`);
      if (siblings.some((e) => e.name === fromName) || claimed.has(slot)) return refuse(`an item named "${fromName}" already exists in ${fromParent}`);
      claimed.add(slot);
      return { ...base, op: "restore", trashPath: t.path, restorable: true };
    }

    // move / rename: the item must still be where the batch put it.
    const to = base.to;
    if (to === undefined) return refuse("the journal has no destination path for this item");
    const toParent = splitRemotePath(to).parent;
    const atTo = (await listing(toParent))?.find((e) => e.uid === it.uid && e.path === to);
    if (!atTo) {
      const here = (await listing(fromParent))?.find((e) => e.uid === it.uid && e.path === it.from);
      if (here) {
        return { ...base, inPlace: true, reason: pending ? "the batch never completed: the item is still at its original location" : "already back at its original location" };
      }
      return refuse(`no longer at ${to} (moved, renamed or deleted since)`);
    }
    const siblings = await listing(fromParent);
    if (!siblings) return refuse(`the original folder ${fromParent} no longer exists`);
    if (siblings.some((e) => e.name === fromName) || claimed.has(slot)) return refuse(`an item named "${fromName}" already exists in ${fromParent}`);
    claimed.add(slot);
    const op: Op = toParent === fromParent ? "rename" : nameOf(to) === fromName ? "move" : "moveRename";
    return { ...base, op, restorable: true };
  }

  const fingerprint = sha(canonical({
    v: 1,
    id: batch.id,
    kind: batch.kind,
    do: items.filter((i) => i.restorable).map((i) => ({ uid: i.uid, op: i.op, from: i.from, to: i.to, trash: i.trashPath })),
    skip: items.filter((i) => !i.restorable).map((i) => i.uid),
  }));
  return { batch, items, fingerprint };
}

/** `list`: newest 20 batches (no names). `plan`: what apply would do, per item, with a fingerprint. Read-only. */
export function planUndo(drive: UndoDrive, journal: UndoJournal, o: { action: "list" } & UndoOptions): Promise<UndoListResult>;
export function planUndo(drive: UndoDrive, journal: UndoJournal, o: { action: "plan"; id?: string } & UndoOptions): Promise<UndoPlanResult>;
export function planUndo(drive: UndoDrive, journal: UndoJournal, o: { id?: string; action: "list" | "plan" } & UndoOptions): Promise<UndoListResult | UndoPlanResult>;
export async function planUndo(drive: UndoDrive, journal: UndoJournal, o: { id?: string; action: "list" | "plan" } & UndoOptions): Promise<UndoListResult | UndoPlanResult> {
  if (o.action === "list") {
    return {
      action: "list",
      batches: journal.list().slice(0, LIST_LIMIT).map((b) => ({
        id: b.id, when: new Date(b.createdAt).toISOString(), tool: b.tool, kind: b.kind, items: b.itemCount, status: b.status,
      })),
    };
  }
  const c = await compute(drive, journal, o.id, o.isPathAllowed ?? (() => true));
  const doing = c.items.filter((i) => i.restorable);
  return {
    action: "plan",
    id: c.batch.id,
    when: new Date(c.batch.createdAt).toISOString(),
    tool: c.batch.tool,
    kind: c.batch.kind,
    status: c.batch.status,
    items: c.items.map((i) => ({
      path: i.from,
      restorable: i.restorable,
      ...(i.reason ? { reason: i.reason } : {}),
      ...(i.inPlace ? { alreadyInPlace: true } : {}),
    })),
    restorableCount: doing.length,
    restore: doing.filter((i) => i.op === "restore").map((i) => i.from),
    moveBack: doing.filter((i) => i.op !== "restore").map((i) => `${i.to} -> ${i.from}`),
    fingerprint: c.fingerprint,
  };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Records per-item CLI errors by uid (falling back to position when the CLI echoes no uid). */
function recordErrors(into: Map<string, string>, uids: string[], results: BatchItemResult[]): void {
  results.forEach((r, i) => {
    if (r.ok) return;
    const uid = r.uid && uids.includes(r.uid) ? r.uid : uids[i];
    if (uid) into.set(uid, r.error ?? "the CLI reported a failure");
  });
}

/**
 * Re-plans, refuses with UndoError("approval_changed") when `expectedFingerprint` no longer matches what would be done now,
 * executes, then verifies every item by uid in its original folder. Marks the batch undone (all items back) or partial.
 */
export async function applyUndo(
  drive: UndoDrive,
  journal: UndoJournal,
  o: { id: string; expectedFingerprint: string } & UndoOptions,
): Promise<UndoApplyResult> {
  const c = await compute(drive, journal, o.id, o.isPathAllowed ?? (() => true));
  if (c.fingerprint !== o.expectedFingerprint) {
    throw new UndoError("approval_changed", `Drive changed since the undo plan for ${c.batch.id} was approved; nothing was applied. Run the plan again.`);
  }
  const todo = c.items.filter((i) => i.restorable);
  const inPlace = c.items.filter((i) => i.inPlace);
  if (todo.length === 0 && inPlace.length === 0) {
    const why = [...new Set(c.items.map((i) => i.reason).filter(Boolean))].slice(0, 3).join("; ");
    throw new UndoError("nothing_restorable", `Nothing in batch ${c.batch.id} can be undone${why ? ` (${why})` : ""}.`);
  }

  const cliErr = new Map<string, string>();
  const run = async <T>(uids: string[], fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      for (const u of uids) cliErr.set(u, errText(e));
      return undefined;
    }
  };

  const restores = todo.filter((i) => i.op === "restore");
  for (let i = 0; i < restores.length; i += RESTORE_CHUNK) {
    const chunk = restores.slice(i, i + RESTORE_CHUNK);
    const uids = chunk.map((x) => x.uid);
    const res = await run(uids, () => drive.restoreMany(chunk.map((x) => x.trashPath as string)));
    if (res) recordErrors(cliErr, uids, res);
  }

  const sameName = new Map<string, Planned[]>();
  for (const it of todo.filter((x) => x.op === "move")) {
    const parent = splitRemotePath(it.from).parent;
    sameName.set(parent, [...(sameName.get(parent) ?? []), it]);
  }
  for (const [parent, group] of sameName) {
    for (let i = 0; i < group.length; i += RESTORE_CHUNK) {
      const chunk = group.slice(i, i + RESTORE_CHUNK);
      const uids = chunk.map((x) => x.uid);
      const res = await run(uids, () => drive.moveMany(chunk.map((x) => x.to as string), parent));
      if (res) recordErrors(cliErr, uids, res);
    }
  }
  for (const it of todo.filter((x) => x.op === "moveRename")) {
    await run([it.uid], () => drive.move(it.to as string, it.from));
  }
  for (const it of todo.filter((x) => x.op === "rename")) {
    await run([it.uid], () => drive.rename(it.to as string, nameOf(it.from)));
  }

  // Verify by uid in the original folder; the CLI's own report is not trusted.
  const parents = [...new Set(todo.map((i) => splitRemotePath(i.from).parent))];
  const fresh = new Map<string, DriveFile[] | null>();
  for (const p of parents) {
    try {
      fresh.set(p, await drive.list(p, { includeUid: true }));
    } catch (e) {
      if (!isNotFound(e)) throw e;
      fresh.set(p, null);
    }
  }
  let undone = 0;
  const failed: Array<{ path: string; reason: string }> = [];
  for (const it of todo) {
    const back = fresh.get(splitRemotePath(it.from).parent)?.some((e) => e.uid === it.uid && e.path === it.from);
    if (back) {
      undone++;
    } else {
      failed.push({ path: it.from, reason: cliErr.get(it.uid) ? `${cliErr.get(it.uid)} (not verified back at its original location)` : "not verified back at its original location after the call" });
    }
  }
  for (const it of c.items) if (!it.restorable && !it.inPlace) failed.push({ path: it.from, reason: it.reason ?? "not restorable" });

  const status = failed.length === 0 ? "undone" : "partial";
  let journalUpdated = false;
  try {
    journalUpdated = journal.markUndone(c.batch.id, status);
  } catch { /* the work is done; the journal write is best effort */ }
  return { id: c.batch.id, undone, alreadyInPlace: inPlace.length, failed, status, journalUpdated };
}
