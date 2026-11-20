import type { DriveService } from "./drive.js";
import { splitRemotePath, unescapeName } from "./drive.js";
import { currentAccountKey, cachedNode } from "./walk.js";
import { pool } from "./analytics.js";
import { createUndoJournal, resolveUndoDir, undoEnabled, type UndoItem, type UndoJournal, type UndoKind } from "../utils/undoJournal.js";
import { assertUndoDirUsable } from "../utils/localguard.js";
import { logger } from "../utils/logger.js";

/**
 * Server-side glue between the five mutating tools and the undo journal (1.12.0, PLAN-1.12.0 sections 2, 3.5, 3.6).
 * Used by src/index.ts; the companion CLI can call openUndoJournal() to get the same journal the server writes.
 *
 * Rules: journalling never turns a successful change into an error (every failure is a warning on stderr plus a note in the
 * result), a batch is written as `pending` BEFORE the CLI call and completed after it, and items are recorded sorted by path.
 */

export type JournalOpen =
  | { journal: UndoJournal; off?: false }
  /** `off`: the owner switched journalling off (PROTON_DRIVE_UNDO=0); hooks on existing tools stay silent then. */
  | { journal: null; reason: string; off: boolean };

/**
 * The journal for the signed-in account, or the reason there is none: switched off, the folder is unusable (inside the sync
 * folder), the account cannot be identified (see currentAccountKey) or the journal cannot be created.
 */
