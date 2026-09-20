#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
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
import { isMainModule } from "./utils/isMainModule.js";
import { checkCliAvailable, callContext, killAllChildren } from "./utils/subprocess.js";
import {
  DriveCliNotFoundError,
  DriveCliError,
  DriveNotAuthenticatedError,
  DriveParseError,
} from "./utils/errors.js";
import { validateRemotePath, validateLocalPath, validateEmail, validateMessage, validateName, validateFlagValue } from "./utils/validation.js";
import { logger } from "./utils/logger.js";
import { getSyncRoot, readSyncFile, writeSyncFile, syncFileExists } from "./utils/syncfs.js";

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

function handleError(err: unknown): ToolResult {
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
function needConfirm(a: Record<string, unknown>, tool: string, action: string): ToolResult | undefined {
  if (a.confirmed === true) return undefined;
  return fail(`${tool} ${action} Describe this to the user, get their explicit OK, then call again with confirmed=true.`);
}

function paginate<T>(all: T[], a: Record<string, unknown>, defaultLimit: number) {
  const limit = typeof a.limit === "number" ? a.limit : defaultLimit;
  const offset = typeof a.offset === "number" ? a.offset : 0;
  const items = all.slice(offset, offset + limit);
  return { total: all.length, offset, limit, hasMore: offset + items.length < all.length, items };
}

type JsonSchemaProp = { type?: string; enum?: readonly unknown[]; items?: { type?: string }; minimum?: number; maximum?: number };
type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, JsonSchemaProp>; required?: readonly string[]; additionalProperties?: boolean };
  annotations?: Record<string, boolean>;
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
      "Check whether the Proton Drive CLI has an active authenticated session. " +
      "Returns {authenticated: boolean}. The underlying CLI has no dedicated status command — this probes by resolving /my-files, which makes a real (lightweight) call. " +
      "Use before any file operation when you need to confirm the session is valid — all other drive_* tools (except drive_version) require authentication. " +
      "Does not expose the signed-in account's email — the CLI provides no way to query it.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_auth_logout",
    description:
      "Clear the stored Proton Drive session from the OS keychain. " +
      "After logout all file and sharing operations will fail until the user runs `proton-drive auth login` again. " +
      "Use on shared machines to prevent session persistence. " +
      "Do not call during an active workflow — it will break all subsequent drive_* calls. " +
      "Idempotent: safe to call even if already logged out.",
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_version",
    description:
      "Return the installed proton-drive CLI version and SDK version as {cli: string, sdk: string}. " +
      "Does not require authentication — use to confirm the correct binary is in PATH before other operations, or to diagnose compatibility issues. " +
      "Do not use to check auth state; use drive_auth_status instead.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  // Filesystem
  {
    name: "drive_list",
    description:
      "List the immediate children of a Proton Drive folder. Requires authentication. " +
      "Returns {items, total, offset, limit, hasMore} (default limit 200); items are [{name, path, type ('file'|'folder'), size?, modifiedAt?, mimeType?}]. Listing '/' returns the top-level roots. " +
      "Not recursive — one directory level only. " +
      "Use before drive_upload to confirm the destination exists, or before drive_download to verify the remote path. " +
      "Do not use to list trash — use drive_list_trash instead.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to list (must start with '/'). E.g. /my-files or /my-files/Reports",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_info",
    description:
      "Get full metadata for a single Proton Drive file or folder, including latest revision details. Requires authentication. " +
      "Returns the node with verification wrappers unwrapped and duplicate/noise fields dropped (pass verbose=true for the raw CLI node, whose exact shape is not guaranteed). " +
      "Use when you need details drive_list doesn't return (e.g. revision info) for one specific known path. " +
      "Do not use to enumerate a folder's children — use drive_list instead.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to inspect (must start with '/'). E.g. /my-files/report.pdf",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_upload",
    description:
      "Upload a local file or folder to Proton Drive with end-to-end encryption. Requires authentication. " +
      "For folders, uploads recursively and preserves directory structure. " +
      "Returns {uploaded, skipped, failed} counts — fails the call if failed > 0 (common causes: quota exceeded, destination path not found, permission denied). " +
      "Conflict strategies are set separately for files and folders (CLI v0.8.0+) — both default to 'skip'. " +
      "Do not use to move files already on Drive (use drive_move) or to write text content directly (use drive_write_file if PROTON_DRIVE_SYNC_PATH is set). " +
      "Ensure destination folder exists first with drive_list; create it with drive_mkdir if needed.",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        localPath: {
          type: "string",
          description: "Absolute local filesystem path of the file or folder to upload (must start with '/').",
        },
        remotePath: {
          type: "string",
          description: "Absolute remote Drive destination folder path (must start with '/'). E.g. /my-files/Reports",
        },
        fileConflictStrategy: {
          type: "string",
          enum: ["skip", "create-new-revision", "rename", "replace"],
          description:
            "'skip' leaves an existing remote file unchanged (default). " +
            "'create-new-revision' uploads as a new version of the existing file, keeping history. " +
            "'rename' adds a unique suffix to the uploaded file's name. " +
            "'replace' trashes the remote file and uploads the local copy in its place — confirm with user first.",
        },
        folderConflictStrategy: {
          type: "string",
          enum: ["skip", "merge", "rename", "replace"],
          description:
            "'skip' leaves an existing remote folder unchanged (default). " +
            "'merge' merges the uploaded folder's contents into the existing one. " +
            "'rename' adds a unique suffix to the uploaded folder's name. " +
            "'replace' trashes the remote folder and uploads the local copy in its place — confirm with user first.",
        },
      },
      required: ["localPath", "remotePath"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_download",
    description:
      "Download a file or folder from Proton Drive to the local filesystem. Requires authentication. " +
      "localPath is a destination FOLDER, not the file's exact final path — the CLI creates it automatically if missing and places the downloaded item inside it under its original remote name. " +
      "E.g. downloading /my-files/report.pdf with localPath '/tmp/out' produces /tmp/out/report.pdf, not /tmp/out itself as a file — confirmed live against the real CLI (v0.8.0). " +
      "For folders, downloads recursively. " +
      "Conflict strategies are set separately for files and folders (CLI v0.8.0+) — both default to 'skip'. " +
      "Returns {downloaded, skipped, failed} counts — not the actual local path; construct it as localPath + the remote item's basename if you need it. Fails the call if any file failed to download. " +
      "Do not use to move files within Drive (use drive_move) or to read a small text file's contents (use drive_read_file if PROTON_DRIVE_SYNC_PATH is set).",
    annotations: { openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        remotePath: {
          type: "string",
          description: "Absolute remote Drive path to download (must start with '/'). E.g. /my-files/report.pdf",
        },
        localPath: {
          type: "string",
          description: "Absolute local DESTINATION FOLDER (must start with '/'), not the file's final path. Created automatically if it doesn't exist. The downloaded item is placed inside it, keeping its original remote name.",
        },
        fileConflictStrategy: {
          type: "string",
          enum: ["skip", "rename", "remove"],
          description:
            "'skip' leaves an existing local file unchanged (default). " +
            "'rename' downloads under a unique name. " +
            "'remove' deletes the local file and downloads the remote copy in its place — confirm with user first.",
        },
        folderConflictStrategy: {
          type: "string",
          enum: ["skip", "merge", "rename", "remove"],
          description:
            "'skip' leaves an existing local folder unchanged (default). " +
            "'merge' merges the downloaded folder's contents into the existing one. " +
            "'rename' downloads under a unique name. " +
            "'remove' deletes the local folder and downloads the remote copy in its place — confirm with user first.",
        },
      },
      required: ["remotePath", "localPath"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_mkdir",
    description:
      "Create a new empty folder on Proton Drive. Requires authentication. " +
      "Fails if the folder already exists or if the parent folder does not exist — use drive_list to check first. " +
      "Does not create intermediate directories; create each level separately. " +
      "Do not use to upload files (use drive_upload) or to create nested folder trees in one call.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path for the new folder (must start with '/'). E.g. /my-files/NewFolder",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_rename",
    description:
      "Rename a file or folder in place on Proton Drive, without moving it to a different parent folder. Requires authentication. " +
      "Equivalent to calling drive_move with the same parent and a new filename, but cheaper — one CLI call instead of drive_move's internal composition. " +
      "Do not use to relocate to a different folder — use drive_move for that (or when unsure which applies).",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote path of the file or folder to rename (must start with '/').",
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
      "Move or rename a file or folder on Proton Drive. Requires authentication. " +
      "To rename: keep the same parent, change only the filename (e.g. /my-files/old.pdf → /my-files/new.pdf) — or use drive_rename directly. " +
      "To move: provide a different parent folder. " +
      "Fails if destinationPath is already occupied or if its parent folder does not exist. " +
      "Do not use to copy a file while keeping the original (use drive_copy) or to download to local storage (use drive_download).",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: {
          type: "string",
          description: "Absolute remote path of the file or folder to move (must start with '/').",
        },
        destinationPath: {
          type: "string",
          description: "Absolute remote destination path (must start with '/'). Parent folder must exist.",
        },
      },
      required: ["sourcePath", "destinationPath"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_delete",
    description:
      "Permanently delete a file or folder that is already in the Proton Drive trash — irreversible. Requires authentication. " +
      "The underlying CLI only allows permanent deletion of items already inside /trash or /photos-trash; it rejects live paths. " +
      "Use drive_trash first to move a live item into trash, then pass its trash path here — or drive_empty_trash to clear everything at once. " +
      "Requires confirmed=true; always show the exact path to the user and get explicit confirmation before calling.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to permanently delete (must start with '/').",
        },
        confirmed: {
          type: "boolean",
          description: "Must be true. Confirms the user has acknowledged this deletion is permanent and cannot be undone.",
        },
      },
      required: ["path", "confirmed"],
      additionalProperties: false,
    },
  },
  // Sharing
  {
    name: "drive_share_status",
    description:
      "Return the current sharing state of a Proton Drive path. Requires authentication. " +
      "Returns {isShared: boolean, members: [{email, role, addedAt?, status: 'accepted'|'pending'}], shareUrl?}. " +
      "members includes both accepted access and pending invitations that haven't been accepted yet (including invites sent to non-Proton addresses, e.g. Gmail) — check the status field to tell them apart. " +
      "Always call this before drive_share_invite (to avoid duplicate invitations) and before drive_share_revoke (to confirm the member email — revoke also cancels pending invitations, not just accepted access). " +
      "Do not call this to modify sharing — it is read-only.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to inspect (must start with '/'). E.g. /my-files/project or /my-files/report.pdf. Must be an existing file or folder on Proton Drive.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_list_trash",
    description:
      "List all files and folders currently in the Proton Drive trash. Requires authentication. " +
      "Returns {items, total, offset, limit, hasMore} (default limit 100, newest first when the CLI reports trash times); items are [{name, path, type, size?, modifiedAt?, uid, trashedAt?}]. Names are NOT unique in trash — two items can share one path; use uid to tell them apart. " +
      "Use before drive_restore to find a trashed item's exact path, or before drive_empty_trash to show the user what will be permanently deleted. " +
      "Do not use to list active (non-trashed) files — use drive_list instead.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_share_invite",
    description:
      "Invite a person to access a Proton Drive file or folder by email. Requires authentication. " +
      "Immediately sends an email notification to the invitee — always confirm the email address and role with the user before calling. " +
      "role values: 'viewer' (read-only), 'editor' (read + write), 'admin' (read + write + reshare). " +
      "Do not call without first running drive_share_status — duplicate invitations may silently overwrite the existing role. " +
      "To remove access, use drive_share_revoke.",
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
          description: "Optional message included in the invitation email (max 2000 characters).",
        },
      },
      required: ["path", "email", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_share_revoke",
    description:
      "Remove a specific person's access to a Proton Drive file or folder. Requires authentication. " +
      "The revoked user receives no notification. " +
      "Always call drive_share_status first to confirm the email and current role before revoking. " +
      "Fails if the address is not a current member or pending invitee (matched case-insensitively). To remove everyone at once use drive_share_remove_all. " +
      "Do not use to modify a role — revoke and re-invite with the new role instead.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path of the shared file or folder (must start with '/'). E.g. /my-files/project. Must match the path used when the invitation was sent.",
        },
        email: {
          type: "string",
          description: "Email address of the member to remove. Must exactly match the address shown by drive_share_status — use drive_share_status first to confirm. E.g. alice@example.com.",
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
      "Move a file or folder to the Proton Drive trash. Requires authentication. " +
      "The item disappears from its original path immediately but is not permanently deleted — recover it with drive_restore or list it with drive_list_trash. " +
      "Prefer this over drive_delete whenever permanent removal is not explicitly required by the user. " +
      "Do not use when the item must be permanently gone immediately — use drive_delete with confirmed=true instead.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path to move to trash (must start with '/').",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_restore",
    description:
      "Restore a trashed file or folder back to its original Proton Drive path. Requires authentication. " +
      "Use drive_list_trash first to find the item's current path in trash. " +
      "Fails if the original parent folder no longer exists or if a new item with the same name was created at that path since it was trashed. " +
      "Do not use for items not currently in trash — it will return an error.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path of the item to restore, as shown in drive_list_trash output (must start with '/').",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_empty_trash",
    description:
      "Permanently delete ALL items in the Proton Drive trash — irreversible, no recovery. Requires authentication. " +
      "Requires confirmed=true. " +
      "Always call drive_list_trash first to show the user exactly what will be deleted, then ask for explicit confirmation. " +
      "Do not call if the user only wants to delete specific items — use drive_delete or drive_trash for individual files.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        confirmed: {
          type: "boolean",
          description: "Must be true. Confirms the user has reviewed the trash contents and acknowledged this action is permanent and irreversible.",
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
      "Copy a file or folder to another location on Proton Drive. Requires authentication. " +
      "The original is preserved — this is not a move. " +
      "destinationPath is the target PARENT folder (unlike drive_move, which takes a full new path). Pass newName to copy under a different name — required to duplicate an item inside its own folder. " +
      "Use drive_move when you want to relocate without keeping the original. " +
      "Do not use to duplicate large folder trees without user awareness of the storage cost.",
    annotations: { destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        sourcePath: {
          type: "string",
          description: "Absolute remote Drive path of the file or folder to copy (must start with '/'). E.g. /my-files/report.pdf",
        },
        destinationPath: {
          type: "string",
          description: "Absolute remote Drive path of the target parent folder (must start with '/'). E.g. /my-files/Archive",
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
      "List all pending sharing invitations from other Proton Drive users. Requires authentication. " +
      "Returns [{uid, role, invitedByEmail, invitedAt?, nodeName, nodeType}]. " +
      "Use the uid from this list to accept or reject with drive_invitation_accept / drive_invitation_reject. " +
      "Do not use to list members of folders you own — use drive_share_status instead.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "drive_invitation_accept",
    description:
      "Accept a pending Proton Drive sharing invitation. Requires authentication. " +
      "Get the invitation uid from drive_list_invitations first. " +
      "The shared folder becomes accessible in your Drive after accepting. " +
      "Do not guess the uid — always fetch it from drive_list_invitations.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        uid: {
          type: "string",
          description: "Invitation UID from drive_list_invitations output. E.g. 'drive:abc123' or 'photos:xyz456'.",
        },
      },
      required: ["uid"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_invitation_reject",
    description:
      "Reject a pending Proton Drive sharing invitation. Requires authentication. " +
      "Get the invitation uid from drive_list_invitations first. " +
      "The invitation is permanently declined — the sender is not notified. " +
      "Do not guess the uid — always fetch it from drive_list_invitations.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        uid: {
          type: "string",
          description: "Invitation UID from drive_list_invitations output. E.g. 'drive:abc123' or 'photos:xyz456'.",
        },
      },
      required: ["uid"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_share_leave",
    description:
      "Leave a Proton Drive folder that was shared with you by another user. Requires authentication. " +
      "Removes your access to the shared folder — the owner and other members are not affected. " +
      "To remove someone else's access to your own folder, use drive_share_revoke instead. " +
      "Do not use on folders you own — use drive_share_revoke to remove individual members.",
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
      "Create or update a public share link for a Proton Drive file or folder. Requires authentication. " +
      "Anyone with the link can access the item at the given role — no invitation or Proton account required. " +
      "Calling this again on the same path REPLACES the existing link's settings (same URL): omitting password/expiration removes them, and the result then carries a warning. Expiration can be at most ~90 days out. " +
      "Returns {url?, role?, expirationTime?, warning?} — the exact shape depends on the CLI/SDK response and fields may be absent. " +
      "The password, if set, is passed as a CLI argument and will appear in shell history/process list on the machine running this server. " +
      "Do not use for private sharing with specific people — use drive_share_invite instead.",
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
      "Remove the public share link from a Proton Drive file or folder. Requires authentication. " +
      "The link stops working immediately — direct member access (from drive_share_invite) is not affected. " +
      "Do not use to remove a specific person's access — use drive_share_revoke instead.",
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
      "Remove access for every member and every pending invitation (Proton and non-Proton) on a shared Proton Drive path, in a single call. Requires authentication and confirmed=true. " +
      "Use drive_share_status first to show the user who currently has access. " +
      "For removing one specific person, use drive_share_revoke instead — it is cheaper and less error-prone.",
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
      "List all photo albums in Proton Photos. Requires authentication. " +
      "Returns [{name, photoCount, isShared, creationTime?}]. " +
      "Album paths are /albums/<name> — use the name from this list to build paths for other album tools. " +
      "Do not use to list regular Drive folders — use drive_list instead.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "photos_create_album",
    description:
      "Create a new empty photo album in Proton Photos. Requires authentication. " +
      "Pass the album name (not a path) — the album is created at /albums/<name>. " +
      "Fails if an album with that name already exists.",
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
      "Rename an album or change its cover photo in Proton Photos. Requires authentication. " +
      "At least one of name or coverPhotoUid must be provided. " +
      "Use photos_list_album_photos to find a nodeUid to set as the cover.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        albumPath: {
          type: "string",
          description: "Absolute path of the album to update. Must start with /albums/. E.g. /albums/Vacation 2024",
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
      "Delete a Proton Photos album. Requires authentication and confirmed=true. " +
      "By default refuses to delete an album that still contains photos — pass force=true to override. " +
      "Photos live in your timeline independently of albums. save maps to the CLI's --save option (its exact effect is undocumented upstream) — leave it off unless the user asks. " +
      "albumPath must start with /albums/. " +
      "Always show the user the album name and photo count (from photos_list_albums) before calling.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        albumPath: {
          type: "string",
          description: "Absolute path of the album to delete. Must start with /albums/. E.g. /albums/Vacation 2024",
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
          description: "If true, save album photos to your timeline before deleting. Default false.",
        },
      },
      required: ["albumPath", "confirmed"],
      additionalProperties: false,
    },
  },
  {
    name: "photos_list_album_photos",
    description:
      "List the photos in a Proton Photos album. Requires authentication. " +
      "Returns {items, total, offset, limit, hasMore} (default limit 100); items are [{nodeUid}], or with loadDetails=true also name, mediaType, sizes, captureTime and tags. " +
      "albumPath must start with /albums/. " +
      "To add or remove photos, use their Drive path under /photos/ (not the nodeUid).",
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        albumPath: {
          type: "string",
          description: "Absolute path of the album. Must start with /albums/. E.g. /albums/Vacation 2024",
        },
      },
      required: ["albumPath"],
      additionalProperties: false,
    },
  },
  {
    name: "photos_add_to_album",
    description:
      "Add a photo from your Proton Photos library to an album. Requires authentication. " +
      "albumPath must start with /albums/; photoPath must start with /photos/. " +
      "The photo must already exist in your library — this does not upload new photos. " +
      "Use photos_list_albums to find album paths.",
    annotations: { destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        albumPath: {
          type: "string",
          description: "Absolute path of the album. Must start with /albums/. E.g. /albums/Vacation 2024",
        },
        photoPath: {
          type: "string",
          description: "Absolute path of the photo in your library. Must start with /photos/. E.g. /photos/IMG_001.jpg",
        },
      },
      required: ["albumPath", "photoPath"],
      additionalProperties: false,
    },
  },
  {
    name: "photos_remove_from_album",
    description:
      "Remove a photo from a Proton Photos album without deleting it from your library. Requires authentication. " +
      "albumPath must start with /albums/; photoPath must start with /photos/. " +
      "The photo is removed from the album only — it stays in your timeline.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        albumPath: {
          type: "string",
          description: "Absolute path of the album. Must start with /albums/. E.g. /albums/Vacation 2024",
        },
        photoPath: {
          type: "string",
          description: "Absolute path of the photo in the album. Must start with /photos/. E.g. /photos/IMG_001.jpg",
        },
      },
      required: ["albumPath", "photoPath"],
      additionalProperties: false,
    },
  },
  {
    name: "photos_list_timeline",
    description:
      "List photos in your Proton Photos timeline (your full photo library, not scoped to an album). Requires authentication. " +
      "Returns {items, total, offset, limit, hasMore} (default limit 50, newest first); items are [{nodeUid, captureTime, tags}], or with loadDetails=true also {name, mediaType, creationTime, totalStorageSize} (about 50% more tokens). " +
      "Use photos_download to download items by path, or photos_add_to_album to add them to an album.",
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
      "Download one or more photos from Proton Photos (timeline, an album, or shared-with-me) to a local folder. Requires authentication. " +
      "Multiple timeline photos can share the same filename — with conflictStrategy 'remove' or 'skip' only one copy survives locally; use 'rename' to keep all. " +
      "Fails if any item fails to download. " +
      "Do not use for regular Drive files — use drive_download instead.",
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
            "'skip' leaves an existing local file unchanged (default). " +
            "'rename' downloads under a unique name. " +
            "'remove' deletes the local file and downloads the remote copy in its place — confirm with user first.",
        },
      },
      required: ["photoPaths", "localFolder"],
      additionalProperties: false,
    },
  },
  {
    name: "photos_upload",
    description:
      "Upload one or more local photo or video files directly into your Proton Photos library (My Photos timeline). Requires authentication. " +
      "Non-photo/video files are silently skipped. Folders are recursed but flattened into My Photos — folder structure is not preserved. " +
      "Never overwrites — duplicates (matched by name + content hash) resolve to 'rename' or 'skip' only. " +
      "Do not use for regular Drive files — use drive_upload instead.",
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
      "Read the text contents of a file from the local Proton Drive sync folder. " +
      "Requires the PROTON_DRIVE_SYNC_PATH environment variable to point to the root of the synced folder (e.g. /Users/alice/Proton Drive). " +
      "The Proton Drive desktop app must be running and the file must be synced locally. " +
      "Limited to text files up to 1 MB — returns an error for binary files or larger files (use drive_download instead). " +
      "Do not use for files not yet synced locally, binary files, or files over 1 MB — use drive_download instead.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path of the file to read (must start with '/'). Mapped to the local sync folder. E.g. /my-files/notes.txt",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "drive_write_file",
    description:
      "Write text content to a file in the local Proton Drive sync folder (no Proton login needed — this only touches the local synced folder). " +
      "Requires the PROTON_DRIVE_SYNC_PATH environment variable to point to the sync folder root. " +
      "The Proton Drive desktop app must be running to sync the written file to the cloud. " +
      "Creates parent directories locally if they do not exist. " +
      "Refuses to overwrite an existing file unless confirmed=true — ask the user first. Content is limited to 5 MB. " +
      "Do not use for binary content or files that need to be uploaded without the desktop app running — use drive_upload instead.",
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute remote Drive path of the file to write (must start with '/'). Mapped to the local sync folder. E.g. /my-files/notes.txt",
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
] as const;

