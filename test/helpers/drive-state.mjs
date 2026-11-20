// Helpers for suites that run the built server on the stateful fake Drive (FAKE_MODE=drive, see fake-cli.mjs).
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createUndoJournal } from "../../dist/utils/undoJournal.js";

export const file = (uid, parentUid, name, extra = {}) => ({ uid, parentUid, name, type: "file", size: 100, ...extra });
export const folder = (uid, parentUid, name, extra = {}) => ({ uid, parentUid, name, type: "folder", ...extra });

const stateFile = (dir) => join(dir, "state.json");

/** `setup` for withServer: writes the state file (root folder uid "root" = /my-files plus `nodes`) and turns the undo journal on. */
export const driveSetup = (nodes, extraEnv = {}) => (sb) => {
  const all = { root: folder("root", null, "my-files") };
  for (const n of nodes) all[n.uid] = n;
  writeFileSync(stateFile(sb.dir), JSON.stringify({ nodes: all }));
  return { FAKE_STATE: stateFile(sb.dir), PROTON_DRIVE_UNDO: "1", ...extraEnv };
};

export const readNodes = (ctx) => JSON.parse(readFileSync(stateFile(ctx.dir), "utf8")).nodes;
export const patchState = (ctx, fn) => {
  const s = JSON.parse(readFileSync(stateFile(ctx.dir), "utf8"));
  fn(s.nodes);
  writeFileSync(stateFile(ctx.dir), JSON.stringify(s));
};
/** Alive (not trashed) node uid -> "parentUid/name", for comparing a tree before and after. */
export const treeShape = (ctx) => Object.fromEntries(Object.values(readNodes(ctx)).filter((n) => n.trashTime === undefined).map((n) => [n.uid, `${n.parentUid}/${n.name}`]));
export const trashedUids = (ctx) => Object.values(readNodes(ctx)).filter((n) => n.trashTime !== undefined).map((n) => n.uid).sort();

export const undoDir = (ctx) => join(ctx.dir, "undo");
export const journalIds = (ctx) => (existsSync(undoDir(ctx)) ? readdirSync(undoDir(ctx)).filter((n) => /^[A-Z2-9]{4}-[A-Z2-9]{4}\.json$/.test(n)).map((n) => n.slice(0, -5)) : []);
export const readJournal = (ctx, id) => JSON.parse(readFileSync(join(undoDir(ctx), `${id}.json`), "utf8"));

/** Writes a finished batch straight into the sandbox journal (account "root" = what the fake Drive reports) and returns its id. */
export function seedJournal(sb, { tool = "drive_cleanup", kind = "trash", items, status = "applied" }) {
  const journal = createUndoJournal({ dir: join(sb.dir, "undo"), account: "root" });
  const { id } = journal.begin({ tool, kind, items });
  journal.complete(id, { status });
  return id;
}
