#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import {
  DriveService,
  type FileConflictStrategy,
  type FolderConflictStrategy,
  type FileDownloadConflictStrategy,
  type FolderDownloadConflictStrategy,
  type PhotoUploadConflictStrategy,
  type PhotoDownloadConflictStrategy,
} from "./services/drive.js";
import { PROMPTS, getPromptText } from "./prompts.js";
import { isMainModule } from "./utils/isMainModule.js";
import { checkCliAvailable, callContext, killAllChildren } from "./utils/subprocess.js";
import {
  DriveCliNotFoundError,
  DriveCliError,
  DriveNotAuthenticatedError,
  DriveParseError,
  NeedsConfirmationError,
} from "./utils/errors.js";
import { validateRemotePath, validateRemotePathList, validateLocalPath, validateEmail, validateMessage, validateName, validateFlagValue } from "./utils/validation.js";
import { logger } from "./utils/logger.js";
import { driveSearch, driveTree } from "./services/find.js";
import { syncPlan, planBulkMove, planBulkTrash, loadListing, foldersToList, type Direction, type Compare } from "./services/plan.js";
import { invalidatePath } from "./services/walk.js";
import { getSyncRoot, readSyncFile, writeSyncFile, syncFileExists } from "./utils/syncfs.js";
import type { AlbumPhoto } from "./types/index.js";
import { driveUsage, driveFindDuplicates, driveSharingAudit } from "./services/analytics.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };
const VERSION = pkg.version ?? "1.0.0";

process.env["PROTON_DRIVE_MCP"] = "1";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

function fail(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function truncate(s: string, max = 500): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Results produced by a NeedsConfirmationError; the only results that may trigger a human prompt.
const confirmationRefusals = new WeakSet<ToolResult>();

function handleError(err: unknown): ToolResult {
  if (err instanceof NeedsConfirmationError) {
    const r = fail(err.message);
    confirmationRefusals.add(r);
    return r;
  }
  if (err instanceof DriveCliNotFoundError) return fail(err.message);
  if (err instanceof DriveNotAuthenticatedError) return fail(err.message);
  if (err instanceof DriveCliError) return fail(`CLI error: ${truncate(err.message)}`);
  if (err instanceof DriveParseError) return fail(`Parse error: ${err.message}`);
  if (err instanceof Error) return fail(truncate(err.message));
  return fail(`Unexpected error: ${truncate(String(err))}`);
}

// Outward-facing / destructive tools refuse to run without an explicit
// confirmed=true, so a prompt-injected or careless agent cannot trigger them in
// a single call. Mirrors the CLI's --confirm flags.
function needConfirm(a: Record<string, unknown>, tool: string, action: string): void {
  if (a.confirmed === true) return;
  throw new NeedsConfirmationError(`${tool} ${action} Describe this to the user, get their explicit OK, then call again with confirmed=true.`);
}

function paginate<T>(all: T[], a: Record<string, unknown>, defaultLimit: number) {
  const limit = typeof a.limit === "number" ? a.limit : defaultLimit;
  const offset = typeof a.offset === "number" ? a.offset : 0;
  const items = all.slice(offset, offset + limit);
  return { total: all.length, offset, limit, hasMore: offset + items.length < all.length, items };
}

// Every page re-runs the CLI, whose order is not stable, so paginated lists
// must be put in a total order before slicing or pages lose/duplicate items.
function byTimeDescThenId<T>(time: (x: T) => string | undefined, id: (x: T) => string | undefined) {
  return (x: T, y: T) => {
    const t = (time(y) ?? "").localeCompare(time(x) ?? "");
    if (t) return t;
    const a = id(x) ?? "", b = id(y) ?? "";
    return a < b ? -1 : a > b ? 1 : 0;
  };
}
const photoOrder = byTimeDescThenId<AlbumPhoto>((p) => p.captureTime, (p) => p.nodeUid);

type JsonSchemaProp = { type?: string; enum?: readonly unknown[]; items?: { type?: string }; minimum?: number; maximum?: number };
type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, JsonSchemaProp>; required?: readonly string[]; additionalProperties?: boolean };
  annotations?: Record<string, boolean>;
  title?: string;
};

// The schemas advertise additionalProperties:false, but nothing enforced it, and
// String() coercion let e.g. an array pass as a path. Enforce the declared schema.
function checkArgs(def: ToolDef, a: Record<string, unknown>): string | undefined {
  const props = def.inputSchema.properties;
  for (const k of Object.keys(a)) {
    if (!(k in props)) return `Unknown argument '${k}'. Allowed: ${Object.keys(props).join(", ") || "(none)"}.`;
  }
  for (const k of def.inputSchema.required ?? []) {
    if (a[k] === undefined || a[k] === null) return `Missing required argument '${k}'.`;
  }
  for (const [k, v] of Object.entries(a)) {
    const p = props[k];
    if (v === undefined || v === null || !p) continue;
    if (p.type === "string" && typeof v !== "string") return `${k} must be a string.`;
    if (p.type === "boolean" && typeof v !== "boolean") return `${k} must be a boolean.`;
    if (p.type === "integer") {
      if (typeof v !== "number" || !Number.isInteger(v)) return `${k} must be an integer.`;
      if (p.minimum !== undefined && v < p.minimum) return `${k} must be >= ${p.minimum}.`;
      if (p.maximum !== undefined && v > p.maximum) return `${k} must be <= ${p.maximum}.`;
    }
    if (p.type === "array") {
      if (!Array.isArray(v)) return `${k} must be an array.`;
      if (p.items?.type === "string" && v.some((x) => typeof x !== "string")) return `${k} must be an array of strings.`;
    }
    if (p.enum && !p.enum.includes(v)) return `${k} must be one of: ${p.enum.join(", ")}.`;
  }
  return undefined;
}