// ---- Tool surface: derived from TOOLS so the literal stays readable ----------
const CONFIRM_ALWAYS = new Set([
  "drive_auth_logout", "drive_share_invite", "drive_share_revoke", "drive_share_set_url",
  "drive_share_remove_url", "drive_share_leave", "drive_invitation_reject", "photos_remove_from_album",
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
const ANNOTATION_OVERRIDES: Record<string, Record<string, boolean>> = {
  drive_share_set_url: { destructiveHint: true },
  drive_upload: { destructiveHint: true },
  drive_download: { destructiveHint: true },
  photos_download: { destructiveHint: true },
  drive_read_file: { idempotentHint: true },
};

const TOOL_DEFS: ToolDef[] = TOOLS.map((t) => {
  const base = t as unknown as ToolDef;
  const properties: Record<string, JsonSchemaProp & { description?: string }> = { ...base.inputSchema.properties, ...(EXTRA_PROPS[base.name] ?? {}) };
  let description = base.description;
  if (base.name in PAGE_DEFAULTS) {
    properties.limit = { type: "integer", minimum: 1, maximum: 1000, description: `Max items to return (default ${PAGE_DEFAULTS[base.name]}).` };
    properties.offset = { type: "integer", minimum: 0, description: "Number of items to skip (default 0)." };
  }
  const confirmedProp = { type: "boolean", description: "Must be true. Only set after the user explicitly approved this exact action." };
  if (CONFIRM_ALWAYS.has(base.name)) {
    properties.confirmed = confirmedProp;
    description += " Requires confirmed=true — describe the action to the user and get their explicit OK first.";
  } else if (CONFIRM_CONDITIONAL[base.name]) {
    properties.confirmed = confirmedProp;
    description += ` Also requires confirmed=true ${CONFIRM_CONDITIONAL[base.name]}.`;
  }
  return {
    ...base,
    description,
    inputSchema: { ...base.inputSchema, properties },
    annotations: { ...(base.annotations ?? {}), ...(ANNOTATION_OVERRIDES[base.name] ?? {}) },
  };
});

export async function main() {
  const drive = new DriveService();

  const server = new Server(
    { name: "proton-drive-mcp", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }));

  const handleCall = async (req: { params: { name: string; arguments?: Record<string, unknown> } }): Promise<ToolResult> => {
    const { name, arguments: args = {} } = req.params;
    const a = args as Record<string, unknown>;

    const def = TOOL_DEFS.find((t) => t.name === name);
    if (def) {
      const problem = checkArgs(def, a);
      if (problem) return fail(problem);
    }

    try {
      switch (name) {
        case "drive_auth_status":
          return ok(await drive.authStatus());

        case "drive_auth_logout": {
          const gate = needConfirm(a, "drive_auth_logout", "ends the stored Proton Drive session for every client on this machine.");
          if (gate) return gate;
          await drive.authLogout();
          return ok({ message: "Logged out successfully." });
        }

        case "drive_version":
          return ok(await drive.version());

        case "drive_list": {
          const listPath = validateRemotePath(a.path);
          return ok({ path: listPath, ...paginate(await drive.list(listPath), a, PAGE_DEFAULTS.drive_list) });
        }

        case "drive_info":
          return ok(await drive.info(validateRemotePath(a.path), a.verbose === true));

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
            return fail("drive_upload with strategy 'replace' trashes the existing remote item. Describe this to the user, get their explicit OK, then call again with confirmed=true.");
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
            return fail("drive_download with strategy 'remove' deletes the existing LOCAL file or folder before downloading. Describe this to the user, get their explicit OK, then call again with confirmed=true.");
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
            return fail("drive_delete requires confirmed=true. Ask the user to confirm before deleting.");
          }
          const deletePath = validateRemotePath(a.path);
          await drive.delete(deletePath);
          return ok({ message: `Deleted: ${deletePath}` });
        }

        case "drive_list_trash": {
          const trashed = await drive.listTrash();
          if (trashed.some((f) => f.trashedAt)) trashed.sort((x, y) => (y.trashedAt ?? "").localeCompare(x.trashedAt ?? ""));
          return ok(paginate(trashed, a, PAGE_DEFAULTS.drive_list_trash));
        }

        case "drive_share_status":
          return ok(await drive.shareStatus(validateRemotePath(a.path)));

        case "drive_share_invite": {
          const inviteGate = needConfirm(a, "drive_share_invite", "immediately emails the invitee and grants them access.");
          if (inviteGate) return inviteGate;
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
          const revokeGate = needConfirm(a, "drive_share_revoke", "removes a person's access.");
          if (revokeGate) return revokeGate;
          const revokeEmail = validateEmail(a.email);
          await drive.shareRevoke(validateRemotePath(a.path), revokeEmail);
          return ok({ message: `Revoked access for ${revokeEmail}.` });
        }

        case "drive_trash": {
          const trashPath = validateRemotePath(a.path);
          await drive.trash(trashPath);
          return ok({ message: `Moved to trash: ${trashPath}` });
        }

        case "drive_restore": {
          const restorePath = validateRemotePath(a.path);
          await drive.restore(restorePath);
          return ok({ message: `Restored from trash: ${restorePath}` });
        }

        case "drive_empty_trash":
          if (a.confirmed !== true) {
            return fail(
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
          const rejectGate = needConfirm(a, "drive_invitation_reject", "declines the invitation permanently.");
          if (rejectGate) return rejectGate;
          const rejectUid = validateFlagValue(a.uid, "uid");
          await drive.invitationReject(rejectUid);
          return ok({ message: "Invitation rejected." });
        }

        case "drive_share_leave": {
          const leaveGate = needConfirm(a, "drive_share_leave", "removes your own access to a shared folder.");
          if (leaveGate) return leaveGate;
          const leavePath = validateRemotePath(a.path);
          await drive.shareLeave(leavePath);
          return ok({ message: `Left shared folder: ${leavePath}` });
        }

        case "drive_share_set_url": {
          const setUrlGate = needConfirm(a, "drive_share_set_url", "creates or replaces a PUBLIC link that anyone with the URL can open.");
          if (setUrlGate) return setUrlGate;
          const setUrlPath = validateRemotePath(a.path);
          const role = typeof a.role === "string" ? a.role : "viewer";
          if (!["viewer", "editor"].includes(role)) return fail("role must be viewer or editor");
          const password = typeof a.password === "string" && a.password ? validateFlagValue(a.password, "password") : undefined;
          const expiration = typeof a.expiration === "string" && a.expiration ? validateFlagValue(a.expiration, "expiration") : undefined;
          const link = await drive.shareSetUrl(setUrlPath, role as "viewer" | "editor", password, expiration);
          return ok(link);
        }

        case "drive_share_remove_url": {
          const removeUrlGate = needConfirm(a, "drive_share_remove_url", "disables the public link.");
          if (removeUrlGate) return removeUrlGate;
          const removeUrlPath = validateRemotePath(a.path);
          await drive.shareRemoveUrl(removeUrlPath);
          return ok({ message: `Public link removed: ${removeUrlPath}` });
        }

        case "drive_share_remove_all": {
          if (a.confirmed !== true) {
            return fail("drive_share_remove_all requires confirmed=true. Use drive_share_status first to show the user who has access.");
          }
          const removeAllPath = validateRemotePath(a.path);
          const removedCount = await drive.shareRemoveAll(removeAllPath);
          return ok({ message: removedCount === 0 ? `Nothing to remove: ${removeAllPath} has no members or pending invitations.` : `Removed all access (${removedCount} member/invitation(s)) to: ${removeAllPath}` });
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
          return ok({ message: `Album updated: ${updateAlbumPath}` });
        }

        case "photos_delete_album": {
          if (a.confirmed !== true) return fail("photos_delete_album requires confirmed=true. Show the user the album name and photo count first.");
          const albumDelPath = validateRemotePath(a.albumPath);
          if (!albumDelPath.startsWith("/albums/")) return fail("albumPath must start with /albums/");
          await drive.deleteAlbum(albumDelPath, a.force === true, a.save === true);
          return ok({ message: `Album deleted: ${albumDelPath}` });
        }

        case "photos_list_album_photos": {
          const albumListPath = validateRemotePath(a.albumPath);
          if (!albumListPath.startsWith("/albums/")) return fail("albumPath must start with /albums/");
          return ok(paginate(await drive.listAlbumPhotos(albumListPath, a.loadDetails === true), a, PAGE_DEFAULTS.photos_list_album_photos));
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
          const removePhotoGate = needConfirm(a, "photos_remove_from_album", "removes a photo from the album.");
          if (removePhotoGate) return removePhotoGate;
          const remAlbumPath = validateRemotePath(a.albumPath);
          const remPhotoPath = validateRemotePath(a.photoPath);
          if (!remAlbumPath.startsWith("/albums/")) return fail("albumPath must start with /albums/");
          if (!remPhotoPath.startsWith("/photos/")) return fail("photoPath must start with /photos/");
          await drive.removePhotoFromAlbum(remAlbumPath, remPhotoPath);
          return ok({ message: `Removed ${remPhotoPath} from ${remAlbumPath}` });
        }

        case "photos_list_timeline":
          return ok(paginate(await drive.photoTimeline(a.loadDetails === true), a, PAGE_DEFAULTS.photos_list_timeline));

        case "photos_download": {
          if (!Array.isArray(a.photoPaths) || a.photoPaths.length === 0) return fail("photoPaths must be a non-empty array of strings");
          const downloadPaths = a.photoPaths.map((p) => validateRemotePath(p));
          const downloadFolder = validateLocalPath(a.localFolder);
          const pdcs = typeof a.conflictStrategy === "string" ? a.conflictStrategy : "skip";
          if (!["skip", "rename", "remove"].includes(pdcs)) return fail("conflictStrategy must be skip, rename, or remove");
          if (pdcs === "remove" && a.confirmed !== true) {
            return fail("photos_download with conflictStrategy 'remove' deletes the existing LOCAL file before downloading. Describe this to the user, get their explicit OK, then call again with confirmed=true.");
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
            return fail(`drive_write_file would overwrite the existing file ${writePath}. Ask the user to confirm, then call again with confirmed=true.`);
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
      return await callContext.run({ signal: extra?.signal }, () => handleCall(req));
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
        : "proton-drive CLI not found. Download from https://proton.me/download/drive/cli/index.html");
    }
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    logger.error("Fatal:", err);
    process.exit(1);
  });
}
