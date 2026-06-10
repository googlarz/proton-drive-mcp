#!/usr/bin/env node

/**
 * Companion CLI for proton-drive-mcp.
 * Provides a human-friendly interface to the same DriveService used by the MCP server.
 *
 * Usage: proton-drive-cli <command> [args]
 *   auth status
 *   auth logout
 *   version
 *   list <remote-path>
 *   mkdir <remote-path>
 *   upload <local-path> <remote-path> [--conflict skip|overwrite|rename]
 *   download <remote-path> <local-path>
 *   move <src> <dst>
 *   delete <path>
 *   share status <path>
 *   share invite <path> <email> <role> [--message "..."]
 *   share revoke <path> <email>
 *   trash <path>
 *   trash list
 *   trash empty
 *   restore <path>
 *
 * Global flags:
 *   --json   Machine-readable JSON output
 */

import { DriveService } from "./services/drive.js";
import { DriveCliError, DriveCliNotFoundError, DriveNotAuthenticatedError, DriveParseError } from "./utils/errors.js";
import { checkCliAvailable } from "./utils/subprocess.js";
import { validatePath, validateLocalPath, validateEmail, validateMessage } from "./utils/validation.js";

const drive = new DriveService();
const args = process.argv.slice(2);
const jsonMode = args.includes("--json");

function usage() {
  console.log(`
proton-drive-cli — Proton Drive companion CLI

Commands:
  auth status                              Check authentication status
  auth logout                              Log out
  version                                  Show CLI/SDK version
  list <path>                              List files at path
  mkdir <path>                             Create a new folder
  upload <local> <remote> [--conflict X]  Upload file/folder (skip/overwrite/rename)
  download <remote> <local>               Download file/folder
  move <src> <dst>                         Move/rename
  delete <path>                            Delete file/folder permanently
  share status <path>                      Show sharing info
  share invite <path> <email> <role>       Invite user (viewer/editor/admin)
  share revoke <path> <email>              Revoke access
  trash <path>                             Move to trash
  trash list                               List trash contents
  trash empty                              Permanently delete all trash
  restore <path>                           Restore from trash

Flags:
  --json                                   Machine-readable JSON output (one line)
`);
}

function requirePath(value: string | undefined, usage: string): string {
  if (!value) { console.error(`Usage: ${usage}`); process.exit(1); }
  try { return validatePath(value); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
  return "" as never; // unreachable; process.exit(1) above always terminates
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

function print(data: unknown) {
  console.log(jsonMode ? JSON.stringify(data) : JSON.stringify(data, null, 2));
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

  const cliCheck = await checkCliAvailable();
  if (!cliCheck.available) {
    const msg = cliCheck.reason === "not_executable"
      ? "Error: proton-drive CLI found but not executable.\nRun: chmod +x $(which proton-drive)"
      : "Error: proton-drive CLI not found in PATH.\nDownload from https://proton.me/download/drive/cli/index.html";
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

    case "upload": {
      const rawLocal = sub;
      if (!rawLocal) { console.error("Usage: upload <local> <remote>"); process.exit(1); }
      let local: string;
      try { local = validateLocalPath(rawLocal); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); return; }
      const remote = requirePath(rest[0], "upload <local> <remote>");
      const conflictRaw = getFlag("--conflict") ?? "skip";
      if (!["skip", "overwrite", "rename"].includes(conflictRaw)) {
        console.error(`Invalid --conflict value: ${conflictRaw}. Must be skip, overwrite, or rename.`);
        process.exit(1);
      }
      const conflict = conflictRaw as "skip" | "overwrite" | "rename";
      print(await drive.upload(local, remote, conflict));
      break;
    }

    case "download": {
      const remote = requirePath(sub, "download <remote> <local>");
      const rawLocal2 = rest[0];
      if (!rawLocal2) { console.error("Usage: download <remote> <local>"); process.exit(1); return; }
      let local: string;
      try { local = validateLocalPath(rawLocal2); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); return; }
      print(await drive.download(remote, local));
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
      const delPath = requirePath(sub, "delete <path> --confirm");
      if (!args.includes("--confirm")) {
        console.error(`This will permanently delete: ${delPath}\nPass --confirm to proceed.`);
        process.exit(1);
      }
      await drive.delete(delPath);
      console.log(`Deleted: ${delPath}`);
      break;
    }

    case "share":
      if (sub === "status") {
        print(await drive.shareStatus(requirePath(rest[0], "share status <path>")));
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
      } else {
        console.error(`Unknown share subcommand: ${sub}`);
        process.exit(1);
      }
      break;

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

    case "restore":
      await drive.restore(requirePath(sub, "restore <path>"));
      console.log("Restored.");
      break;

    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
}

run().catch((err) => {
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