const TOOLS = [
  // Auth
  {
    name: "drive_auth_status",
    description:
      "Check whether the Proton Drive CLI has an authenticated session. Returns {authenticated: boolean}. The CLI has no status command, so this probes by resolving /my-files (a real, lightweight call). Does not expose the account email. All other drive_* tools except drive_version need a valid session.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_auth_logout",
    description:
      "Clear the stored Proton Drive session from the OS keychain. All file and sharing operations fail afterwards until the user runs `proton-drive auth login` again. Idempotent.",
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_version",
    description:
      "Return the installed proton-drive CLI and SDK versions as {cli, sdk}. Needs no authentication; use to confirm the binary or diagnose compatibility.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  // Filesystem
  {
    name: "drive_list",
    description:
      "List the immediate children of a Proton Drive folder (one level, not recursive). Listing '/' returns the top-level roots. Returns {items, total, offset, limit, hasMore} (default limit 200, sorted by name); items are [{name, path, type ('file'|'folder'), size? (bytes), storageSize? (encrypted, all revisions), modifiedAt?, mimeType?, mtime? (original local modification time), uploadedAt? (revision upload time), sha1? (hash CLAIMED by the uploader: unverified and often absent)}]. Items come in a stable sorted order; each page is a fresh read, so changes between page calls can still shift items. Use drive_list_trash for the trash.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote path, e.g. /my-files/Reports.",
        },
        type: {
          type: "string",
          enum: ["file", "folder"],
          description: "Only list items of this type (default: both).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_info",
    description:
      "Get full metadata for one Proton Drive file or folder, including latest revision details. Also returns mtime (original local modification time), uploadedAt (revision upload time) and sha1 (hash CLAIMED by the uploader: unverified and often absent) when known. Verification wrappers are unwrapped and noise fields dropped (verbose=true returns the raw CLI node, whose shape is not guaranteed). Use drive_list to enumerate children.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote path, e.g. /my-files/report.pdf.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_tree",
    description:
      "Folder overview with per-folder file counts and size totals, largest first. Returns {files, folders, size, complete, unexpanded?, skipped?, tree}. Totals cover opened folders only; 'unexpanded' counts folders not opened (depth limit, .git/node_modules, failures). complete=false: part of the tree failed to load. Cached 5 min; refresh=true re-reads.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Default /my-files." },
        depth: { type: "integer", minimum: 1, maximum: 10, description: "Levels (default 2)." },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Max entries (default 200); rest counted in 'more'." },
        foldersOnly: { type: "boolean", description: "Hide files (totals still count them)." },
        refresh: { type: "boolean", description: "Bypass the cache." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "drive_search",
    description:
      "Find files/folders under a path by name, type, extension, size or date in one walk. Filters are ANDed. Returns {total, hasMore, items [{path, type, size?, mtime?, sha1?}], walk {complete, fromCache, skipped?}}; walk.complete=false means matches may be missing. Cached 5 min; refresh=true re-reads; skips .git/node_modules.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name substring, case-insensitive." },
        glob: { type: "string", description: "Name pattern, e.g. *.pdf (* ? **)." },
        path: { type: "string", description: "Default /my-files." },
        type: { type: "string", enum: ["file", "folder"], description: "Only files or folders." },
        mediaType: { type: "string", description: "MIME prefix, e.g. image/." },
        extensions: { type: "array", items: { type: "string" }, description: "e.g. ['pdf','docx']." },
        minSize: { type: "integer", minimum: 0, description: "Bytes (files only)." },
        maxSize: { type: "integer", minimum: 0, description: "Bytes (files only)." },
        modifiedAfter: { type: "string", description: "ISO date (original mtime, else upload time)." },
        modifiedBefore: { type: "string", description: "ISO date." },
        sort: { type: "string", enum: ["name", "size", "mtime"], description: "Default name; size and mtime sort descending." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 50." },
        offset: { type: "integer", minimum: 0, description: "Items to skip." },
        refresh: { type: "boolean", description: "Bypass the cache." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "drive_upload",
    description:
      "Upload a local file or folder to Proton Drive with end-to-end encryption; folders upload recursively. Returns {uploaded, skipped, failed} counts and fails the call if failed > 0 (e.g. quota exceeded, destination not found). File and folder conflict strategies are separate (CLI v0.8.0+), both default to 'skip'. The destination folder must exist (drive_mkdir creates it). To write text directly use drive_write_file.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        localPath: {
          type: "string",
          description: "Absolute local path of the file or folder to upload.",
        },
        remotePath: {
          type: "string",
          description: "Absolute remote destination folder, e.g. /my-files/Reports.",
        },
        fileConflictStrategy: {
          type: "string",
          enum: ["skip", "create-new-revision", "rename", "replace"],
          description:
            "'skip' keeps the existing remote file (default). 'create-new-revision' uploads as a new version, keeping history. 'rename' uploads under a unique name. 'replace' trashes the remote file first — confirm with user.",
        },
        folderConflictStrategy: {
          type: "string",
          enum: ["skip", "merge", "rename", "replace"],
          description:
            "'skip' keeps the existing remote folder (default). 'merge' merges contents into it. 'rename' uploads under a unique name. 'replace' trashes the remote folder first — confirm with user.",
        },
      },
      required: ["localPath", "remotePath"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_download",
    description:
      "Download a file or folder from Proton Drive to the local filesystem. localPath is a destination FOLDER, not the file's final path — created if missing; the item is placed inside it under its remote name (/my-files/report.pdf with localPath '/tmp/out' gives /tmp/out/report.pdf). Folders download recursively. File and folder conflict strategies are separate, both default to 'skip'. Returns {downloaded, skipped, failed} counts (not the local path) and fails the call if any file failed.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        remotePath: {
          type: "string",
          description: "Absolute remote path to download, e.g. /my-files/report.pdf.",
        },
        localPath: {
          type: "string",
          description: "Absolute local DESTINATION FOLDER, not the file's final path. Created if missing; the item is placed inside it under its remote name.",
        },
        fileConflictStrategy: {
          type: "string",
          enum: ["skip", "rename", "remove"],
          description:
            "'skip' keeps the existing local file (default). 'rename' downloads under a unique name. 'remove' deletes the local file first — confirm with user.",
        },
        folderConflictStrategy: {
          type: "string",
          enum: ["skip", "merge", "rename", "remove"],
          description:
            "'skip' keeps the existing local folder (default). 'merge' merges contents into it. 'rename' downloads under a unique name. 'remove' deletes the local folder first — confirm with user.",
        },
      },
      required: ["remotePath", "localPath"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_mkdir",
    description:
      "Create a new empty folder on Proton Drive. Fails if it exists or the parent is missing; does not create intermediate directories, so create each level separately.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote path of the new folder, e.g. /my-files/NewFolder.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_rename",
    description:
      "Rename a file or folder in place (same parent). To change folders use drive_move.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote path to rename.",
        },
        newName: {
          type: "string",
          description: "New filename (not a path — just the name, e.g. 'report-v2.pdf').",
        },
      },
      required: ["path", "newName"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_move",
    description:
      "Move or rename a file or folder. destinationPath is the FULL new path (not the parent folder): same parent + new filename renames, a different parent moves. Fails if destinationPath is occupied or its parent is missing. To keep the original use drive_copy.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: {
          type: "string",
          description: "Absolute remote path to move.",
        },
        destinationPath: {
          type: "string",
          description: "Absolute remote destination path (full new path); parent must exist.",
        },
      },
      required: ["sourcePath", "destinationPath"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_delete",
    description:
      "Permanently delete a file or folder already in the Proton Drive trash — irreversible. The CLI only accepts items inside /trash or /photos-trash, so drive_trash first, then pass the trash path (or uid from drive_list_trash). If several trashed items share the name, this refuses and lists their uids: the CLI can only address trashed items by name, so use the Proton Drive web or desktop app for that. Requires confirmed=true; show the exact path to the user first.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Trash path to delete permanently. Give path or uid (or both).",
        },
        uid: {
          type: "string",
          description: "Trash uid from drive_list_trash; if path is also given they must match.",
        },
        confirmed: {
          type: "boolean",
          description: "Must be true; the user has acknowledged this is permanent.",
        },
      },
      required: ["confirmed"],
      additionalProperties: false,
    },
  },
  // Sharing
  {
    name: "drive_share_status",
    description:
      "Return the sharing state of a Proton Drive path: {isShared, members: [{email, role, addedAt?, status: 'accepted'|'pending'}], shareUrl?}. members includes pending invitations, including to non-Proton addresses — check status. Call before drive_share_invite (avoid duplicates) and drive_share_revoke (confirm the email). Read-only.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote path of an existing file or folder, e.g. /my-files/project.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_list_trash",
    description:
      "List all files and folders in the Proton Drive trash. Returns {items, total, offset, limit, hasMore} (default limit 100, newest first, ties by uid); items are [{name, path, type, size?, storageSize?, modifiedAt?, uid, trashedAt?}]. Items come in a stable sorted order; each page is a fresh read, so changes between page calls can still shift items. Names are NOT unique in trash — uid and trashedAt tell duplicates apart. drive_restore/drive_delete accept the uid but refuse when the name is shared (the CLI cannot target one duplicate).",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_share_invite",
    description:
      "Invite a person to a Proton Drive file or folder by email. Immediately sends an email notification — confirm the address and role with the user first. Roles: 'viewer' (read-only), 'editor' (read + write), 'admin' (read + write + reshare). Run drive_share_status first: a duplicate invitation may silently overwrite the existing role.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to share (must start with '/').",
        },
        email: {
          type: "string",
          description: "Email address of the person to invite.",
        },
        role: {
          type: "string",
          enum: ["viewer", "editor", "admin"],
          description:
            "'viewer' = read-only, 'editor' = read + write, 'admin' = read + write + reshare.",
        },
        message: {
          type: "string",
          description: "Optional message included in the invitation email (max 500 characters — Proton rejects longer ones).",
        },
      },
      required: ["path", "email", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_share_revoke",
    description:
      "Remove one person's access (accepted or pending) to a Proton Drive file or folder; they are not notified. Fails if the address is not a current member or invitee (case-insensitive match). Confirm the email with drive_share_status first. To change a role, revoke and re-invite. To remove everyone use drive_share_remove_all.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote path of the shared item, as used when inviting.",
        },
        email: {
          type: "string",
          description: "Email of the member to remove, as shown by drive_share_status.",
        },
      },
      required: ["path", "email"],
      additionalProperties: false,
    },
  },
  // Trash
  {
    name: "drive_trash",
    description:
      "Move a file or folder to the Proton Drive trash. It leaves its path immediately but is recoverable via drive_restore. Prefer this over drive_delete unless the user explicitly wants permanent removal.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote path to trash.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_restore",
    description:
      "Restore a trashed file or folder to its original Proton Drive path. Find the path or uid with drive_list_trash. If several trashed items share the name, this refuses and lists their uids: the CLI can only address trashed items by name, so use the Proton Drive web or desktop app for that. Fails if the original parent is gone or a same-named item now exists at that path.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Trash path from drive_list_trash. Give path or uid (or both).",
        },
        uid: {
          type: "string",
          description: "Trash uid from drive_list_trash; if path is also given they must match.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "drive_empty_trash",
    description:
      "Permanently delete ALL items in the Proton Drive trash — irreversible. Requires confirmed=true. Call drive_list_trash first, show the user exactly what will go, and get explicit confirmation. For individual items use drive_delete.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        confirmed: {
          type: "boolean",
          description: "Must be true; the user has reviewed the trash and acknowledged this is permanent.",
        },
      },
      required: ["confirmed"],
      additionalProperties: false,
    },
  },
  // Copy
  {
    name: "drive_copy",
    description:
      "Copy a file or folder on Proton Drive; the original stays. destinationPath is the target PARENT folder (unlike drive_move, which takes a full new path). Pass newName to copy under a different name — required to duplicate an item inside its own folder.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: {
          type: "string",
          description: "Absolute remote path to copy.",
        },
        destinationPath: {
          type: "string",
          description: "Absolute remote target PARENT folder, e.g. /my-files/Archive.",
        },
      },
      required: ["sourcePath", "destinationPath"],
      additionalProperties: false,
    },
  },
  // Invitations
  {
    name: "drive_list_invitations",
    description:
      "List pending sharing invitations from other users: [{uid, role, invitedByEmail, invitedAt?, nodeName, nodeType}]. Use the uid with drive_invitation_accept / drive_invitation_reject.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_invitation_accept",
    description:
      "Accept a pending sharing invitation; the shared folder then appears in your Drive. Get the uid from drive_list_invitations — never guess it.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        uid: {
          type: "string",
          description: "Invitation uid from drive_list_invitations.",
        },
      },
      required: ["uid"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_invitation_reject",
    description:
      "Reject a pending sharing invitation permanently; the sender is not notified. Get the uid from drive_list_invitations — never guess it.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        uid: {
          type: "string",
          description: "Invitation uid from drive_list_invitations.",
        },
      },
      required: ["uid"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_share_leave",
    description:
      "Leave a Proton Drive folder shared with you; the owner and other members are unaffected. For your own folders use drive_share_revoke.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path of the shared folder to leave (must start with '/'). E.g. /shared-with-me/project",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_share_set_url",
    description:
      "Create or update a public share link: anyone with the link gets the given role, no Proton account needed. Calling again on the same path REPLACES the link's settings (same URL): omitting password/expiration removes them, and the result then carries a warning. Expiration is at most ~90 days out. Returns {url?, role?, expirationTime?, warning?}; fields may be absent. The password is passed as a CLI argument and is visible in the process list and shell history of the machine running this server. For private sharing use drive_share_invite.",
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to create a public link for (must start with '/').",
        },
        role: {
          type: "string",
          enum: ["viewer", "editor"],
          description: "Access level for anyone with the link. Defaults to 'viewer' if omitted.",
        },
        password: {
          type: "string",
          description: "Optional custom password required to access the link. Omit for no password.",
        },
        expiration: {
          type: "string",
          description: "Optional expiration date in ISO format, e.g. '2026-06-06'. Omit for no expiration.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_share_remove_url",
    description:
      "Remove the public share link from a file or folder; it stops working immediately. Member access is unaffected.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path whose public link should be removed (must start with '/').",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_share_remove_all",
    description:
      "Remove access for every member and pending invitation (Proton and non-Proton) on a shared path in one call. Requires confirmed=true; run drive_share_status first to show who loses access. Does NOT remove a public link (the result says if one is active; use drive_share_remove_url). For one person use drive_share_revoke.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to strip all sharing access from (must start with '/').",
        },
        confirmed: {
          type: "boolean",
          description: "Must be true. Confirms the user has acknowledged this removes everyone's access at once.",
        },
      },
      required: ["path", "confirmed"],
      additionalProperties: false,
    },
  },
  // Photos / Albums
  {
    name: "photos_list_albums",
    description:
      "List all Proton Photos albums: [{name, photoCount, isShared, creationTime?}]. Album paths are /albums/<name>.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "photos_create_album",
    description:
      "Create an empty Proton Photos album. Pass the name, not a path; it is created at /albums/<name>. Fails if the name exists.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the new album. E.g. 'Vacation 2024'. Must be non-empty.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "photos_update_album",
    description:
      "Rename an album or change its cover photo. At least one of name or coverPhotoUid is required; find a cover nodeUid with photos_list_album_photos.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        albumPath: {
          type: "string",
          description: "Album path, /albums/<name>.",
        },
        name: {
          type: "string",
          description: "New name for the album. Omit to leave unchanged.",
        },
        coverPhotoUid: {
          type: "string",
          description: "nodeUid (from photos_list_album_photos) of the photo to set as the album cover. Omit to leave unchanged.",
        },
      },
      required: ["albumPath"],
      additionalProperties: false,
    },
  },
  {
    name: "photos_delete_album",
    description:
      "Delete a Proton Photos album. Requires confirmed=true. Refuses an album that still contains photos unless force=true. Never deletes your own photos; they stay in the timeline. save maps to the CLI's undocumented --save option (no observable difference for your own photos) — leave it off unless asked. Show the user the album name and photo count first.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        albumPath: {
          type: "string",
          description: "Album path, /albums/<name>.",
        },
        confirmed: {
          type: "boolean",
          description: "Must be true. Confirms the user has acknowledged the deletion.",
        },
        force: {
          type: "boolean",
          description: "If true, delete even if the album still contains photos. Default false.",
        },
        save: {
          type: "boolean",
          description: "CLI --save option (undocumented, no observable effect). Default false.",
        },
      },
      required: ["albumPath", "confirmed"],
      additionalProperties: false,
    },
  },
  {
    name: "photos_list_album_photos",
    description:
      "List the photos in an album. Returns {items, total, offset, limit, hasMore} (default limit 100, newest capture first, ties by nodeUid; without loadDetails there is no captureTime, so the order is by nodeUid); items are [{nodeUid}], or with loadDetails=true also name, mediaType, sizes, captureTime and tags. Items come in a stable sorted order; each page is a fresh read, so changes between page calls can still shift items. To add or remove photos use their /photos/ path, not the nodeUid.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        albumPath: {
          type: "string",
          description: "Album path, /albums/<name>.",
        },
      },
      required: ["albumPath"],
      additionalProperties: false,
    },
  },
  {
    name: "photos_add_to_album",
    description:
      "Add a photo already in your library to an album (does not upload). Find album paths with photos_list_albums.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        albumPath: {
          type: "string",
          description: "Album path, /albums/<name>.",
        },
        photoPath: {
          type: "string",
          description: "Photo path, /photos/<name>.",
        },
      },
      required: ["albumPath", "photoPath"],
      additionalProperties: false,
    },
  },
  {
    name: "photos_remove_from_album",
    description:
      "Remove a photo from an album without deleting it from your library; it stays in the timeline.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        albumPath: {
          type: "string",
          description: "Album path, /albums/<name>.",
        },
        photoPath: {
          type: "string",
          description: "Photo path, /photos/<name>.",
        },
      },
      required: ["albumPath", "photoPath"],
      additionalProperties: false,
    },
  },
  {
    name: "photos_list_timeline",
    description:
      "List photos in your full Proton Photos timeline. Returns {items, total, offset, limit, hasMore} (default limit 50, newest first, ties by nodeUid; each page is a fresh read, so changes between pages can shift items); items are [{nodeUid, captureTime, tags}], or with loadDetails=true also {name, mediaType, creationTime, totalStorageSize} (about 50% more tokens). Download by path with photos_download.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        loadDetails: {
          type: "boolean",
          description: "If true, fetch full node metadata for each photo instead of just its nodeUid. Default false.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "photos_download",
    description:
      "Download photos from your timeline to a local folder by /photos/<name> path. /albums/<album>/<photo> paths are rejected by the CLI — use the /photos/ path. Timeline photos can share a filename: with conflictStrategy 'remove' or 'skip' only one copy survives locally; use 'rename' to keep all. Fails if any item fails.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        photoPaths: {
          type: "array",
          items: { type: "string" },
          description: "One or more absolute photo paths to download (each must start with '/'). E.g. ['/photos/IMG_001.jpg']",
        },
        localFolder: {
          type: "string",
          description: "Absolute local destination folder (must start with '/'). Created if it does not exist.",
        },
        conflictStrategy: {
          type: "string",
          enum: ["skip", "rename", "remove"],
          description:
            "'skip' keeps the existing local file (default). 'rename' downloads under a unique name. 'remove' deletes the local file first — confirm with user.",
        },
      },
      required: ["photoPaths", "localFolder"],
      additionalProperties: false,
    },
  },
  {
    name: "photos_upload",
    description:
      "Upload local photo or video files into your Proton Photos library. Non-photo/video files are skipped and counted in skippedItems (with duplicate skips). Folders are recursed but flattened — structure is not preserved. Never overwrites: duplicates (name + content hash) resolve to 'rename' or 'skip' only.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        localPaths: {
          type: "array",
          items: { type: "string" },
          description: "One or more absolute local paths to files or folders to upload (each must start with '/').",
        },
        conflictStrategy: {
          type: "string",
          enum: ["skip", "rename"],
          description: "How to handle duplicate photos (matched by name + content hash). 'skip' leaves the existing photo unchanged (default); 'rename' uploads under a unique name.",
        },
      },
      required: ["localPaths"],
      additionalProperties: false,
    },
  },
  // Sync-folder tools (requires PROTON_DRIVE_SYNC_PATH env var)
  {
    name: "drive_read_file",
    description:
      "Read a UTF-8 text file (max 1 MB) from the local Proton Drive sync folder. Requires PROTON_DRIVE_SYNC_PATH pointing at the sync root, the desktop app running and the file synced. Binary, non-UTF-8 or larger files error — use drive_download.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path of the file to read (must start with '/'). /my-files/<rest> maps to <PROTON_DRIVE_SYNC_PATH>/<rest>; only /my-files is synced, other Drive roots are rejected. A path not starting with a Drive root is taken relative to the sync folder. E.g. /my-files/notes.txt",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_write_file",
    description:
      "Write text (max 5 MB) to a file in the local Proton Drive sync folder; no Proton login needed. Requires PROTON_DRIVE_SYNC_PATH; the desktop app must be running to sync it to the cloud. Creates parent directories locally. Refuses to overwrite an existing file unless confirmed=true — ask the user first. For binary content use drive_upload.",
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path of the file to write (must start with '/'). /my-files/<rest> maps to <PROTON_DRIVE_SYNC_PATH>/<rest>; only /my-files is synced, other Drive roots are rejected. A path not starting with a Drive root is taken relative to the sync folder. E.g. /my-files/notes.txt",
        },
        content: {
          type: "string",
          description: "UTF-8 text content to write. The file will be created or overwritten.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_sync_plan",
    description:
      "Read-only plan, transfers nothing: diff a local folder against a Drive folder (only local, only Drive, changed; same size but mtime >2 s apart = 'maybe changed'), with byte totals and completeness. Symlinks skipped.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        localPath: { type: "string", description: "Absolute local folder." },
        drivePath: { type: "string", description: "Absolute remote folder." },
        direction: { type: "string", enum: ["up", "down", "both"], description: "Default up." },
        ignore: { type: "array", items: { type: "string" }, description: "Globs (default .git, node_modules, .DS_Store)." },
        compare: { type: "string", enum: ["size-mtime", "sha1"], description: "Default size-mtime; sha1 hashes same-size files when Drive claims one." },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Per list, default 200." },
      },
      required: ["localPath", "drivePath"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_bulk_move",
    description:
      "Move up to 200 items into one existing folder, keeping names. Without confirmed: plan and problems only. With confirmed=true: moves only if no problems.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        sources: { type: "array", items: { type: "string" }, description: "Absolute remote paths." },
        destinationFolder: { type: "string", description: "Existing folder (not a full new path)." },
      },
      required: ["sources", "destinationFolder"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_bulk_trash",
    description:
      "Trash up to 200 items (drive_restore recovers). Without confirmed: plan and problems only. With confirmed=true: trashes only if no problems.",
    annotations: { destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Absolute remote paths." },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  // Analytics (read-only; walk the tree once, cached)
  {
    name: "drive_usage",
    description:
      "Storage analytics for a subtree: totals, largest files/folders, extension and media-type breakdown, old files, trash stats (always uncached, ~2.5 s). Sizes are summed file sizes, not the account quota. Walks the tree; results come from a cache up to 5 min old (other clients' changes unseen until expiry or refresh=true); a first walk of a large drive can take minutes. `complete` flags partial results.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder (default /my-files)." },
        top: { type: "integer", minimum: 1, maximum: 50, description: "Rows per ranking (default 10)." },
        olderThanDays: { type: "integer", minimum: 0, description: "Report files older than this many days." },
        refresh: { type: "boolean", description: "Ignore the cached walk." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "drive_find_duplicates",
    description:
      "Find likely duplicates: same claimed sha1, or same size+mediaType without sha1 (candidates only). verify=true downloads and sha256s them ('verified'; writes temporary local files, removed afterwards). Reports wastedBytes and a suggested keeper; never deletes. Walk results are cached up to 5 min (refresh=true re-reads; first walk of a large drive can take minutes).",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder (default /my-files)." },
        minSize: { type: "integer", minimum: 0, description: "Min bytes (default 1024)." },
        verify: { type: "boolean", description: "Download and hash candidates of the top groups." },
        maxVerifyBytes: { type: "integer", minimum: 1, description: "Skip files larger than this (default 50000000)." },
        maxVerifyTotalBytes: { type: "integer", minimum: 1, maximum: 2000000000, description: "Total download budget for verify (default 500000000)." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Max groups returned (default 20)." },
        refresh: { type: "boolean", description: "Ignore the cached walk." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "drive_sharing_audit",
    description:
      "Audit sharing under a path: public links (role, expiry, password; URL omitted), invitees, pending invitations, risk flags (public-link-no-expiry, public-link-editor, external-invitee = non-Proton address). Max 100 shared items.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder (default /my-files)." },
        refresh: { type: "boolean", description: "Ignore the cached walk." },
      },
      required: [],
      additionalProperties: false,
    },
  },
] as const;

