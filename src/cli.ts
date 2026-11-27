#!/usr/bin/env node

/**
 * Companion CLI for proton-drive-mcp.
 * Provides a human-friendly interface to the same DriveService used by the MCP server.
 *
 * Usage: proton-drive-cli <command> [args]
 * Run with --help (or see usage() below) for the full command list.
 */

import {
  DriveService,
  type FileConflictStrategy,
  type FolderConflictStrategy,
  type FileDownloadConflictStrategy,
  type FolderDownloadConflictStrategy,
  type PhotoUploadConflictStrategy,
  type PhotoDownloadConflictStrategy,
} from "./services/drive.js";
import { DriveCliError, DriveCliNotFoundError, DriveNotAuthenticatedError, DriveParseError } from "./utils/errors.js";
import { checkCliAvailable, cliLaunchError } from "./utils/subprocess.js";
import { runDoctor, formatDoctor } from "./utils/doctor.js";
import { runInit } from "./utils/init.js";
import { buildEntry, defaultConfigPath, isDirectory, resolveDriveCli, writeEntry, SERVER_KEY } from "./utils/claudeConfig.js";
import { syncPlan, planBulkMove, planBulkTrash, loadListing, foldersToList, type Direction, type Compare } from "./services/plan.js";
import { invalidatePath } from "./services/walk.js";
import { indexStatus, deleteIndex } from "./services/walkIndex.js";
import { deleteChangeSnapshots } from "./services/changes.js";
import { clearContentIndex } from "./services/contentIndex.js";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createApprovalStore, resolveApprovalDir, type ApprovalStore } from "./utils/approvalStore.js";
import { driveSearch, driveTree } from "./services/find.js";
import { readDriveContent } from "./services/content.js";
import { driveUsage, driveFindDuplicates, driveSharingAudit } from "./services/analytics.js";
import { runCheckup } from "./services/cleanupRun.js";
import { CHECKUP_FINDINGS, type CheckupFinding, type CheckupFindingSummary, type CheckupPage, type CheckupSummary } from "./services/checkup.js";
import { openUndoJournal, type JournalOpen } from "./services/undoRecord.js";
import { planUndo, applyUndo, UndoError, type UndoDrive, type UndoPlanResult } from "./services/undo.js";
import { parseRemoteRoots, pathInRoots } from "./utils/remoteroots.js";
import { validateRemotePath, validateRemotePathList, validateLocalPath, validateDownloadTarget, validateEmail, validateMessage, validateName, validateFlagValue } from "./utils/validation.js";

const drive = new DriveService();
const args = process.argv.slice(2);
const jsonMode = args.includes("--json");

function usage() {
  console.log(`
proton-drive-cli — Proton Drive companion CLI

Commands:
  auth status                              Check authentication status (probes /my-files)
  auth logout                              Log out
  version                                  Show CLI/SDK version
  list <path>                              List files at path
  info <path> [--verbose]                  Show node metadata (--verbose = raw CLI node)
  read <path> [--max-chars N] [--offset N] Text of a Drive file (text/code, .docx, text .pdf; max 10 MB), paged
  tree [path] [--depth N] [--limit N] [--folders-only] [--refresh]
                                           Folder overview with per-folder counts and sizes (default /my-files, depth 2)
  search [path] [--query S] [--glob G] [--type file|folder] [--media-type P] [--ext pdf,docx]
         [--min-size B] [--max-size B] [--after DATE] [--before DATE] [--sort name|size|mtime]
         [--limit N] [--offset N] [--refresh]
                                           Find files/folders under path (default /my-files) in one walk
  mkdir <path>                             Create a new folder
  upload <local> <remote> [--file-conflict X] [--folder-conflict X] [--skip-thumbnails] [--confirm]
                                           Upload file/folder (files: skip/create-new-revision/rename/replace; folders: skip/merge/rename/replace;
                                           'replace' trashes the existing remote item and needs --confirm)
  download <remote> <local> [--file-conflict X] [--folder-conflict X] [--confirm]
                                           Download file/folder (files: skip/rename/remove; folders: skip/merge/rename/remove;
                                           'remove' deletes the existing LOCAL item and needs --confirm)
  rename <path> <new-name>                 Rename in place, no move
  move <src> <dst>                         Move and/or rename
  delete <path>|--uid <uid> --confirm      Delete a file/folder already in trash, permanently
  share status <path>                      Show sharing info
  share audit [path] [--refresh]           Audit public links, invitees and risk flags under a path (default /my-files)
  share invite <path> <email> <role>       Invite user (viewer/editor/admin)
  share revoke <path> <email>              Revoke one user's access
  share remove-all <path> --confirm        Remove everyone's access + pending invitations
  share set-url <path> [--role] [--password] [--expiration]  Create/update public link
  share remove-url <path>                  Remove public link
  share leave <path>                       Leave a folder shared with you
  copy <src> <dst-parent-folder> [--name N]  Copy file/folder into a folder (optionally under a new name)
  trash <path>                             Move to trash
  sync-plan <local> <remote> [--direction up|down|both] [--compare size-mtime|sha1] [--ignore g1,g2] [--limit N]
                                           Read-only diff of a local folder vs a Drive folder (nothing transferred)
  bulk-move <dst-folder> <src>... [--confirm]  Move many items into an existing folder; without --confirm prints the plan only
  bulk-trash <path>... [--confirm]         Trash many items; without --confirm prints the plan only
  trash list                               List trash contents
  usage [path] [--top N] [--older-than DAYS] [--refresh]
                                           Storage analytics: totals, largest files/folders, breakdowns, trash (sum of file sizes, not the quota)
  duplicates [path] [--min-size B] [--verify] [--max-verify-bytes B] [--max-verify-total-bytes B] [--limit N] [--refresh]
                                           Likely duplicate files; --verify downloads and hashes candidates. Never deletes.
  checkup [path] [--finding <id>] [--no-sharing] [--refresh] [--limit N] [--offset N]
                                           Drive health check: score, findings (duplicates, empty-folders, large-old, public-links,
                                           outside-access, sensitive-exposed, trash). --finding lists that finding's items, paged. Read-only.
  undo [--list] [<id>] [--confirm]         Undo a recorded change (trash, move, rename). --list shows recent batches; without --confirm
                                           prints the plan only; --confirm applies exactly that plan (default id: newest not yet undone)
  trash empty --confirm                    Permanently delete all trash
  restore <path>|--uid <uid>               Restore from trash (uid from 'trash list')
  invitation list                          List pending invitations
  invitation accept <uid>                  Accept an invitation
  invitation reject <uid>                  Reject an invitation
  album list                               List all photo albums
  album create <name>                      Create a new album
  album update <path> [--name] [--cover-photo-uid]  Rename/update album cover
  album delete <path> --confirm [--force] [--save]  Delete an album
  album photos <path> [--load-details]     List photos in an album
  album add-photo <album> <photo>          Add a photo to an album
  album remove-photo <album> <photo>       Remove a photo from an album
  photo timeline [--load-details]          List photos in your timeline
  photo download <photo>... <local> [--conflict X] [--confirm]  Download photos (skip/rename/remove; 'remove' needs --confirm)
  photo upload <local>... [--conflict X]   Upload photos to your library (skip/rename)

  index status                             Persistent walk index (PROTON_DRIVE_INDEX=1): enabled?, path, size, age, entries
  index clear                              Delete the saved index file (plaintext names/paths of your drive), the change snapshots and the encrypted content index

  approvals                                List pending/approved out-of-band approvals (code, tool, status, expires in, first summary line)
  approve <code>                           Show the server's stored summary of a refused operation and approve it after you type 'yes'
                                           (needs an interactive terminal)
  deny <code>                              Discard a pending or approved approval

  doctor [--config <path>]                 Read-only diagnostics: Node, proton-drive CLI, auth, sync path, Claude Desktop config
                                           (exit 1 if any check fails)
  init [--config <path>] [--write]         First-run helper (also: npx -y proton-drive-mcp init): runs the doctor checks, prints the Claude
                                           Desktop and Claude Code config; --write adds the npx entry to the Desktop config (timestamped
                                           backup first, dry run by default, other servers untouched)
  setup-claude-desktop [--config <path>] [--sync-path <dir>] [--write]
                                           Print the Claude Desktop entry for this server (dry run); --write adds it to the
                                           config (timestamped backup first). Restart Claude Desktop afterwards.

Flags:
  --json                                   Machine-readable JSON output (one line)
`);
}

