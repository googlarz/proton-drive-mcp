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
 *   upload <local-path> <remote-path> [--conflict skip|overwrite|rename]
 *   download <remote-path> <local-path>
 *   move <src> <dst>
 *   delete <path>
 *   share status <path>
 *   share invite <path> <email> <role> [--message "..."]
 *   share revoke <path> <email>
 *   trash <path>
 *   restore <path>
 *   trash empty
 */

import { DriveService } from "./services/drive.js";
import { DriveCliNotFoundError, DriveNotAuthenticatedError } from "./utils/errors.js";

const drive = new DriveService();
const args = process.argv.slice(2);

function usage() {
  console.log(`
proton-drive-cli — Proton Drive companion CLI

Commands:
  auth status                              Check authentication status
  auth logout                              Log out
  version                                  Show CLI/SDK version
  list <path>                              List files at path
  upload <local> <remote> [--conflict X]  Upload file/folder
  download <remote> <local>               Download file/folder
  move <src> <dst>                         Move/rename
  delete <path>                            Delete file/folder
  share status <path>                      Show sharing info
  share invite <path> <email> <role>       Invite user (viewer/editor/admin)
  share revoke <path> <email>              Revoke access
  trash <path>                             Move to trash
  restore <path>                           Restore from trash
  trash empty                              Empty trash
`);
}

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function print(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

async function run() {
  const [cmd, sub, ...rest] = args;

  if (!cmd || cmd === "--help" || cmd === "-h") {
    usage();
    return;
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
      if (!sub) { console.error("Usage: list <path>"); process.exit(1); }
      print(await drive.list(sub));
      break;

    case "upload": {
      const [local, remote] = [sub, rest[0]];
      if (!local || !remote) { console.error("Usage: upload <local> <remote>"); process.exit(1); }
      const conflict = (getFlag("--conflict") as "skip" | "overwrite" | "rename") ?? "skip";
      print(await drive.upload(local, remote, conflict));
      break;
    }

    case "download": {
      const [remote, local] = [sub, rest[0]];
      if (!remote || !local) { console.error("Usage: download <remote> <local>"); process.exit(1); }
      print(await drive.download(remote, local));
      break;
    }

    case "move": {
      const [src, dst] = [sub, rest[0]];
      if (!src || !dst) { console.error("Usage: move <src> <dst>"); process.exit(1); }
      await drive.move(src, dst);
      console.log("Moved.");
      break;
    }

    case "delete":
      if (!sub) { console.error("Usage: delete <path>"); process.exit(1); }
      await drive.delete(sub);
      console.log("Deleted.");
      break;

    case "share":
      if (sub === "status") {
        const path = rest[0];
        if (!path) { console.error("Usage: share status <path>"); process.exit(1); }
        print(await drive.shareStatus(path));
      } else if (sub === "invite") {
        const [path, email, role] = rest;
        if (!path || !email || !role) {
          console.error("Usage: share invite <path> <email> <role>");
          process.exit(1);
        }
        const message = getFlag("--message");
        await drive.shareInvite(path, email, role as "viewer" | "editor" | "admin", message);
        console.log(`Invited ${email} as ${role}.`);
      } else if (sub === "revoke") {
        const [path, email] = rest;
        if (!path || !email) { console.error("Usage: share revoke <path> <email>"); process.exit(1); }
        await drive.shareRevoke(path, email);
        console.log(`Revoked access for ${email}.`);
      } else {
        console.error(`Unknown share subcommand: ${sub}`);
        process.exit(1);
      }
      break;

    case "trash":
      if (sub === "empty") {
        await drive.emptyTrash();
        console.log("Trash emptied.");
      } else if (sub) {
        await drive.trash(sub);
        console.log("Moved to trash.");
      } else {
        console.error("Usage: trash <path> | trash empty");
        process.exit(1);
      }
      break;

    case "restore":
      if (!sub) { console.error("Usage: restore <path>"); process.exit(1); }
      await drive.restore(sub);
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
  } else {
    console.error("Error:", String(err));
  }
  process.exit(1);
});