// ---- Tool surface: derived from TOOLS so the literal stays readable ----------
const CONFIRM_ALWAYS = new Set([
  "drive_auth_logout", "drive_share_invite", "drive_share_revoke", "drive_share_set_url",
  "drive_share_remove_url", "drive_share_leave", "drive_invitation_reject", "photos_remove_from_album",
  "drive_bulk_move", "drive_bulk_trash",
]);
const CONFIRM_CONDITIONAL: Record<string, string> = {
  drive_upload: "when fileConflictStrategy or folderConflictStrategy is 'replace' (it trashes the existing remote item)",
  drive_download: "when fileConflictStrategy or folderConflictStrategy is 'remove' (it deletes the existing LOCAL file or folder)",
  photos_download: "when conflictStrategy is 'remove' (it deletes the existing LOCAL file)",
  drive_write_file: "when the file already exists (it would be overwritten)",
};
const PAGE_DEFAULTS: Record<string, number> = { drive_list: 200, drive_list_trash: 100, photos_list_timeline: 50, photos_list_album_photos: 100 };
const EXTRA_PROPS: Record<string, Record<string, JsonSchemaProp & { description: string }>> = {
  drive_info: { verbose: { type: "boolean", description: "Return the raw CLI node instead of the trimmed one (default false)." } },
  drive_copy: { newName: { type: "string", description: "Optional name for the copy (CLI --name). Required to copy an item into its own folder." } },
  photos_list_album_photos: { loadDetails: { type: "boolean", description: "Include name, mediaType, sizes, captureTime and tags (default false)." } },
};
// Replace/remove strategies are gated by `confirmed`, so the tools themselves are
// not advertised as destructive; trash is reversible via drive_restore.
const ANNOTATION_OVERRIDES: Record<string, Record<string, boolean>> = {
  drive_share_set_url: { destructiveHint: true, openWorldHint: true },
  drive_share_invite: { destructiveHint: false, openWorldHint: true },
  drive_upload: { destructiveHint: false },
  drive_download: { destructiveHint: false },
  photos_download: { destructiveHint: false },
  photos_upload: { destructiveHint: false },
  drive_trash: { destructiveHint: false, idempotentHint: true },
  drive_version: { openWorldHint: false },
  drive_read_file: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};
