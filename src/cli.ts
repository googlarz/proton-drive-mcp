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
import { checkCliAvailable } from "./utils/subprocess.js";
import { validateRemotePath, validateLocalPath, validateEmail, validateMessage, validateName, validateFlagValue } from "./utils/validation.js";

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
  info <path>                              Show full node metadata for one path
  mkdir <path>                             Create a new folder
  upload <local> <remote> [--file-conflict X] [--folder-conflict X]
                                           Upload file/folder (files: skip/create-new-revision/rename/replace; folders: skip/merge/rename/replace)
  download <remote> <local> [--file-conflict X] [--folder-conflict X]
                                           Download file/folder (files: skip/rename/remove; folders: skip/merge/rename/remove)
  rename <path> <new-name>                 Rename in place, no move
  move <src> <dst>                         Move and/or rename
  delete <path> --confirm                  Delete a file/folder already in trash, permanently
  share status <path>                      Show sharing info
  share invite <path> <email> <role>       Invite user (viewer/editor/admin)
  share revoke <path> <email>              Revoke one user's access
  share remove-all <path> --confirm        Remove everyone's access + pending invitations
  share set-url <path> [--role] [--password] [--expiration]  Create/update public link
  share remove-url <path>                  Remove public link
  share leave <path>                       Leave a folder shared with you
  copy <src> <dst>                         Copy file/folder
  trash <path>                             Move to trash
  trash list                               List trash contents
  trash empty --confirm                    Permanently delete all trash
  restore <path>                           Restore from trash
  invitation list                          List pending invitations
  invitation accept <uid>                  Accept an invitation
  invitation reject <uid>                  Reject an invitation
  album list                               List all photo albums
  album create <name>                      Create a new album
  album update <path> [--name] [--cover-photo-uid]  Rename/update album cover
  album delete <path> --confirm [--force] [--save]  Delete an album
  album photos <path>                      List photos in an album
  album add-photo <album> <photo>          Add a photo to an album
  album remove-photo <album> <photo>       Remove a photo from an album
  photo timeline [--load-details]          List photos in your timeline
  photo download <photo>... <local> [--conflict X]  Download photos (skip/rename/remove)
  photo upload <local>... [--conflict X]   Upload photos to your library (skip/rename)

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

    case "info":
      print(await drive.info(requirePath(sub, "info <path>")));
      break;

    case "upload": {
      const rawLocal = sub;
      if (!rawLocal) { console.error("Usage: upload <local> <remote> [--file-conflict X] [--folder-conflict X]"); process.exit(1); }
      let local: string;
      try { local = validateLocalPath(rawLocal); }
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
      print(await drive.upload(
        local, remote,
        fileConflictRaw as FileConflictStrategy,
        folderConflictRaw as FolderConflictStrategy
      ));
      break;
    }

    case "download": {
      const remote = requirePath(sub, "download <remote> <local> [--file-conflict X] [--folder-conflict X]");
      const rawLocal2 = rest[0];
      if (!rawLocal2) { console.error("Usage: download <remote> <local>"); process.exit(1); return; }
      let local: string;
      try { local = validateLocalPath(rawLocal2); }
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
      const delPath = requirePath(sub, "delete <path> --confirm");
      if (!args.includes("--confirm")) {
        console.error(`This permanently deletes an item already in trash: ${delPath}\nPass --confirm to proceed.`);
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
      } else if (sub === "remove-all") {
        const removeAllPath = requirePath(rest[0], "share remove-all <path> --confirm");
        if (!args.includes("--confirm")) {
          console.error(`This removes everyone's access to: ${removeAllPath}\nPass --confirm to proceed.`);
          process.exit(1);
        }
        await drive.shareRemove(removeAllPath, [], true);
        console.log(`Removed all access to: ${removeAllPath}`);
      } else if (sub === "set-url") {
        const setUrlPath = requirePath(rest[0], "share set-url <path> [--role] [--password] [--expiration]");
        const roleRaw = getFlag("--role") ?? "viewer";
        if (!["viewer", "editor"].includes(roleRaw)) {
          console.error(`Invalid --role value: ${roleRaw}. Must be viewer or editor.`);
          process.exit(1);
        }
        const rawPassword = getFlag("--password");
        const rawExpiration = getFlag("--expiration");
        const password = rawPassword ? validateFlagValue(rawPassword, "password") : undefined;
        const expiration = rawExpiration ? validateFlagValue(rawExpiration, "expiration") : undefined;
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

    case "copy": {
      const copySrc = requirePath(sub, "copy <src> <dst>");
      const copyDst = requirePath(rest[0], "copy <src> <dst>");
      await drive.copy(copySrc, copyDst);
      console.log(`Copied: ${copySrc} → ${copyDst}`);
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
        console.log(`Album updated: ${albumPath}`);
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
        print(await drive.listAlbumPhotos(albumPath));
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
      const positionals = conflictFlagIdx === -1
        ? rest
        : [...rest.slice(0, conflictFlagIdx), ...rest.slice(conflictFlagIdx + 2)];
      const conflictRaw = getFlag("--conflict") ?? "skip";

      if (sub === "timeline") {
        print(await drive.photoTimeline(args.includes("--load-details")));
      } else if (sub === "download") {
        if (positionals.length < 2) { console.error("Usage: photo download <photo>... <local-folder> [--conflict X]"); process.exit(1); return; }
        const localFolder = positionals[positionals.length - 1];
        const photoPaths = positionals.slice(0, -1).map((p) => requirePath(p, "photo download <photo>... <local-folder>"));
        let localFolderValidated: string;
        try { localFolderValidated = validateLocalPath(localFolder); }
        catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); return; }
        if (!["skip", "rename", "remove"].includes(conflictRaw)) {
          console.error(`Invalid --conflict value: ${conflictRaw}. Must be skip, rename, or remove.`);
          process.exit(1);
        }
        print(await drive.photoDownload(photoPaths, localFolderValidated, conflictRaw as PhotoDownloadConflictStrategy));
      } else if (sub === "upload") {
        if (positionals.length === 0) { console.error("Usage: photo upload <local>... [--conflict X]"); process.exit(1); return; }
        const localPaths: string[] = [];
        for (const p of positionals) {
          try { localPaths.push(validateLocalPath(p)); }
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