export async function openUndoJournal(drive: DriveService, env: Record<string, string | undefined> = process.env): Promise<JournalOpen> {
  if (!undoEnabled(env)) return { journal: null, off: true, reason: "undo is switched off (PROTON_DRIVE_UNDO=0)" };
  const dir = resolveUndoDir(env);
  try {
    assertUndoDirUsable(dir, env);
  } catch (e) {
    return { journal: null, off: false, reason: e instanceof Error ? e.message : String(e) };
  }
  let account: string | undefined;
  try {
    account = await currentAccountKey(drive);
  } catch (e) {
    return { journal: null, off: false, reason: `the Proton account could not be identified (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!account) return { journal: null, off: false, reason: "the Proton account could not be identified" };
  try {
    return { journal: createUndoJournal({ dir, account, enabled: true }) };
  } catch (e) {
    return { journal: null, off: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export const IN_TRASH_REASON = "a same-named item is already in the trash or twice in this batch (the CLI restores by name only)";

export interface Found { uid: string; parentUid?: string; name: string; size?: number }

/**
 * uid, parent uid, name and size of each path. A walk still in the memory cache answers first (no CLI call); otherwise the item is read
 * from its parent folder's listing (one listing per folder). Paths not found are left out.
 */
async function lookup(drive: DriveService, paths: string[]): Promise<Map<string, Found>> {
  const out = new Map<string, Found>();
  const byParent = new Map<string, string[]>();
  for (const p of paths) {
    const hit = cachedNode(p);
    if (hit) { out.set(p, { uid: hit.uid, parentUid: hit.parentUid, name: unescapeName(splitRemotePath(p).name), size: hit.size }); continue; }
    const { parent } = splitRemotePath(p);
    byParent.set(parent, [...(byParent.get(parent) ?? []), p]);
  }
  await pool([...byParent], 4, async ([parent, wanted]) => {
    let entries;
    try { entries = await drive.listEntries(parent, { includeUid: true }); } catch { return; }
    for (const e of entries) {
      if (!wanted.includes(e.file.path) || typeof e.item.uid !== "string") continue;
      out.set(e.file.path, { uid: e.item.uid, parentUid: typeof e.item.parentUid === "string" ? e.item.parentUid : undefined, name: e.file.name, size: e.file.size });
    }
  });
  return out;
}

export interface BatchSpec {
  tool: string;
  kind: UndoKind;
  paths: string[];
  /** move / rename: the path each item ends up at. Items whose destination equals their path are not recorded. */
  to?: (from: string) => string;
  /**
   * trash batches: list /trash once and mark items whose name is already there as not restorable (drive_bulk_trash, drive_cleanup). Without it
   * (single-item tools) every item is recorded restorable and the undo plan checks the name against the live /trash before it restores.
   */
  checkTrash?: boolean;
  /** Items the caller already read with their uid (drive_cleanup's plan): these are not looked up again. */
  known?: Map<string, Found>;
  /** Say in the result that journalling is switched off (drive_cleanup, whose answer promises an undo code); the older tools stay silent about it. */
  reportOff?: boolean;
}

export interface Batch {
  /** Fields to merge into the tool result: undoId, notUndoable and the notes. Empty when journalling is off. */
  report(): Record<string, unknown>;
  /** Marks the change as done. `succeededUids` keeps only those items (status `partial` when some are dropped). Never throws. */
  complete(succeededUids?: string[]): void;
  /**
   * After a failed CLI call: keeps only the items that really changed (checked by uid: in the trash, or at the destination) and returns
   * their uids; a batch left with none is removed. undefined when that could not be checked (the batch then stays pending and undo reconciles it by uid).
   */
  settleAfterError(): Promise<string[] | undefined>;
  /** Uids of the items that were recorded. */
  readonly uids: string[];
}

const NONE: Batch = { report: () => ({}), complete: () => {}, settleAfterError: async () => undefined, uids: [] };

/**
 * Looks the items up (and, for trash batches, lists /trash once) and writes the `pending` batch. Call it AFTER the approval gate and
 * BEFORE the CLI call. Never throws: a failure leaves the tool to run without undo and says so in `report()`.
 */
export async function beginBatch(drive: DriveService, jo: JournalOpen, spec: BatchSpec): Promise<Batch> {
  if (!jo.journal) {
    if (jo.off) return spec.reportOff ? { ...NONE, report: () => ({ undo: jo.reason }) } : NONE;
    return { ...NONE, report: () => ({ undo: `undo unavailable: ${jo.reason}` }) };
  }
  const journal = jo.journal;
  const failed = (why: string): Batch => {
    logger.warn(`undo journal: ${spec.tool} ran without a recorded undo (${why}).`);
    return { ...NONE, report: () => ({ undo: `undo not recorded: ${why}` }) };
  };
  try {
    const sorted = [...new Set(spec.paths)].filter((p) => !spec.to || spec.to(p) !== p).sort();
    if (sorted.length === 0) return NONE;
    const known = spec.known ?? new Map<string, Found>();
    const found = await lookup(drive, sorted.filter((p) => !known.has(p)));
    for (const p of sorted) { const k = known.get(p); if (k) found.set(p, k); }
    const trashNames = new Map<string, number>();
    if (spec.kind === "trash" && spec.checkTrash) for (const t of await drive.listTrash()) trashNames.set(t.name, (trashNames.get(t.name) ?? 0) + 1);
    const batchNames = new Map<string, number>();
    for (const f of found.values()) batchNames.set(f.name, (batchNames.get(f.name) ?? 0) + 1);

    const items: UndoItem[] = [];
    for (const from of sorted) {
      const f = found.get(from);
      if (!f) continue;
      const unrestorable = spec.kind === "trash" && ((trashNames.get(f.name) ?? 0) > 0 || (batchNames.get(f.name) ?? 0) > 1);
      items.push({
        uid: f.uid, from, name: f.name,
        ...(f.parentUid ? { parentUid: f.parentUid } : {}),
        ...(spec.to ? { to: spec.to(from) } : {}),
        ...(f.size !== undefined ? { size: f.size } : {}),
        restorable: !unrestorable,
        ...(unrestorable ? { reason: IN_TRASH_REASON } : {}),
      });
    }
    if (items.length === 0) return failed("the items could not be looked up before the change");
    const begun = journal.begin({ tool: spec.tool, kind: spec.kind, items });
    if (!begun) return NONE;
    const id = begun.id;
    const unrecorded = sorted.length - items.length;
    const notUndoable = items.filter((i) => !i.restorable).length;
    const notes: string[] = [];
    if (notUndoable > 0) notes.push(`${notUndoable} of ${items.length} item(s) cannot be undone reliably: ${IN_TRASH_REASON}`);
    if (unrecorded > 0) notes.push(`${unrecorded} item(s) could not be looked up and are not in the undo record`);
    return {
      uids: items.map((i) => i.uid),
      report: () => ({ undoId: id, ...(notUndoable > 0 ? { notUndoable } : {}), ...(notes.length ? { undo: notes.join("; ") } : {}) }),
      complete: (succeededUids) => {
        try { journal.complete(id, { status: "applied", ...(succeededUids ? { succeededUids } : {}) }); }
        catch (e) { logger.warn(`undo journal: could not finish batch ${id} (${e instanceof Error ? e.message : String(e)}); it stays pending and undo reconciles it by uid.`); }
      },
      settleAfterError: async () => {
        try {
          let kept: string[];
          if (spec.kind === "trash") {
            const now = new Set((await drive.listTrash()).map((t) => t.uid));
            kept = items.map((i) => i.uid).filter((u) => now.has(u));
          } else {
            const at = await lookup(drive, items.map((i) => i.to as string));
            kept = items.filter((i) => at.get(i.to as string)?.uid === i.uid).map((i) => i.uid);
          }
          journal.complete(id, { status: "partial", succeededUids: kept });
          return kept;
        } catch (e) {
          logger.warn(`undo journal: could not settle batch ${id} after a failed call (${e instanceof Error ? e.message : String(e)}); it stays pending and undo reconciles it by uid.`);
          return undefined;
        }
      },
    };
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
}