const TOOL_TITLES: Record<string, string> = {
  drive_tree: "Show folder tree", drive_search: "Search files", drive_usage: "Storage usage report",
  drive_find_duplicates: "Find duplicate files", drive_sharing_audit: "Audit sharing",
  drive_sync_plan: "Plan local/Drive sync", drive_bulk_move: "Move many items", drive_bulk_trash: "Trash many items",
  drive_auth_status: "Check sign-in status", drive_auth_logout: "Sign out", drive_version: "CLI version",
  drive_list: "List folder", drive_info: "Get item info", drive_upload: "Upload to Drive", drive_download: "Download from Drive",
  drive_mkdir: "Create folder", drive_rename: "Rename item", drive_move: "Move item", drive_delete: "Delete permanently",
  drive_share_status: "Show sharing status", drive_list_trash: "List trash", drive_share_invite: "Invite to share",
  drive_share_revoke: "Revoke member access", drive_trash: "Move to trash", drive_restore: "Restore from trash",
  drive_empty_trash: "Empty trash", drive_copy: "Copy item", drive_list_invitations: "List invitations",
  drive_invitation_accept: "Accept invitation", drive_invitation_reject: "Reject invitation", drive_share_leave: "Leave shared item",
  drive_share_set_url: "Create or update public link", drive_share_remove_url: "Remove public link",
  drive_share_remove_all: "Remove all sharing", photos_list_albums: "List photo albums", photos_create_album: "Create photo album",
  photos_update_album: "Update photo album", photos_delete_album: "Delete photo album", photos_list_album_photos: "List album photos",
  photos_add_to_album: "Add photos to album", photos_remove_from_album: "Remove photo from album", photos_list_timeline: "List photo timeline",
  photos_download: "Download photo", photos_upload: "Upload photos", drive_read_file: "Read synced text file", drive_write_file: "Write synced text file",
};
// Hint for clients that cap tool-result size: these tools can legitimately return large payloads.
const LARGE_RESULT_TOOLS = new Set(["drive_list", "drive_read_file"]);