function requirePath(value: string | undefined, usage: string): string {
  if (!value) { console.error(`Usage: ${usage}`); process.exit(1); }
  try { return validateRemotePath(value); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
  return "" as never; // unreachable; process.exit(1) above always terminates
}

function pathOrRoot(value: string | undefined): string {
  return value && !value.startsWith("--") ? requirePath(value, "<command> [path]") : "/my-files";
}

function intFlag(flag: string): number | undefined {
  const v = getFlag(flag);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) { console.error(`${flag} must be a non-negative integer`); process.exit(1); }
  return Number(v);
}

function requireEmail(value: string): string {
  try { return validateEmail(value); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
  return "" as never; // unreachable; process.exit(1) above always terminates
}

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  if (idx + 1 >= args.length || args[idx + 1].startsWith("--")) {
    console.error(`${flag} requires a value`);
    process.exit(1);
  }
  return args[idx + 1];
}

function numFlag(flag: string): number | undefined {
  const v = getFlag(flag);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) { console.error(`${flag} must be a non-negative integer`); process.exit(1); }
  return Number(v);
}

function numFlags(...names: string[]): Record<string, number | undefined> {
  return Object.fromEntries(names.map((n) => [n, numFlag(`--${n}`)]));
}

function print(data: unknown) {
  console.log(jsonMode ? JSON.stringify(data) : JSON.stringify(data, null, 2));
}

export interface ApproveIO {
  stdin: NodeJS.ReadableStream;
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  isTTY: boolean;
}