const TOOL_DEFS: ToolDef[] = TOOLS.map((t) => {
  const base = t as unknown as ToolDef;
  const properties: Record<string, JsonSchemaProp & { description?: string }> = { ...base.inputSchema.properties, ...(EXTRA_PROPS[base.name] ?? {}) };
  let description = base.description;
  if (base.name in PAGE_DEFAULTS) {
    properties.limit = { type: "integer", minimum: 1, maximum: 1000, description: `Max items to return (default ${PAGE_DEFAULTS[base.name]}).` };
    properties.offset = { type: "integer", minimum: 0, description: "Number of items to skip (default 0)." };
  }
  const confirmedProp = { type: "boolean", description: "Must be true; only after the user approved this exact action." };
  if (CONFIRM_ALWAYS.has(base.name)) {
    properties.confirmed = confirmedProp;
    description += " Requires confirmed=true after explicit user approval.";
  } else if (CONFIRM_CONDITIONAL[base.name]) {
    properties.confirmed = confirmedProp;
    description += ` Requires confirmed=true ${CONFIRM_CONDITIONAL[base.name]}.`;
  }
  return {
    ...base,
    ...(TOOL_TITLES[base.name] ? { title: TOOL_TITLES[base.name] } : {}),
    description,
    inputSchema: { ...base.inputSchema, properties },
    annotations: { ...(base.annotations ?? {}), ...(ANNOTATION_OVERRIDES[base.name] ?? {}) },
  };
});

// Core tier (PROTON_DRIVE_TOOL_TIER=core): everyday tools only, to cut the tools/list
// payload every session pays for. Excluded on purpose: permanent deletion
// (drive_delete, drive_empty_trash), auth_logout, public links, invitations/invites,
// album management and the sync-file tools. Those stay full-tier only.
export const CORE_TOOL_NAMES = new Set([
  "drive_auth_status", "drive_version", // session check and CLI diagnostics
  "drive_list", "drive_info", "drive_list_trash", // reading
  "drive_search", "drive_tree", // finding things without listing folder by folder
  "drive_mkdir", "drive_upload", "drive_download", // basic file I/O
  "drive_rename", "drive_move", "drive_copy", // reorganising
  "drive_trash", "drive_restore", // reversible removal
  "drive_share_status", // read-only sharing check
  "photos_list_timeline", "photos_download", // browse and fetch photos (read-only locally)
]);

export function resolveTier(raw: string | undefined): "full" | "core" {
  const v = (raw ?? "full").trim().toLowerCase();
  if (v === "full" || v === "core") return v;
  logger.warn(`Unknown PROTON_DRIVE_TOOL_TIER "${raw}" — using "full" (valid: full, core).`);
  return "full";
}

// Text shown to the human: control characters and newlines are neutralised and the MIDDLE of a
// long value is elided, so two long names sharing a prefix (or a spoofed line break) stay distinguishable.
export function showValue(v: unknown, head = 120, tail = 60): string {
  const t = (typeof v === "string" ? v : JSON.stringify(v) ?? String(v)).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, " ");
  return t.length > head + tail + 1 ? `${t.slice(0, head)}…${t.slice(-tail)}` : t;
}