/** Interactive approval: returns the process exit code. Approves only after a typed `yes` on a real terminal. */
export async function approveInteractive(store: ApprovalStore, codeIn: string | undefined, io: ApproveIO): Promise<number> {
  if (!codeIn) { io.stderr.write("Usage: approve <code>\n"); return 1; }
  if (!io.isTTY) {
    io.stderr.write("Refusing to approve: this command needs an interactive terminal (stdin and stdout must be a TTY). Run it yourself in a terminal; nothing was approved.\n");
    return 1;
  }
  let rec;
  try { rec = store.get(codeIn); } catch (e) { io.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); return 1; }
  if (!rec) { io.stderr.write(`No approval ${codeIn.trim().toUpperCase()}: unknown, expired, denied or already used.\n`); return 1; }
  if (rec.status !== "pending") { io.stderr.write(`Approval ${rec.code} is already approved; the next identical call can use it.\n`); return 1; }
  io.stdout.write(`\nApproval ${rec.code} for ${rec.tool}\n\n${rec.summary}\n\n`);
  io.stdout.write("Type 'yes' to approve this operation (anything else aborts): ");
  const rl = createInterface({ input: io.stdin });
  const answer = await new Promise<string>((res) => {
    rl.once("line", (l) => res(l));
    rl.once("close", () => res(""));
  });
  rl.close();
  if (answer.trim() !== "yes") { io.stdout.write("\nAborted. Nothing was approved.\n"); return 1; }
  try {
    const done = store.approve(rec.code);
    io.stdout.write(`\nApproved ${done.code}. It is valid for ${Math.max(1, Math.round((done.expiresAt - Date.now()) / 60000))} minutes; ask the assistant to call again with the same arguments.\n`);
    return 0;
  } catch (e) {
    io.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

function listApprovals(store: ApprovalStore) {
  const now = Date.now();
  const rows = store.list().map((r) => ({
    code: r.code,
    tool: r.tool,
    status: r.status,
    expiresInSeconds: Math.max(0, Math.round((r.expiresAt - now) / 1000)),
    summary: r.summary.split("\n")[0] ?? "",
  }));
  if (jsonMode) { console.log(JSON.stringify(rows)); return; }
  if (rows.length === 0) { console.log("No pending approvals."); return; }
  for (const r of rows) console.log(`${r.code}  ${r.status.padEnd(8)}  ${r.tool}  expires in ${Math.floor(r.expiresInSeconds / 60)}m${String(r.expiresInSeconds % 60).padStart(2, "0")}s  ${r.summary}`);
}

function fmtBytes(n: number | undefined): string {
  if (n === undefined) return "?";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

function findingLine(f: CheckupFindingSummary): string[] {
  const size = f.bytes !== undefined ? `, ${fmtBytes(f.bytes)}` : "";
  const fix = f.fix === "drive_cleanup" ? `fix: ask the assistant (drive_cleanup)${f.fixableCount !== undefined ? `, ${f.fixableCount} fixable` : ""}` : f.fix === "manual" ? "fix: manual" : "";
  const lines = [`  [${f.severity}] ${f.id.padEnd(18)} ${String(f.count).padStart(5)}${size}${fix ? `  (${fix})` : ""}`];
  for (const s of f.samples.slice(0, 3)) lines.push(`        ${s}`);
  return lines;
}

/** Readable text for a drive_checkup summary or one finding page. */
export function formatCheckup(data: CheckupSummary | (CheckupPage & { path: string; caveats?: string[] })): string {
  const out: string[] = [];
  if ("findings" in data) {
    const sc = data.scanned;
    out.push(`Drive checkup of ${data.path}: score ${data.score}/100`);
    out.push(`Scanned ${sc.files} files, ${sc.folders} folders, ${fmtBytes(sc.bytes)}${sc.complete ? "" : " (incomplete)"}${sc.partial ? " (partial: run again in a minute)" : ""}`);
    out.push("");
    for (const f of data.findings) out.push(...findingLine(f));
    out.push(`  trash: ${data.trash.count} items, ${fmtBytes(data.trash.bytes)}`);
  } else {
    out.push(`${data.finding} in ${data.path}: ${data.total} total, showing ${data.items.length} from offset ${data.offset}`);
    for (const it of data.items) out.push(`  ${it.path}${typeof it.size === "number" ? `  (${fmtBytes(it.size)})` : ""}`);
    if (data.nextOffset !== undefined) out.push(`More: --offset ${data.nextOffset}`);
    if (data.note) out.push(data.note);
  }
  for (const c of data.caveats ?? []) out.push(`Note: ${c}`);
  return out.join("\n");
}

async function checkupCommand(sub: string | undefined) {
  const finding = getFlag("--finding");
  if (finding !== undefined && !(CHECKUP_FINDINGS as readonly string[]).includes(finding)) {
    console.error(`--finding must be one of: ${CHECKUP_FINDINGS.join(", ")}`);
    process.exit(1);
  }
  const data = await runCheckup(drive, {
    path: pathOrRoot(sub),
    finding: finding as CheckupFinding | undefined,
    limit: intFlag("--limit"),
    offset: intFlag("--offset"),
    sharing: !args.includes("--no-sharing"),
    refresh: args.includes("--refresh"),
    skipTrash: parseRemoteRoots(process.env.PROTON_DRIVE_REMOTE_ROOTS) !== null,
  });
  if (jsonMode) console.log(JSON.stringify(data));
  else console.log(formatCheckup(data as CheckupSummary));
}

export interface UndoIO { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown } }

function formatUndoPlan(p: UndoPlanResult): string {
  const out = [`Undo plan for ${p.id}: ${p.tool} (${p.kind}), ${p.when}, status ${p.status}`];
  if (p.restore.length) out.push(`Would restore from trash (${p.restore.length}):`, ...p.restore.map((x) => `  ${x}`));
  if (p.moveBack.length) out.push(`Would move back (${p.moveBack.length}):`, ...p.moveBack.map((x) => `  ${x}`));
  const skipped = p.items.filter((i) => !i.restorable);
  if (skipped.length) out.push(`Cannot restore (${skipped.length}):`, ...skipped.map((i) => `  ${i.path}: ${i.reason ?? "not restorable"}`));
  out.push(`Restorable: ${p.restorableCount} of ${p.items.length}`);
  return out.join("\n");
}

/**
 * `undo [--list] [<id>] [--confirm]`; returns the exit code. The CLI is a human tool outside the guard layer, so --confirm is the approval
 * (as for bulk-trash). With --confirm the plan is printed, then applied with the fingerprint of that printed plan: applyUndo re-plans and
 * refuses when anything differs.
 */
export async function undoCommand(
  d: UndoDrive, jo: JournalOpen, o: { list: boolean; id?: string; confirm: boolean; json: boolean; isPathAllowed?: (p: string) => boolean }, io: UndoIO,
): Promise<number> {
  if (!jo.journal) { io.stderr.write(`${jo.reason}\n`); return 1; }
  const journal = jo.journal;
  try {
    if (o.list) {
      const r = await planUndo(d, journal, { action: "list" });
      if (o.json) io.stdout.write(`${JSON.stringify(r)}\n`);
      else if (r.batches.length === 0) io.stdout.write("No recorded batches.\n");
      else for (const b of r.batches) io.stdout.write(`${b.id}  ${b.when}  ${b.tool}  ${b.kind}  ${b.items} item(s)  ${b.status}\n`);
      return 0;
    }
    const plan = await planUndo(d, journal, { action: "plan", id: o.id, isPathAllowed: o.isPathAllowed });
    if (!o.confirm) {
      io.stdout.write(o.json ? `${JSON.stringify({ applied: false, ...plan })}\n` : `${formatUndoPlan(plan)}\n`);
      io.stderr.write("Plan only. Pass --confirm to apply.\n");
      return 0;
    }
    if (!o.json) io.stdout.write(`${formatUndoPlan(plan)}\n`);
    const result = await applyUndo(d, journal, { id: plan.id, expectedFingerprint: plan.fingerprint, isPathAllowed: o.isPathAllowed });
    if (o.json) io.stdout.write(`${JSON.stringify({ applied: true, plan, result })}\n`);
    else {
      io.stdout.write(`Undone ${result.undone} item(s)${result.alreadyInPlace ? `, ${result.alreadyInPlace} already in place` : ""}; batch ${result.id} is now ${result.status}.\n`);
      for (const f of result.failed) io.stdout.write(`  not restored: ${f.path}: ${f.reason}\n`);
    }
    return result.status === "undone" ? 0 : 1;
  } catch (e) {
    io.stderr.write(`${e instanceof UndoError || e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

function setupClaudeDesktop() {
  const configPath = resolve(getFlag("--config") ?? defaultConfigPath());
  const rawSync = getFlag("--sync-path");
  const cliPath = resolveDriveCli();
  if (!cliPath) {
    console.error(`Error: ${cliLaunchError().message}`);
    process.exit(1);
  }
  const syncPath = rawSync !== undefined ? resolve(rawSync) : undefined;
  if (syncPath && !isDirectory(syncPath)) {
    console.error(`Error: --sync-path ${syncPath} is not an existing directory.`);
    process.exit(1);
  }
  const entry = buildEntry(cliPath, syncPath);
  const shown = JSON.stringify({ mcpServers: { [SERVER_KEY]: entry } }, null, 2);
  if (!args.includes("--write")) {
    console.log(`Dry run: nothing changed. Would set this entry in ${configPath}:\n${shown}\nRe-run with --write to apply.`);
    return;
  }
  const backup = writeEntry(configPath, entry);
  console.log(`Wrote ${SERVER_KEY} to ${configPath}${backup ? ` (backup: ${backup})` : ""}.\n${shown}\nFully quit and restart Claude Desktop for the change to take effect.`);
}

async function run() {
  // Strip --json from positional parsing
  const positional = args.filter((a) => a !== "--json");
  const [cmd, sub, ...rest] = positional;

  // Invoked with no arguments: start the MCP server.
  // This supports Glama/Docker environments that run `node dist/cli.js` with no args.
  if (!cmd) {
    const { main } = await import("./index.js");
    await main();
    return;
  }

  if (cmd === "--help" || cmd === "-h") {
    usage();
    return;
  }

  if (cmd === "doctor") {
    const result = await runDoctor(getFlag("--config"));
    console.log(jsonMode ? JSON.stringify(result) : formatDoctor(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (cmd === "setup-claude-desktop") {
    setupClaudeDesktop();
    return;
  }

  if (cmd === "init") {
    const result = await runInit({ configPath: resolve(getFlag("--config") ?? defaultConfigPath()), write: args.includes("--write") });
    console.log(jsonMode ? JSON.stringify({ ...result.json, ok: result.ok }) : result.text);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  // Local file only: no account, no CLI binary needed.
  if (cmd === "index") {
    if (sub === "status") print(indexStatus());
    else if (sub === "clear") {
      const c = await clearContentIndex();
      print({ ...deleteIndex(), changeSnapshotsDeleted: deleteChangeSnapshots(), contentIndexDeleted: c.deleted, contentKeyRemoved: c.keyRemoved, contentIndexNote: c.note });
    }
    else { console.error("Usage: index status|clear"); process.exit(1); }
    return;
  }

  // Local files only: no account, no CLI binary needed.
  if (cmd === "approvals" || cmd === "approve" || cmd === "deny") {
    const store = createApprovalStore({ dir: resolveApprovalDir() });
    if (cmd === "approvals") listApprovals(store);
    else if (cmd === "approve") {
      process.exitCode = await approveInteractive(store, sub, {
        stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
        isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      });
    } else {
      if (!sub) { console.error("Usage: deny <code>"); process.exit(1); }
      if (store.deny(sub)) console.log(`Denied ${sub.trim().toUpperCase()}.`);
      else { console.error(`No approval ${sub.trim().toUpperCase()}: unknown or already used.`); process.exit(1); }
    }
    return;
  }

  const cliCheck = await checkCliAvailable();
  if (!cliCheck.available) {
    const msg = `Error: ${cliLaunchError().message}`;
    console.error(msg);
    process.exit(1);
  }

  switch (cmd) {
    case "auth":
      if (sub === "status") {
        print(await drive.authStatus());
      } else if (sub === "logout") {
        await drive.authLogout();
        console.log("Logged out.");
      } else {
        console.error(`Unknown auth subcommand: ${sub}`);
        process.exit(1);
      }
      break;

    case "version":
      print(await drive.version());
      break;

    case "list":
      print(await drive.list(requirePath(sub, "list <path>")));
      break;

    case "tree":
      print(await driveTree(drive, { path: sub && !sub.startsWith("--") ? sub : undefined, ...numFlags("depth", "limit"), foldersOnly: args.includes("--folders-only") || undefined, refresh: args.includes("--refresh") || undefined }));
      break;

    case "search":
      print(await driveSearch(drive, {
        path: sub && !sub.startsWith("--") ? sub : undefined,
        query: getFlag("--query"), glob: getFlag("--glob"),
        type: getFlag("--type"), mediaType: getFlag("--media-type"),
        extensions: getFlag("--ext")?.split(","),
        ...numFlags("limit", "offset"),
        minSize: numFlag("--min-size"), maxSize: numFlag("--max-size"),
        modifiedAfter: getFlag("--after"), modifiedBefore: getFlag("--before"),
        sort: getFlag("--sort"), refresh: args.includes("--refresh") || undefined,
      }));
      break;

    case "info":
      print(await drive.info(requirePath(sub, "info <path> [--verbose]"), args.includes("--verbose")));
      break;

    case "read":
      print(await readDriveContent(drive, { path: requirePath(sub, "read <path> [--max-chars N] [--offset N]"), maxChars: intFlag("--max-chars"), offset: intFlag("--offset") }));
      break;

    case "upload": {
      const rawLocal = sub;
      if (!rawLocal) { console.error("Usage: upload <local> <remote> [--file-conflict X] [--folder-conflict X] [--skip-thumbnails]"); process.exit(1); }
      let local: string;
      try { local = validateLocalPath(rawLocal, { scan: true, upload: true }); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); return; }
      const remote = requirePath(rest[0], "upload <local> <remote>");
      const fileConflictRaw = getFlag("--file-conflict") ?? "skip";
      if (!["skip", "create-new-revision", "rename", "replace"].includes(fileConflictRaw)) {
        console.error(`Invalid --file-conflict value: ${fileConflictRaw}. Must be skip, create-new-revision, rename, or replace.`);
        process.exit(1);
      }
      const folderConflictRaw = getFlag("--folder-conflict") ?? "skip";
      if (!["skip", "merge", "rename", "replace"].includes(folderConflictRaw)) {
        console.error(`Invalid --folder-conflict value: ${folderConflictRaw}. Must be skip, merge, rename, or replace.`);
        process.exit(1);
      }
      if ((fileConflictRaw === "replace" || folderConflictRaw === "replace") && !args.includes("--confirm")) {
        console.error("Strategy 'replace' trashes the existing remote item.\nPass --confirm to proceed.");
        process.exit(1);
      }
      print(await drive.upload(
        local, remote,
        fileConflictRaw as FileConflictStrategy,
        folderConflictRaw as FolderConflictStrategy,
        args.includes("--skip-thumbnails")
      ));
      break;
    }

    case "download": {
      const remote = requirePath(sub, "download <remote> <local> [--file-conflict X] [--folder-conflict X]");
      const rawLocal2 = rest[0];
      if (!rawLocal2) { console.error("Usage: download <remote> <local>"); process.exit(1); return; }
      let local: string;
      try { local = validateDownloadTarget(rawLocal2, [remote]); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); return; }
      const fileConflictRaw = getFlag("--file-conflict") ?? "skip";
      if (!["skip", "rename", "remove"].includes(fileConflictRaw)) {
        console.error(`Invalid --file-conflict value: ${fileConflictRaw}. Must be skip, rename, or remove.`);
        process.exit(1);
      }
      const folderConflictRaw = getFlag("--folder-conflict") ?? "skip";
      if (!["skip", "merge", "rename", "remove"].includes(folderConflictRaw)) {
        console.error(`Invalid --folder-conflict value: ${folderConflictRaw}. Must be skip, merge, rename, or remove.`);
        process.exit(1);
      }
      if ((fileConflictRaw === "remove" || folderConflictRaw === "remove") && !args.includes("--confirm")) {
        console.error("Strategy 'remove' deletes the existing LOCAL file or folder before downloading.\nPass --confirm to proceed.");
        process.exit(1);
      }
      print(await drive.download(
        remote, local,
        fileConflictRaw as FileDownloadConflictStrategy,
        folderConflictRaw as FolderDownloadConflictStrategy
      ));
      break;
    }

    case "rename": {
      const renamePath = requirePath(sub, "rename <path> <new-name>");
      const rawNewName = rest[0];
      let newName: string;
      try { newName = validateName(rawNewName); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); return; }
      await drive.rename(renamePath, newName);
      console.log(`Renamed: ${renamePath} → ${newName}`);
      break;
    }

    case "move": {
      const src = requirePath(sub, "move <src> <dst>");
      const dst = requirePath(rest[0], "move <src> <dst>");
      await drive.move(src, dst);
      console.log("Moved.");
      break;
    }

    case "mkdir":
      await drive.mkdir(requirePath(sub, "mkdir <path>"));
      console.log("Folder created.");
      break;

    case "delete": {
      const delUid = getFlag("--uid");
      const delPath = delUid && (!sub || sub.startsWith("--")) ? undefined : requirePath(sub, "delete <path>|--uid <uid> --confirm");
      const delLabel = delPath ?? `uid ${delUid}`;
      if (!args.includes("--confirm")) {
        console.error(`This permanently deletes an item already in trash: ${delLabel}\nPass --confirm to proceed.`);
        process.exit(1);
      }
      await drive.delete(delPath, delUid);
      console.log(`Deleted: ${delLabel}`);
      break;
    }

    case "share":
      if (sub === "status") {
        print(await drive.shareStatus(requirePath(rest[0], "share status <path>")));
      } else if (sub === "audit") {
        print(await driveSharingAudit(drive, { path: pathOrRoot(rest[0]), refresh: args.includes("--refresh") }));
      } else if (sub === "invite") {
        const [rawPath, rawEmail, role] = rest;
        if (!rawPath || !rawEmail || !role) {
          console.error("Usage: share invite <path> <email> <role>");
          process.exit(1);
        }
        if (!["viewer", "editor", "admin"].includes(role)) {
          console.error(`Invalid role: ${role}. Must be viewer, editor, or admin.`);
          process.exit(1);
        }
        const invitePath = requirePath(rawPath, "share invite <path> <email> <role>");
        const inviteEmail = requireEmail(rawEmail);
        const rawMessage = getFlag("--message");
        const message = rawMessage !== undefined ? validateMessage(rawMessage) : undefined;
        await drive.shareInvite(invitePath, inviteEmail, role as "viewer" | "editor" | "admin", message);
        console.log(`Invited ${inviteEmail} as ${role}.`);
      } else if (sub === "revoke") {
        const [rawPath, rawEmail] = rest;
        if (!rawPath || !rawEmail) { console.error("Usage: share revoke <path> <email>"); process.exit(1); }
        const revokePath = requirePath(rawPath, "share revoke <path> <email>");
        const revokeEmail = requireEmail(rawEmail);
        await drive.shareRevoke(revokePath, revokeEmail);
        console.log(`Revoked access for ${revokeEmail}.`);
      } else if (sub === "remove-all") {
        const removeAllPath = requirePath(rest[0], "share remove-all <path> --confirm");
        if (!args.includes("--confirm")) {
          console.error(`This removes everyone's access to: ${removeAllPath}\nPass --confirm to proceed.`);
          process.exit(1);
        }
        const removeAll = await drive.shareRemoveAll(removeAllPath);
        console.log((removeAll.removed === 0
          ? `Nothing to remove: ${removeAllPath} has no members or pending invitations.`
          : `Removed all members and invitations (${removeAll.removed}) from: ${removeAllPath}`) +
          (removeAll.publicLink ? " A public link is still active — remove it with: share remove-url <path>" : ""));
      } else if (sub === "set-url") {
        const setUrlPath = requirePath(rest[0], "share set-url <path> [--role] [--password] [--expiration]");
        const roleFlag = getFlag("--role");
        let roleRaw = roleFlag ?? "viewer";
        if (!["viewer", "editor"].includes(roleRaw)) {
          console.error(`Invalid --role value: ${roleRaw}. Must be viewer or editor.`);
          process.exit(1);
        }
        const rawPassword = getFlag("--password");
        const rawExpiration = getFlag("--expiration");
        const password = rawPassword ? validateFlagValue(rawPassword, "password") : undefined;
        const expiration = rawExpiration ? validateFlagValue(rawExpiration, "expiration") : undefined;
        if (roleFlag === undefined) {
          // An omitted role keeps the existing link's role: it is never changed silently.
          const before = await drive.shareStatus(setUrlPath);
          if (before.shareUrl !== undefined || before.sharePasswordProtected !== undefined) {
            if (before.shareUrlRole !== "viewer" && before.shareUrlRole !== "editor") {
              console.error("This path already has a public link whose role could not be read, so it cannot be kept. Pass --role viewer or --role editor.");
              process.exit(1);
            }
            roleRaw = before.shareUrlRole;
          }
        }
        print(await drive.shareSetUrl(setUrlPath, roleRaw as "viewer" | "editor", password, expiration));
      } else if (sub === "remove-url") {
        const removeUrlPath = requirePath(rest[0], "share remove-url <path>");
        await drive.shareRemoveUrl(removeUrlPath);
        console.log(`Public link removed: ${removeUrlPath}`);
      } else if (sub === "leave") {
        const leavePath = requirePath(rest[0], "share leave <path>");
        await drive.shareLeave(leavePath);
        console.log(`Left shared folder: ${leavePath}`);
      } else {
        console.error(`Unknown share subcommand: ${sub}`);
        process.exit(1);
      }
      break;

    case "usage":
      print(await driveUsage(drive, {
        path: pathOrRoot(sub),
        top: intFlag("--top"),
        olderThanDays: intFlag("--older-than"),
        refresh: args.includes("--refresh"),
      }));
      break;

    case "duplicates":
      print(await driveFindDuplicates(drive, {
        path: pathOrRoot(sub),
        minSize: intFlag("--min-size"),
        verify: args.includes("--verify"),
        maxVerifyBytes: intFlag("--max-verify-bytes"),
        maxVerifyTotalBytes: intFlag("--max-verify-total-bytes"),
        limit: intFlag("--limit"),
        refresh: args.includes("--refresh"),
      }));
      break;

    case "checkup":
      await checkupCommand(sub);
      break;

    case "undo": {
      const roots = parseRemoteRoots(process.env.PROTON_DRIVE_REMOTE_ROOTS);
      const id = sub && !sub.startsWith("--") ? sub : rest.find((r) => !r.startsWith("--"));
      process.exitCode = await undoCommand(drive, await openUndoJournal(drive), {
        list: args.includes("--list"), id, confirm: args.includes("--confirm"), json: jsonMode,
        isPathAllowed: roots ? (p) => pathInRoots(p, roots, true) : undefined,
      }, process);
      break;
    }

    case "trash":
      if (sub === "empty") {
        if (!args.includes("--confirm")) {
          console.error("This will permanently delete ALL trash contents.\nPass --confirm to proceed.");
          process.exit(1);
        }
        await drive.emptyTrash();
        console.log("Trash emptied.");
      } else if (sub === "list" || sub === "ls") {
        print(await drive.listTrash());
      } else if (sub) {
        await drive.trash(requirePath(sub, "trash <path>"));
        console.log("Moved to trash.");
      } else {
        console.error("Usage: trash <path> | trash list | trash empty");
        process.exit(1);
      }
      break;

    case "sync-plan": {
      const direction = getFlag("--direction"), compare = getFlag("--compare"), ignore = getFlag("--ignore"), limit = getFlag("--limit");
      if (direction !== undefined && !["up", "down", "both"].includes(direction)) { console.error("--direction must be up, down or both"); process.exit(1); }
      if (compare !== undefined && !["size-mtime", "sha1"].includes(compare)) { console.error("--compare must be size-mtime or sha1"); process.exit(1); }
      if (!sub || !rest[0]) { console.error("Usage: sync-plan <local> <remote> [--direction X] [--compare X] [--ignore g1,g2] [--limit N]"); process.exit(1); }
      print(await syncPlan(drive, {
        localPath: sub, drivePath: rest[0], direction: direction as Direction | undefined, compare: compare as Compare | undefined,
        ignore: ignore?.split(","), limit: limit !== undefined ? Number(limit) : undefined,
      }));
      break;
    }

    case "bulk-move": {
      const dst = requirePath(sub, "bulk-move <dst-folder> <src>... [--confirm]");
      const srcs = validateRemotePathList(rest.filter((r) => !r.startsWith("--")), "sources");
      const plan = planBulkMove(srcs, dst, await loadListing(drive, foldersToList(srcs, dst)));
      if (!args.includes("--confirm") || plan.problems.length) {
        print({ applied: false, ...plan });
        if (plan.problems.length) process.exit(1);
        console.error("Plan only. Pass --confirm to apply.");
        break;
      }
      try { await drive.bulkMove(srcs, dst); } finally { invalidatePath(dst); srcs.forEach(invalidatePath); }
      console.log(`Moved ${srcs.length} item(s) to ${dst}.`);
      break;
    }

    case "bulk-trash": {
      const paths = validateRemotePathList([sub, ...rest].filter((r) => r !== undefined && !r.startsWith("--")), "paths");
      const plan = planBulkTrash(paths, await loadListing(drive, foldersToList(paths)));
      if (!args.includes("--confirm") || plan.problems.length) {
        print({ applied: false, ...plan });
        if (plan.problems.length) process.exit(1);
        console.error("Plan only. Pass --confirm to apply.");
        break;
      }
      try { await drive.bulkTrash(paths); } finally { paths.forEach(invalidatePath); }
      console.log(`Moved ${paths.length} item(s) to trash.`);
      break;
    }

    case "restore": {
      const restoreUid = getFlag("--uid");
      const restorePath = restoreUid && (!sub || sub.startsWith("--")) ? undefined : requirePath(sub, "restore <path>|--uid <uid>");
      await drive.restore(restorePath, restoreUid);
      console.log("Restored.");
      break;
    }

    case "copy": {
      const copySrc = requirePath(sub, "copy <src> <dst>");
      const copyDst = requirePath(rest[0], "copy <src> <dst>");
      const rawCopyName = getFlag("--name");
      let copyName: string | undefined;
      try { copyName = rawCopyName !== undefined ? validateName(rawCopyName) : undefined; }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); return; }
      await drive.copy(copySrc, copyDst, copyName);
      console.log(`Copied: ${copySrc} → ${copyDst}${copyName ? ` as '${copyName}'` : ""}`);
      break;
    }

    case "invitation":
      if (sub === "list" || sub === "ls") {
        print(await drive.listInvitations());
      } else if (sub === "accept") {
        const rawAcceptUid = rest[0];
        if (!rawAcceptUid) { console.error("Usage: invitation accept <uid>"); process.exit(1); }
        let acceptUid: string;
        try { acceptUid = validateFlagValue(rawAcceptUid, "uid"); }
        catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); return; }
        await drive.invitationAccept(acceptUid);
        console.log("Invitation accepted.");
      } else if (sub === "reject") {
        const rawRejectUid = rest[0];
        if (!rawRejectUid) { console.error("Usage: invitation reject <uid>"); process.exit(1); }
        let rejectUid: string;
        try { rejectUid = validateFlagValue(rawRejectUid, "uid"); }
        catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); return; }
        await drive.invitationReject(rejectUid);
        console.log("Invitation rejected.");
      } else {
        console.error("Usage: invitation list | invitation accept <uid> | invitation reject <uid>");
        process.exit(1);
      }
      break;

    case "album":
      if (sub === "list" || sub === "ls") {
        print(await drive.listAlbums());
      } else if (sub === "create") {
        const rawAlbumName = rest[0];
        if (!rawAlbumName) { console.error("Usage: album create <name>"); process.exit(1); return; }
        let albumName: string;
        try { albumName = validateName(rawAlbumName); }
        catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); return; }
        await drive.createAlbum(albumName);
        console.log(`Album created: ${albumName}`);
      } else if (sub === "update") {
        const albumPath = requirePath(rest[0], "album update <path> [--name] [--cover-photo-uid]");
        const rawNewName = getFlag("--name");
        const rawCoverPhotoUid = getFlag("--cover-photo-uid");
        if (!rawNewName && !rawCoverPhotoUid) {
          console.error("Usage: album update <path> [--name <name>] [--cover-photo-uid <uid>] (at least one required)");
          process.exit(1);
          return;
        }
        let newName: string | undefined;
        let coverPhotoUid: string | undefined;
        try {
          newName = rawNewName ? validateName(rawNewName) : undefined;
          coverPhotoUid = rawCoverPhotoUid ? validateName(rawCoverPhotoUid) : undefined;
        } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); return; }
        await drive.updateAlbum(albumPath, newName, coverPhotoUid);
        console.log(`Album updated: ${newName ? `/albums/${newName}` : albumPath}`);
      } else if (sub === "delete") {
        const albumPath = requirePath(rest[0], "album delete <path> [--force] [--save] --confirm");
        if (!args.includes("--confirm")) {
          console.error(`This will delete album: ${albumPath}\nPass --confirm to proceed.`);
          process.exit(1);
        }
        await drive.deleteAlbum(albumPath, args.includes("--force"), args.includes("--save"));
        console.log(`Album deleted: ${albumPath}`);
      } else if (sub === "photos") {
        const albumPath = requirePath(rest[0], "album photos <path>");
        print(await drive.listAlbumPhotos(albumPath, args.includes("--load-details")));
      } else if (sub === "add-photo") {
        const albumPath = requirePath(rest[0], "album add-photo <album-path> <photo-path>");
        const photoPath = requirePath(rest[1], "album add-photo <album-path> <photo-path>");
        await drive.addPhotoToAlbum(albumPath, photoPath);
        console.log(`Added ${photoPath} to ${albumPath}`);
      } else if (sub === "remove-photo") {
        const albumPath = requirePath(rest[0], "album remove-photo <album-path> <photo-path>");
        const photoPath = requirePath(rest[1], "album remove-photo <album-path> <photo-path>");
        await drive.removePhotoFromAlbum(albumPath, photoPath);
        console.log(`Removed ${photoPath} from ${albumPath}`);
      } else {
        console.error("Usage: album list | album create <name> | album update <path> | album delete <path> | album photos <path> | album add-photo <album> <photo> | album remove-photo <album> <photo>");
        process.exit(1);
      }
      break;

    case "photo": {
      // Strip --conflict <value> out of a variadic positional list.
      const conflictFlagIdx = rest.indexOf("--conflict");
      const positionals = (conflictFlagIdx === -1
        ? rest
        : [...rest.slice(0, conflictFlagIdx), ...rest.slice(conflictFlagIdx + 2)]
      ).filter((x) => x !== "--confirm" && x !== "--load-details");
      const conflictRaw = getFlag("--conflict") ?? "skip";

      if (sub === "timeline") {
        print(await drive.photoTimeline(args.includes("--load-details")));
      } else if (sub === "download") {
        if (positionals.length < 2) { console.error("Usage: photo download <photo>... <local-folder> [--conflict X]"); process.exit(1); return; }
        const localFolder = positionals[positionals.length - 1];
        const photoPaths = positionals.slice(0, -1).map((p) => requirePath(p, "photo download <photo>... <local-folder>"));
        let localFolderValidated: string;
        try { localFolderValidated = validateDownloadTarget(localFolder, photoPaths); }
        catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); return; }
        if (!["skip", "rename", "remove"].includes(conflictRaw)) {
          console.error(`Invalid --conflict value: ${conflictRaw}. Must be skip, rename, or remove.`);
          process.exit(1);
        }
        if (conflictRaw === "remove" && !args.includes("--confirm")) {
          console.error("Strategy 'remove' deletes the existing LOCAL file before downloading.\nPass --confirm to proceed.");
          process.exit(1);
        }
        print(await drive.photoDownload(photoPaths, localFolderValidated, conflictRaw as PhotoDownloadConflictStrategy));
      } else if (sub === "upload") {
        if (positionals.length === 0) { console.error("Usage: photo upload <local>... [--conflict X]"); process.exit(1); return; }
        const localPaths: string[] = [];
        for (const p of positionals) {
          try { localPaths.push(validateLocalPath(p, { scan: true, upload: true })); }
          catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); return; }
        }
        if (!["skip", "rename"].includes(conflictRaw)) {
          console.error(`Invalid --conflict value: ${conflictRaw}. Must be skip or rename.`);
          process.exit(1);
        }
        print(await drive.photoUpload(localPaths, conflictRaw as PhotoUploadConflictStrategy));
      } else {
        console.error("Usage: photo timeline [--load-details] | photo download <photo>... <local> | photo upload <local>...");
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
}

/** True when started as a bin (cli.js directly, or index.js delegating `init`); false when a test imports the exports. */
function isEntryPoint(): boolean {
  try {
    const entry = realpathSync(process.argv[1]);
    const self = realpathSync(fileURLToPath(import.meta.url));
    return entry === self || entry === realpathSync(fileURLToPath(new URL("./index.js", import.meta.url)));
  } catch { return false; }
}

if (isEntryPoint()) run().catch((err) => {
  if (err instanceof DriveCliNotFoundError || err instanceof DriveNotAuthenticatedError) {
    console.error(err.message);
  } else if (err instanceof DriveCliError) {
    console.error(`CLI error: ${err.message}`);
    if (err.stderr) console.error(err.stderr);
  } else if (err instanceof DriveParseError) {
    console.error(`Parse error: ${err.message}`);
  } else if (err instanceof Error) {
    console.error(err.message);
  } else {
    console.error("Error:", String(err));
  }
  process.exit(1);
});