export function describeArgs(args: Record<string, unknown>): string {
  return Object.entries(args).filter(([k]) => k !== "confirmed").map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: ${v.slice(0, 5).map((x) => showValue(x)).join(" | ")}${v.length > 5 ? ` (+${v.length - 5} more)` : ""}`;
    return `${k}: ${showValue(v)}`;
  }).join("\n");
}

function bulkPrompt(tool: string, verb: string, paths: string[], destination?: string): string {
  return `${tool} needs your approval. ${verb} ${paths.length} item(s)${destination ? ` into ${showValue(destination)}` : ""}.\n` +
    paths.slice(0, 5).map((p) => `- ${showValue(p)}`).join("\n") + (paths.length > 5 ? `\n(+${paths.length - 5} more)` : "");
}

async function elicitApproval(server: Server, message: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await server.elicitInput(
      {
        message,
        requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve this action", default: false } }, required: ["approve"] },
      },
      { timeout: 120_000, signal },
    );
    return res.action === "accept" && res.content?.approve === true;
  } catch {
    return false;
  }
}

export async function main() {
  const drive = new DriveService();
  const tier = resolveTier(process.env.PROTON_DRIVE_TOOL_TIER); // read once at startup
  const activeDefs = tier === "core" ? TOOL_DEFS.filter((t) => CORE_TOOL_NAMES.has(t.name)) : TOOL_DEFS;

  // A looping model must not be able to spam the human: after this many declined/cancelled
  // prompts within a minute, refuse without prompting until the window clears.
  const declinedAt: number[] = [];
  const MAX_DECLINED_PER_MINUTE = 5;
  const canElicit = () => !!server.getClientCapabilities()?.elicitation?.form;
  // Returns true only when the human approved. Never prompts when the client cannot, or when over budget.
  const askApproval = async (message: string): Promise<boolean> => {
    const now = Date.now();
    while (declinedAt.length && now - declinedAt[0] > 60_000) declinedAt.shift();
    if (declinedAt.length >= MAX_DECLINED_PER_MINUTE) return false;
    const approved = await elicitApproval(server, message, callContext.getStore()?.signal);
    if (!approved) declinedAt.push(now);
    return approved;
  };

  const server = new Server(
    { name: "proton-drive-mcp", version: VERSION },
    { capabilities: { tools: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeDefs.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
      ...(t.title ? { title: t.title } : {}),
      ...(LARGE_RESULT_TOOLS.has(t.name) ? { _meta: { "anthropic/maxResultSizeChars": 100000 } } : {}),
    })),
  }));

  // A prompt is offered only when every tool it tells the model to call is in the active tier.
  const activeToolNames = new Set(activeDefs.map((t) => t.name));
  const activePrompts = PROMPTS.filter((p) => p.requires.every((r) => activeToolNames.has(r)));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: activePrompts.map(({ requires: _requires, ...p }) => ({ ...p, arguments: [...p.arguments] })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    let text: string | undefined;
    try {
      text = activePrompts.some((p) => p.name === name) ? getPromptText(name, args) : undefined;
    } catch (err) {
      throw new McpError(ErrorCode.InvalidParams, err instanceof Error ? err.message : String(err));
    }
    if (text === undefined) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    const def = PROMPTS.find((p) => p.name === name);
    return { description: def?.description, messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
  });

  const handleCall = async (req: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<ToolResult> => {
    const { name, arguments: args = {} } = req.params;
    const a = args as Record<string, unknown>;

    const def = TOOL_DEFS.find((t) => t.name === name);
    // A client may remember a name from a fuller tools/list; refuse before any CLI call.
    if (def && !activeDefs.includes(def)) {
      return fail(`Tool ${name} is not available in the "${tier}" tool tier. Set PROTON_DRIVE_TOOL_TIER=full and restart the server to use it.`);
    }
    if (def) {
      const problem = checkArgs(def, a);
      if (problem) return fail(problem);
    }

    try {
      switch (name) {
        case "drive_auth_status":
          return ok(await drive.authStatus());

        case "drive_auth_logout": {
          needConfirm(a, "drive_auth_logout", "ends the stored Proton Drive session for every client on this machine.");
          await drive.authLogout();
          return ok({ message: "Logged out successfully." });
        }

        case "drive_version":
          return ok(await drive.version());

        case "drive_list": {
          const listPath = validateRemotePath(a.path);
          const listType = a.type === "file" || a.type === "folder" ? a.type : undefined;
          return ok({ path: listPath, ...paginate(await drive.list(listPath, { type: listType }), a, PAGE_DEFAULTS.drive_list) });
        }

        case "drive_info":
          return ok(await drive.info(validateRemotePath(a.path), a.verbose === true));

        case "drive_tree":
          return ok(await driveTree(drive, a));

        case "drive_search":
          return ok(await driveSearch(drive, a));

        case "drive_mkdir": {
          const mkdirPath = validateRemotePath(a.path);
          await drive.mkdir(mkdirPath);
          return ok({ message: `Folder created: ${mkdirPath}` });
        }

        case "drive_upload": {
          const fcs = typeof a.fileConflictStrategy === "string" ? a.fileConflictStrategy : "skip";
          if (!["skip", "create-new-revision", "rename", "replace"].includes(fcs)) {
            return fail(`fileConflictStrategy must be skip, create-new-revision, rename, or replace`);
          }
          const dcs2 = typeof a.folderConflictStrategy === "string" ? a.folderConflictStrategy : "skip";
          if (!["skip", "merge", "rename", "replace"].includes(dcs2)) {
            return fail(`folderConflictStrategy must be skip, merge, rename, or replace`);
          }
          if ((fcs === "replace" || dcs2 === "replace") && a.confirmed !== true) {
            throw new NeedsConfirmationError("drive_upload with strategy 'replace' trashes the existing remote item. Describe this to the user, get their explicit OK, then call again with confirmed=true.");
          }
          const uploadResult = await drive.upload(
            validateLocalPath(a.localPath),
            validateRemotePath(a.remotePath),
            fcs as FileConflictStrategy,
            dcs2 as FolderConflictStrategy
          );
          if (uploadResult.failed > 0) {
            return fail(`Upload completed with ${uploadResult.failed} failed file(s). uploaded=${uploadResult.uploaded} skipped=${uploadResult.skipped}`);
          }
          return ok(uploadResult);
        }

        case "drive_download": {
          const fdcs = typeof a.fileConflictStrategy === "string" ? a.fileConflictStrategy : "skip";
          if (!["skip", "rename", "remove"].includes(fdcs)) {
            return fail(`fileConflictStrategy must be skip, rename, or remove`);
          }
          const fodcs = typeof a.folderConflictStrategy === "string" ? a.folderConflictStrategy : "skip";
          if (!["skip", "merge", "rename", "remove"].includes(fodcs)) {
            return fail(`folderConflictStrategy must be skip, merge, rename, or remove`);
          }
          if ((fdcs === "remove" || fodcs === "remove") && a.confirmed !== true) {
            throw new NeedsConfirmationError("drive_download with strategy 'remove' deletes the existing LOCAL file or folder before downloading. Describe this to the user, get their explicit OK, then call again with confirmed=true.");
          }
          const downloadResult = await drive.download(
            validateRemotePath(a.remotePath),
            validateLocalPath(a.localPath),
            fdcs as FileDownloadConflictStrategy,
            fodcs as FolderDownloadConflictStrategy
          );
          if (downloadResult.failed > 0) {
            return fail(`Download completed with ${downloadResult.failed} failed file(s). downloaded=${downloadResult.downloaded} skipped=${downloadResult.skipped}`);
          }
          return ok(downloadResult);
        }

        case "drive_rename": {
          const renamePath = validateRemotePath(a.path);
          const newName = validateName(a.newName);
          await drive.rename(renamePath, newName);
          return ok({ message: `Renamed: ${renamePath} → ${newName}` });
        }

        case "drive_move": {
          const moveSrc = validateRemotePath(a.sourcePath);
          const moveDst = validateRemotePath(a.destinationPath);
          await drive.move(moveSrc, moveDst);
          return ok({ message: `Moved: ${moveSrc} → ${moveDst}` });
        }

        case "drive_delete": {
          if (a.confirmed !== true) {
            throw new NeedsConfirmationError("drive_delete requires confirmed=true. Ask the user to confirm before deleting.");
          }
          const deletePath = a.path === undefined ? undefined : validateRemotePath(a.path);
          const deleteUid = a.uid ? validateFlagValue(a.uid as string, "uid") : undefined;
          await drive.delete(deletePath, deleteUid);
          return ok({ message: `Deleted: ${deletePath ?? `uid ${deleteUid}`}` });
        }

        case "drive_usage":
          return ok(await driveUsage(drive, {
            path: a.path === undefined ? "/my-files" : validateRemotePath(a.path),
            top: a.top as number | undefined,
            olderThanDays: a.olderThanDays as number | undefined,
            refresh: a.refresh === true,
          }));

        case "drive_find_duplicates":
          return ok(await driveFindDuplicates(drive, {
            path: a.path === undefined ? "/my-files" : validateRemotePath(a.path),
            minSize: a.minSize as number | undefined,
            verify: a.verify === true,
            maxVerifyBytes: a.maxVerifyBytes as number | undefined,
            maxVerifyTotalBytes: a.maxVerifyTotalBytes as number | undefined,
            limit: a.limit as number | undefined,
            refresh: a.refresh === true,
          }));

        case "drive_sharing_audit":
          return ok(await driveSharingAudit(drive, {
            path: a.path === undefined ? "/my-files" : validateRemotePath(a.path),
            refresh: a.refresh === true,
          }));

        case "drive_list_trash": {
          const trashed = await drive.listTrash();
          trashed.sort(byTimeDescThenId((f) => f.trashedAt, (f) => f.uid));
          return ok(paginate(trashed, a, PAGE_DEFAULTS.drive_list_trash));
        }

        case "drive_share_status":
          return ok(await drive.shareStatus(validateRemotePath(a.path)));

        case "drive_share_invite": {
          needConfirm(a, "drive_share_invite", "immediately emails the invitee and grants them access.");
          const email = validateEmail(a.email);
          if (typeof a.role !== "string") {
            return fail("role must be a string: viewer, editor, or admin");
          }
          const role = a.role;
          if (!["viewer", "editor", "admin"].includes(role)) {
            return fail("role must be viewer, editor, or admin");
          }
          const inviteMsg = typeof a.message === "string" ? validateMessage(a.message) : undefined;
          await drive.shareInvite(
            validateRemotePath(a.path),
            email,
            role as "viewer" | "editor" | "admin",
            inviteMsg
          );
          return ok({ message: `Invited ${email} as ${role}.` });
        }

        case "drive_share_revoke":
        {
          needConfirm(a, "drive_share_revoke", "removes a person's access.");
          const revokeEmail = validateEmail(a.email);
          await drive.shareRevoke(validateRemotePath(a.path), revokeEmail);
          return ok({ message: `Revoked access for ${revokeEmail}.` });
        }

        case "drive_trash": {
          const trashPath = validateRemotePath(a.path);
          await drive.trash(trashPath);
          return ok({ message: `Moved to trash: ${trashPath}` });
        }

        case "drive_sync_plan": {
          const direction = a.direction === undefined ? undefined : String(a.direction);
          if (direction !== undefined && !["up", "down", "both"].includes(direction)) return fail("direction must be up, down or both");
          const compare = a.compare === undefined ? undefined : String(a.compare);
          if (compare !== undefined && !["size-mtime", "sha1"].includes(compare)) return fail("compare must be size-mtime or sha1");
          if (a.ignore !== undefined && (!Array.isArray(a.ignore) || a.ignore.some((g) => typeof g !== "string"))) return fail("ignore must be an array of strings");
          return ok(await syncPlan(drive, {
            localPath: a.localPath as string, drivePath: a.drivePath as string,
            direction: direction as Direction | undefined, compare: compare as Compare | undefined,
            ignore: a.ignore as string[] | undefined, limit: typeof a.limit === "number" ? a.limit : undefined,
          }));
        }

        case "drive_bulk_move": {
          const sources = validateRemotePathList(a.sources, "sources");
          const destFolder = validateRemotePath(a.destinationFolder);
          const movePlan = planBulkMove(sources, destFolder, await loadListing(drive, foldersToList(sources, destFolder)));
          if (a.confirmed !== true) {
            return ok({ applied: false, ...movePlan, next: movePlan.problems.length ? "Fix problems first." : "Get user approval, then confirmed=true." });
          }
          if (movePlan.problems.length) return fail(`drive_bulk_move not applied, nothing moved: ${JSON.stringify(movePlan.problems)}`);
          if (canElicit() && !(await askApproval(bulkPrompt("drive_bulk_move", "Move", sources, destFolder)))) {
            return fail("drive_bulk_move not applied, nothing moved: the user did not approve.");
          }
          try { await drive.bulkMove(sources, destFolder); } finally { invalidatePath(destFolder); sources.forEach(invalidatePath); }
          return ok({ applied: true, moved: movePlan.plan.length, plan: movePlan.plan });
        }

        case "drive_bulk_trash": {
          const trashPaths = validateRemotePathList(a.paths, "paths");
          const trashPlan = planBulkTrash(trashPaths, await loadListing(drive, foldersToList(trashPaths)));
          if (a.confirmed !== true) {
            return ok({ applied: false, ...trashPlan, next: trashPlan.problems.length ? "Fix problems first." : "Get user approval, then confirmed=true." });
          }
          if (trashPlan.problems.length) return fail(`drive_bulk_trash not applied, nothing trashed: ${JSON.stringify(trashPlan.problems)}`);
          if (canElicit() && !(await askApproval(bulkPrompt("drive_bulk_trash", "Trash", trashPaths)))) {
            return fail("drive_bulk_trash not applied, nothing trashed: the user did not approve.");
          }
          try { await drive.bulkTrash(trashPaths); } finally { trashPaths.forEach(invalidatePath); }
          return ok({ applied: true, trashed: trashPlan.plan.length, plan: trashPlan.plan });
        }

        case "drive_restore": {
          const restorePath = a.path === undefined ? undefined : validateRemotePath(a.path);
          const restoreUid = a.uid ? validateFlagValue(a.uid as string, "uid") : undefined;
          await drive.restore(restorePath, restoreUid);
          return ok({ message: `Restored from trash: ${restorePath ?? `uid ${restoreUid}`}` });
        }

        case "drive_empty_trash":
          if (a.confirmed !== true) {
            throw new NeedsConfirmationError(
              "drive_empty_trash requires confirmed=true. " +
              "Use drive_list_trash first to show the user what will be deleted, then ask for confirmation."
            );
          }
          await drive.emptyTrash();
          return ok({ message: "Trash emptied." });

        case "drive_copy": {
          const copySrc = validateRemotePath(a.sourcePath);
          const copyDst = validateRemotePath(a.destinationPath);
          const copyName = typeof a.newName === "string" ? validateName(a.newName) : undefined;
          await drive.copy(copySrc, copyDst, copyName);
          return ok({ message: `Copied: ${copySrc} → ${copyDst}${copyName ? ` as '${copyName}'` : ""}` });
        }

        case "drive_list_invitations":
          return ok(await drive.listInvitations());

        case "drive_invitation_accept": {
          if (typeof a.uid !== "string" || !a.uid) return fail("uid must be a non-empty string");
          const acceptUid = validateFlagValue(a.uid, "uid");
          await drive.invitationAccept(acceptUid);
          return ok({ message: "Invitation accepted." });
        }

        case "drive_invitation_reject": {
          if (typeof a.uid !== "string" || !a.uid) return fail("uid must be a non-empty string");
          needConfirm(a, "drive_invitation_reject", "declines the invitation permanently.");
          const rejectUid = validateFlagValue(a.uid, "uid");
          await drive.invitationReject(rejectUid);
          return ok({ message: "Invitation rejected." });
        }

        case "drive_share_leave": {
          needConfirm(a, "drive_share_leave", "removes your own access to a shared folder.");
          const leavePath = validateRemotePath(a.path);
          await drive.shareLeave(leavePath);
          return ok({ message: `Left shared folder: ${leavePath}` });
        }

        case "drive_share_set_url": {
          needConfirm(a, "drive_share_set_url", "creates or replaces a PUBLIC link that anyone with the URL can open.");
          const setUrlPath = validateRemotePath(a.path);
          const role = typeof a.role === "string" ? a.role : "viewer";
          if (!["viewer", "editor"].includes(role)) return fail("role must be viewer or editor");
          const password = typeof a.password === "string" && a.password ? validateFlagValue(a.password, "password") : undefined;
          const expiration = typeof a.expiration === "string" && a.expiration ? validateFlagValue(a.expiration, "expiration") : undefined;
          const link = await drive.shareSetUrl(setUrlPath, role as "viewer" | "editor", password, expiration);
          return ok(link);
        }

        case "drive_share_remove_url": {
          needConfirm(a, "drive_share_remove_url", "disables the public link.");
          const removeUrlPath = validateRemotePath(a.path);
          await drive.shareRemoveUrl(removeUrlPath);
          return ok({ message: `Public link removed: ${removeUrlPath}` });
        }

        case "drive_share_remove_all": {
          if (a.confirmed !== true) {
            throw new NeedsConfirmationError("drive_share_remove_all requires confirmed=true. Use drive_share_status first to show the user who has access.");
          }
          const removeAllPath = validateRemotePath(a.path);
          const removeAll = await drive.shareRemoveAll(removeAllPath);
          const linkNote = removeAll.publicLink ? " A public link is still active — anyone with it keeps access; remove it with drive_share_remove_url." : "";
          return ok({ message: (removeAll.removed === 0 ? `Nothing to remove: ${removeAllPath} has no members or pending invitations.` : `Removed all members and invitations (${removeAll.removed}) from: ${removeAllPath}.`) + linkNote });
        }

        case "photos_list_albums":
          return ok(await drive.listAlbums());

        case "photos_create_album": {
          if (typeof a.name !== "string" || !a.name.trim()) return fail("name must be a non-empty string");
          const albumName = validateName(a.name);
          await drive.createAlbum(albumName);
          return ok({ message: `Album created: ${albumName}` });
        }

        case "photos_update_album": {
          const updateAlbumPath = validateRemotePath(a.albumPath);
          if (!updateAlbumPath.startsWith("/albums/")) return fail("albumPath must start with /albums/");
          const newName = typeof a.name === "string" && a.name.trim() ? validateName(a.name) : undefined;
          const coverPhotoUid = typeof a.coverPhotoUid === "string" && a.coverPhotoUid.trim() ? validateName(a.coverPhotoUid) : undefined;
          if (!newName && !coverPhotoUid) return fail("At least one of name or coverPhotoUid must be provided");
          await drive.updateAlbum(updateAlbumPath, newName, coverPhotoUid);
          return ok({ message: `Album updated: ${newName ? `/albums/${newName}` : updateAlbumPath}` });
        }

        case "photos_delete_album": {
          if (a.confirmed !== true) throw new NeedsConfirmationError("photos_delete_album requires confirmed=true. Show the user the album name and photo count first.");
          const albumDelPath = validateRemotePath(a.albumPath);
          if (!albumDelPath.startsWith("/albums/")) return fail("albumPath must start with /albums/");
          await drive.deleteAlbum(albumDelPath, a.force === true, a.save === true);
          return ok({ message: `Album deleted: ${albumDelPath}` });
        }

        case "photos_list_album_photos": {
          const albumListPath = validateRemotePath(a.albumPath);
          if (!albumListPath.startsWith("/albums/")) return fail("albumPath must start with /albums/");
          return ok(paginate((await drive.listAlbumPhotos(albumListPath, a.loadDetails === true)).sort(photoOrder), a, PAGE_DEFAULTS.photos_list_album_photos));
        }

        case "photos_add_to_album": {
          const addAlbumPath = validateRemotePath(a.albumPath);
          const addPhotoPath = validateRemotePath(a.photoPath);
          if (!addAlbumPath.startsWith("/albums/")) return fail("albumPath must start with /albums/");
          if (!addPhotoPath.startsWith("/photos/")) return fail("photoPath must start with /photos/");
          await drive.addPhotoToAlbum(addAlbumPath, addPhotoPath);
          return ok({ message: `Added ${addPhotoPath} to ${addAlbumPath}` });
        }

        case "photos_remove_from_album": {
          needConfirm(a, "photos_remove_from_album", "removes a photo from the album.");
          const remAlbumPath = validateRemotePath(a.albumPath);
          const remPhotoPath = validateRemotePath(a.photoPath);
          if (!remAlbumPath.startsWith("/albums/")) return fail("albumPath must start with /albums/");
          if (!remPhotoPath.startsWith("/photos/")) return fail("photoPath must start with /photos/");
          await drive.removePhotoFromAlbum(remAlbumPath, remPhotoPath);
          return ok({ message: `Removed ${remPhotoPath} from ${remAlbumPath}` });
        }

        case "photos_list_timeline":
          return ok(paginate((await drive.photoTimeline(a.loadDetails === true)).sort(photoOrder), a, PAGE_DEFAULTS.photos_list_timeline));

        case "photos_download": {
          if (!Array.isArray(a.photoPaths) || a.photoPaths.length === 0) return fail("photoPaths must be a non-empty array of strings");
          const downloadPaths = a.photoPaths.map((p) => validateRemotePath(p));
          const downloadFolder = validateLocalPath(a.localFolder);
          const pdcs = typeof a.conflictStrategy === "string" ? a.conflictStrategy : "skip";
          if (!["skip", "rename", "remove"].includes(pdcs)) return fail("conflictStrategy must be skip, rename, or remove");
          if (pdcs === "remove" && a.confirmed !== true) {
            throw new NeedsConfirmationError("photos_download with conflictStrategy 'remove' deletes the existing LOCAL file before downloading. Describe this to the user, get their explicit OK, then call again with confirmed=true.");
          }
          const downloadSummary = await drive.photoDownload(downloadPaths, downloadFolder, pdcs as PhotoDownloadConflictStrategy);
          if (downloadSummary.failedItems > 0) {
            return fail(`Download completed with ${downloadSummary.failedItems} failed item(s). transferred=${downloadSummary.transferredItems}`);
          }
          return ok(downloadSummary);
        }

        case "photos_upload": {
          if (!Array.isArray(a.localPaths) || a.localPaths.length === 0) return fail("localPaths must be a non-empty array of strings");
          const uploadPaths = a.localPaths.map((p) => validateLocalPath(p));
          const pucs = typeof a.conflictStrategy === "string" ? a.conflictStrategy : "skip";
          if (!["skip", "rename"].includes(pucs)) return fail("conflictStrategy must be skip or rename");
          const uploadSummary = await drive.photoUpload(uploadPaths, pucs as PhotoUploadConflictStrategy);
          if (uploadSummary.failedItems > 0) {
            return fail(`Upload completed with ${uploadSummary.failedItems} failed item(s). transferred=${uploadSummary.transferredItems}`);
          }
          return ok(uploadSummary);
        }

        case "drive_read_file": {
          const syncRoot = getSyncRoot();
          if (!syncRoot) return fail("PROTON_DRIVE_SYNC_PATH is not set. Set it to the root of your Proton Drive sync folder.");
          const readPath = validateRemotePath(a.path);
          const content = await readSyncFile(syncRoot, readPath);
          return ok({ path: readPath, content });
        }

        case "drive_write_file": {
          const syncRoot = getSyncRoot();
          if (!syncRoot) return fail("PROTON_DRIVE_SYNC_PATH is not set. Set it to the root of your Proton Drive sync folder.");
          if (typeof a.content !== "string") return fail("content must be a string");
          const writePath = validateRemotePath(a.path);
          if (a.confirmed !== true && (await syncFileExists(syncRoot, writePath))) {
            throw new NeedsConfirmationError(`drive_write_file would overwrite the existing file ${writePath}. Ask the user to confirm, then call again with confirmed=true.`);
          }
          await writeSyncFile(syncRoot, writePath, a.content);
          return ok({ message: `Written: ${writePath}` });
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      return handleError(err);
    }
  };

  let inFlight = 0;
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    inFlight++;
    try {
      // The request's AbortSignal reaches the CLI child via AsyncLocalStorage, so
      // notifications/cancelled actually kills a running upload/download.
      return await callContext.run({ signal: extra?.signal }, async () => {
        const first = await handleCall(req);
        // A gate refused with NeedsConfirmationError. If the client can ask the human directly,
        // let the human (never the model) grant it; any failure keeps the refusal.
        if (!confirmationRefusals.has(first) || !canElicit()) return first;
        const reason = (first.content?.[0]?.text ?? "").replace(/\s*(Describe this to the user|Ask the user|Show the user|Use \w+ first).*$/s, "");
        const asked = await askApproval(`${req.params.name} needs your approval. ${showValue(reason, 300, 100)}\n${describeArgs(req.params.arguments ?? {})}`);
        return asked ? handleCall({ params: { ...req.params, arguments: { ...(req.params.arguments ?? {}), confirmed: true } } }) : first;
      });
    } finally {
      inFlight--;
    }
  });

  const shutdown = (code: number) => {
    killAllChildren();
    process.exit(code);
  };
  server.onclose = () => killAllChildren();
  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(0));
  process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") shutdown(0); });
  process.on("uncaughtException", (err) => { logger.error("Uncaught exception:", err); shutdown(1); });
  process.on("unhandledRejection", (err) => { logger.error("Unhandled rejection:", err); shutdown(1); });
  // Host went away: let in-flight calls finish briefly (one-shot `echo | node` use),
  // then kill whatever CLI is still running instead of lingering until its timeout.
  process.stdin.on("end", () => {
    if (inFlight > 0) setTimeout(() => shutdown(0), 15_000).unref();
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`proton-drive-mcp v${VERSION} running`);

  // Probe the CLI after connecting so a slow `version` can never delay
  // `initialize` (hosts time out at ~5s). A missing CLI still leaves the server
  // up: tools/list works and each call returns a clear error.
  void checkCliAvailable().then((cliCheck) => {
    if (!cliCheck.available) {
      logger.error(cliCheck.reason === "not_executable"
        ? "proton-drive CLI found but not executable. Run: chmod +x $(which proton-drive)"
        : "proton-drive CLI not found. Download from https://proton.me/download/drive/cli/index.html, or set PROTON_DRIVE_BIN to its absolute path (find it with `which proton-drive`).");
    }
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    logger.error("Fatal:", err);
    process.exit(1);
  });
}
