```
  ____  ____   ___ _____ ___  _   _   ____  ____  _____     _______ 
 |  _ \|  _ \ / _ \_   _/ _ \| \ | | |  _ \|  _ \|_ _\ \   / / ____|
 | |_) | |_) | | | || || | | |  \| | | | | | |_) || | \ \ / /|  _|  
 |  __/|  _ <| |_| || || |_| | |\  | | |_| |  _ < | |  \ V / | |___ 
 |_|   |_| \_\\___/ |_| \___/|_| \_| |____/|_| \_\___|  \_/  |_____|
  MCP server and CLI · Full Proton Drive control for Claude
```

<div align="center">

[![npm version](https://img.shields.io/npm/v/proton-drive-mcp?color=%236d4aff&label=npm)](https://www.npmjs.com/package/proton-drive-mcp)
[![CI](https://github.com/googlarz/proton-drive-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/googlarz/proton-drive-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blueviolet)](https://modelcontextprotocol.io)
[![GitHub stars](https://img.shields.io/github/stars/googlarz/proton-drive-mcp?style=social)](https://github.com/googlarz/proton-drive-mcp)
[![Last commit](https://img.shields.io/github/last-commit/googlarz/proton-drive-mcp?color=brightgreen&label=last%20commit)](https://github.com/googlarz/proton-drive-mcp/commits/main)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](https://github.com/googlarz/proton-drive-mcp)
[![proton-drive-mcp MCP server](https://glama.ai/mcp/servers/googlarz/proton-drive-mcp/badges/score.svg)](https://glama.ai/mcp/servers/googlarz/proton-drive-mcp)

</div>

---

Give Claude Desktop (or any MCP client) full access to your Proton Drive and Proton Photos: list folders, upload and download files, invite collaborators, manage sharing, handle trash, and manage photo albums — all with end-to-end encryption intact. The same capabilities are available as a full CLI for scripting, backups, and cron.

## What you get

- **Claude manages your Proton Drive** — list, upload, download, move, share, trash, restore
- **Proton Photos album management** — list albums, create/delete albums, add and remove photos
- **Full CLI** — same 40 operations, scriptable and pipeable, works in cron and shell scripts
- **100% CLI coverage** — every scriptable Proton Drive CLI command has a matching tool (verified against the CLI's own source; `auth login` is the one command excluded, since it's an interactive browser flow)
- **Zero credential exposure** — auth is handled entirely by the official Proton Drive CLI; this MCP never touches your password or session token
- **Shell injection safe** — all CLI calls use `execFile` with discrete argument arrays, never string interpolation
- **Privacy-native** — end-to-end encryption is handled by Proton's own CLI; this server is just a thin MCP wrapper

---

## Privacy model

Your files travel: **Proton Drive (cloud, E2E encrypted) → Proton Drive CLI (local, decrypts) → this MCP server (local) → your AI client**.

The Proton Drive CLI handles all cryptography locally. This MCP server calls the CLI as a subprocess and forwards results — it never receives your password, never stores credentials, and never touches the raw encrypted data. Authentication state lives in your OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret), managed exclusively by the official Proton CLI.

If you use Claude Desktop with the default Anthropic API, file content you ask Claude to act on is sent to Anthropic per their [privacy policy](https://www.anthropic.com/privacy).

---

## Prerequisites

**1. Proton Drive CLI** — download from [proton.me/download/drive/cli](https://proton.me/download/drive/cli/index.html) and add to your `PATH`.

**2. Authenticate the CLI** — run once in your terminal:

```bash
proton-drive auth login
```

This opens a browser for Proton's standard sign-in flow. Credentials are stored in your OS keychain — not on disk, not in config files.

**3. Node.js 22 or later** — `node --version` to check.

---

## Install

**Via npx (no install needed):**

```bash
# Used directly in Claude Desktop config — no global install required
npx -y proton-drive-mcp
```

**Global install:**

```bash
npm install -g proton-drive-mcp
```

---

## Connect to Claude Desktop

Add to your `claude_desktop_config.json`:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "proton-drive-mcp": {
      "command": "npx",
      "args": ["-y", "proton-drive-mcp"],
      "env": { "PROTON_DRIVE_BIN": "/absolute/path/to/proton-drive" }
    }
  }
}
```

Claude Desktop starts servers with a minimal `PATH`, so a `proton-drive` in `~/.local/bin` is usually not found. Set `PROTON_DRIVE_BIN` to the output of `which proton-drive` (the default install location is `~/.local/bin/proton-drive`, written out in full, e.g. `/Users/you/.local/bin/proton-drive`). If `npx` itself is not found, use its absolute path as `command` (`which npx`).

Restart Claude Desktop. Check **`+` → Connectors → proton-drive-mcp** to confirm the server is connected.

> **Tip:** Make sure `proton-drive auth login` has been run at least once before starting Claude Desktop.

### One-click install (MCPB bundle)

Instead of editing JSON, download `proton-drive-mcp-<version>.mcpb` from the [latest GitHub release](https://github.com/googlarz/proton-drive-mcp/releases/latest) and open it (or drag it into **Settings → Extensions** in Claude Desktop). In the extension settings, set **proton-drive CLI path** to the output of `which proton-drive` (usually `~/.local/bin/proton-drive`); optionally set the **Proton Drive sync folder** to enable `drive_read_file` / `drive_write_file`. You still need the official `proton-drive` CLI installed and `proton-drive auth login` done once.

### If installed globally

```json
{
  "mcpServers": {
    "proton-drive-mcp": {
      "command": "proton-drive-mcp"
    }
  }
}
```

---

## Setup and diagnostics

Two commands of the companion CLI help when Claude Desktop reports "proton-drive CLI not found" (it starts servers with a minimal `PATH`):

```bash
# Read-only checks: Node >= 22, proton-drive CLI + version, auth, PROTON_DRIVE_SYNC_PATH, your Claude Desktop entry
proton-drive-cli doctor [--json] [--config <path>]

# Dry run: prints the entry it would add and the target file, changes nothing
proton-drive-cli setup-claude-desktop [--config <path>] [--sync-path <dir>]

# Apply it (timestamped backup first; only mcpServers["proton-drive-mcp"] is touched)
proton-drive-cli setup-claude-desktop --sync-path "$HOME/Proton Drive" --write
```

`doctor` exits 1 if any check fails (warnings do not fail). It only ever reports on the `proton-drive-mcp` entry of the config, never on other servers. `setup-claude-desktop` writes the absolute path of the running `node`, of this package's `dist/index.js`, and of the resolved `proton-drive` binary (`PROTON_DRIVE_BIN`). It refuses to run if the CLI cannot be found, the config file is not valid JSON, or the package is running from a temporary `npx` cache (install it first with `npm install -g proton-drive-mcp`). The entry pins the current `node` binary, so re-run it after switching Node versions (e.g. with nvm). Re-running with unchanged settings leaves the file alone; otherwise the file is replaced atomically and a timestamped `.bak-…` copy is kept.

The default config location is per OS (macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`, Linux `$XDG_CONFIG_HOME` or `~/.config/Claude/`); use `--config` or the `CLAUDE_DESKTOP_CONFIG` environment variable to point elsewhere. On Windows the CLI lookup honours `PATHEXT`.

**Claude Desktop only reads its config at startup: fully quit and restart it afterwards** (closing the window is not enough).

---

## Try it: example Claude prompts

**Backup a build artifact**
> "Upload ./dist/app-v2.zip to /my-files/Releases and tell me if it succeeded."

**Morning file triage**
> "List everything in /my-files. Tell me what's larger than 10MB and what was modified most recently."

**Share a folder with a colleague**
> "Share /my-files/Q2-Reports with alice@proton.me as editor. Add a message: 'Please review before Friday.'"

**Offboarding**
> "Revoke bob@company.com's access from /my-files/Projects and /shared/Design. Confirm when done."

**Automated download**
> "Download /my-files/contracts/nda-2026.pdf to ~/Documents/Legal/."

**Trash cleanup**
> "List what's in the trash and empty it once I confirm."

---

## CLI

```bash
proton-drive-cli <command> [args]
```

### Auth & info

```bash
proton-drive-cli auth status          # probes /my-files; the CLI has no dedicated status command
proton-drive-cli auth logout          # log out (clears OS keychain session)
proton-drive-cli version              # CLI and SDK version
```

### Files & folders

```bash
proton-drive-cli list /my-files
proton-drive-cli list /my-files/Reports
proton-drive-cli info /my-files/report.pdf       # full metadata, incl. revision details

proton-drive-cli mkdir /my-files/NewFolder

proton-drive-cli upload ./report.pdf /my-files/Reports
proton-drive-cli upload ./dist /my-files/Releases --file-conflict replace --folder-conflict merge

proton-drive-cli download /my-files/report.pdf ./local/report.pdf
proton-drive-cli download /my-files/Reports ./local/Reports --file-conflict rename --folder-conflict merge

proton-drive-cli rename /my-files/old-name.pdf new-name.pdf   # in place, no move
proton-drive-cli move /my-files/old-name.pdf /my-files/new-name.pdf
proton-drive-cli copy /my-files/report.pdf /my-files/Archive
proton-drive-cli delete /trash/obsolete-draft.pdf --confirm   # only works on items already in trash

# Machine-readable output (pipe-friendly)
proton-drive-cli list /my-files --json | jq '.[].name'
```

### Sharing

```bash
proton-drive-cli share status /my-files/Reports
proton-drive-cli share invite /my-files/Reports alice@pm.me editor
proton-drive-cli share invite /my-files/Reports bob@pm.me viewer --message "FYI"
proton-drive-cli share revoke /my-files/Reports alice@pm.me
proton-drive-cli share remove-all /my-files/Reports --confirm   # strip every member + pending invite

proton-drive-cli share set-url /my-files/Reports --role viewer --expiration 2026-06-06
proton-drive-cli share remove-url /my-files/Reports
```

### Trash

```bash
proton-drive-cli trash /my-files/old-draft.pdf        # move to trash
proton-drive-cli trash list                            # see what's in trash
proton-drive-cli restore /my-files/old-draft.pdf       # restore from trash
proton-drive-cli trash empty --confirm                  # permanently delete all trashed items
```

### Photos

```bash
proton-drive-cli album list
proton-drive-cli album create "Summer 2026"
proton-drive-cli album update /albums/Summer2026 --name "Summer Trip"
proton-drive-cli album add-photo /albums/Summer2026 /photos/IMG_001.jpg

proton-drive-cli photo timeline
proton-drive-cli photo download /photos/IMG_001.jpg ./local/photos --conflict rename
proton-drive-cli photo upload ./camera-roll --conflict skip
```

### Pipe and script

```bash
# Backup build output after CI
proton-drive-cli upload ./dist /my-files/Releases/$(date +%Y-%m-%d) --file-conflict rename --folder-conflict rename

# Download all contracts for audit
proton-drive-cli download /my-files/Contracts ./audit/contracts

# Nightly backup via cron
0 2 * * * proton-drive-cli upload ~/Documents /my-files/Backups/$(date +%Y-%m-%d) --file-conflict skip --folder-conflict skip

# Check who has access before a team change
proton-drive-cli share status /my-files/Projects
```

---

## Tool surface

### Auth
`drive_auth_status` · `drive_auth_logout` · `drive_version`

### Filesystem
`drive_list` · `drive_info` · `drive_tree` · `drive_search` · `drive_mkdir` · `drive_upload` · `drive_download` · `drive_rename` · `drive_move` · `drive_delete`

### Sharing
`drive_share_status` · `drive_share_invite` · `drive_share_revoke` · `drive_share_remove_all` · `drive_share_set_url` · `drive_share_remove_url`

### Trash
`drive_list_trash` · `drive_trash` · `drive_restore` · `drive_empty_trash`

### Local sync (requires `PROTON_DRIVE_SYNC_PATH`)
`drive_read_file` · `drive_write_file`

### Copy
`drive_copy`

### Plan & bulk
`drive_sync_plan` · `drive_bulk_move` · `drive_bulk_trash`

### Invitations
`drive_list_invitations` · `drive_invitation_accept` · `drive_invitation_reject` · `drive_share_leave`

### Photos
`photos_list_albums` · `photos_create_album` · `photos_update_album` · `photos_delete_album` · `photos_list_album_photos` · `photos_add_to_album` · `photos_remove_from_album` · `photos_list_timeline` · `photos_download` · `photos_upload`

---

## Tool reference

| Tool | Description | Key parameters |
|------|-------------|----------------|
| `drive_auth_status` | Check if authenticated (probes `/my-files` — no native status command) | — |
| `drive_auth_logout` | Log out (clear session) ⚠️ | `confirmed: true` |
| `drive_version` | CLI and SDK version info | — |
| `drive_list` | List files and folders at a path (paginated, default 200; `/` lists the roots) | `path`, `limit?`, `offset?` |
| `drive_info` | Get metadata for one file/folder, including revision details (noise trimmed) | `path`, `verbose?` (raw CLI node) |
| `drive_tree` | Folder overview: per-folder file counts and size totals (largest first), depth-limited, cached 5 min | `path?`, `depth?` (default 2, max 10), `limit?`, `foldersOnly?`, `refresh?` |
| `drive_search` | Find files/folders under a path in one cached walk: name (substring/glob/regex), type, extension, MIME prefix, size, modified date; sortable, paginated. Reports `walk.complete` — false means the walk was cut short and matches may be missing. Regex runs on the unprotected V8 engine: length-capped, avoid nested quantifiers | `query?`, `glob?`, `regex?`, `path?`, `type?`, `mediaType?`, `extensions?`, `minSize?`, `maxSize?`, `modifiedAfter?`, `modifiedBefore?`, `sort?`, `limit?` (default 50, max 500), `offset?`, `refresh?` |
| `drive_mkdir` | Create a new empty folder | `path` |
| `drive_upload` | Upload local file or folder | `localPath`, `remotePath`, `fileConflictStrategy?` (skip/create-new-revision/rename/replace), `folderConflictStrategy?` (skip/merge/rename/replace), `confirmed?` (**required for `replace`** — it trashes the existing remote item) |
| `drive_download` | Download to local path | `remotePath`, `localPath`, `fileConflictStrategy?` (skip/rename/remove), `folderConflictStrategy?` (skip/merge/rename/remove), `confirmed?` (**required for `remove`** — it deletes the existing local item) |
| `drive_rename` | Rename in place, no move | `path`, `newName` |
| `drive_move` | Move and/or rename | `sourcePath`, `destinationPath` |
| `drive_copy` | Copy file or folder into another Drive folder | `sourcePath`, `destinationPath` (target *parent folder*), `newName?` |
| `drive_delete` | Permanently delete an item already in trash ⚠️ | `path`, `confirmed: true` |
| `drive_list_trash` | List items currently in trash (paginated, default 100; includes `uid` — names are not unique in trash) | `limit?`, `offset?` |
| `drive_share_status` | Get sharing members and URL | `path` |
| `drive_share_invite` | Invite a user (sends an email) ⚠️ | `path`, `email`, `role` (viewer/editor/admin), `message?`, `confirmed: true` |
| `drive_share_revoke` | Revoke one person's access (fails if not a member) ⚠️ | `path`, `email`, `confirmed: true` |
| `drive_share_remove_all` | Remove every member + pending invitation at once ⚠️ | `path`, `confirmed: true` |
| `drive_share_set_url` | Create/replace a public share link ⚠️ (re-running without `password`/`expiration` removes them; expiry max ~90 days) | `path`, `role?` (viewer/editor), `password?`, `expiration?`, `confirmed: true` |
| `drive_share_remove_url` | Remove the public share link ⚠️ | `path`, `confirmed: true` |
| `drive_trash` | Move to trash | `path` |
| `drive_sync_plan` | Read-only diff of a local folder vs a Drive folder (nothing transferred) | `localPath`, `drivePath`, `direction?` (up/down/both), `ignore?`, `compare?` (size-mtime/sha1), `limit?` |
| `drive_bulk_move` | Move up to 200 items into an existing folder; without `confirmed` returns the plan and problems only | `sources`, `destinationFolder`, `confirmed?` (**required to apply**) |
| `drive_bulk_trash` | Trash up to 200 items (recoverable); without `confirmed` returns the plan and problems only | `paths`, `confirmed?` (**required to apply**) |
| `drive_restore` | Restore from trash | `path` |
| `drive_empty_trash` | Permanently delete all trash ⚠️ | `confirmed: true` |
| `drive_read_file` | Read text file from local sync folder | `path` |
| `drive_write_file` | Write text file to local sync folder ⚠️ (overwriting an existing file needs confirmation; max 5 MB) | `path`, `content`, `confirmed?` |
| `drive_list_invitations` | List pending sharing invitations received | — |
| `drive_invitation_accept` | Accept a pending invitation | `uid` (from `drive_list_invitations`) |
| `drive_invitation_reject` | Reject a pending invitation ⚠️ | `uid` (from `drive_list_invitations`), `confirmed: true` |
| `drive_share_leave` | Leave a shared folder shared with you ⚠️ | `path`, `confirmed: true` |
| `photos_list_albums` | List all Proton Photos albums | — |
| `photos_create_album` | Create a new empty album | `name` |
| `photos_update_album` | Rename an album or change its cover photo | `albumPath`, `name?`, `coverPhotoUid?` |
| `photos_delete_album` | Delete an album ⚠️ | `albumPath`, `confirmed: true`, `force?`, `save?` |
| `photos_list_album_photos` | List photos in an album (paginated, default 100) | `albumPath`, `loadDetails?`, `limit?`, `offset?` |
| `photos_add_to_album` | Add a photo from your library to an album | `albumPath`, `photoPath` |
| `photos_remove_from_album` | Remove a photo from an album (keeps it in library) ⚠️ | `albumPath`, `photoPath`, `confirmed: true` |
| `photos_list_timeline` | List photos in your full library timeline (paginated, default 50) | `loadDetails?`, `limit?`, `offset?` |
| `photos_download` | Download photos to a local folder | `photoPaths`, `localFolder`, `conflictStrategy?` (skip/rename/remove), `confirmed?` (**required for `remove`**) |
| `photos_upload` | Upload local files directly into your Photos library | `localPaths`, `conflictStrategy?` (skip/rename) |

> ⚠️ **Destructive and outward-facing tools** (deleting, sharing, public links, logout, and the `replace`/`remove` conflict strategies) require `confirmed: true`, and the CLI requires `--confirm` for the destructive ones. Describe the action to the user first, then pass `confirmed: true`. Tool arguments are validated against the published schema — unknown or mistyped arguments are rejected.

---

## Compared with other Drive MCPs

| Capability | Generic S3/GDrive MCPs | proton-drive-mcp |
|---|---|---|
| End-to-end encryption | No | Yes (via Proton CLI) |
| Credential exposure | API keys in config | Zero — OS keychain only |
| Sharing & invitations | Rarely | Full (invite, revoke, status) |
| Trash & restore | Rarely | Full |
| CLI parity | No | The CLI mirrors every MCP tool except `drive_read_file` / `drive_write_file` |
| Shell injection safe | Varies | Yes — `execFile` only |

---

## Operational notes

- Long listings are paginated (`limit` / `offset`, response `{total, offset, limit, hasMore, items}`) to keep responses small. Responses are compact JSON.
- Local paths passed to upload/download/photos tools are checked: credential locations (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.claude*`, keychains, `.env` files, …) are refused. Set `PROTON_DRIVE_LOCAL_ROOT` to allow only specific directories.
- The sync-folder tools (`drive_read_file` / `drive_write_file`) refuse to follow symlinks out of `PROTON_DRIVE_SYNC_PATH`.
- Error messages come from the CLI's own output; the command line (and therefore any `--password`) is never echoed back.
- `drive_move` accepts a full destination path (parent + new name) for a familiar interface, but the underlying CLI only has separate `move` (change parent) and `rename` (change name) commands — this MCP translates automatically, issuing one or both as needed.
- `drive_delete` only works on items already in `/trash` or `/photos-trash` — the CLI rejects live paths. Trash an item first with `drive_trash`, or use `drive_empty_trash` to clear everything at once.
- `drive_auth_status` has no native CLI equivalent — it probes by resolving `/my-files` and reports authenticated based on whether that succeeds.
- Paths are always Drive-absolute: `/my-files/folder/file.pdf`. Relative paths are not supported.
- All calls include `--json` automatically, except `drive_version`, whose underlying CLI command ignores `--json` and always prints plain text — this MCP parses it directly.

### Token cost

`tools/list` is sent to the model in every session. Measured payload (JSON bytes): `full` 32.2 KB (40 tools), `core` 15.9 KB (18 tools). Set `PROTON_DRIVE_TOOL_TIER=core` to load only:

`drive_auth_status`, `drive_version`, `drive_list`, `drive_info`, `drive_list_trash`, `drive_search`, `drive_tree`, `drive_mkdir`, `drive_upload`, `drive_download`, `drive_rename`, `drive_move`, `drive_copy`, `drive_trash`, `drive_restore`, `drive_share_status`, `photos_list_timeline`, `photos_download`.

Left out of `core` (use `full`): permanent deletion (`drive_delete`, `drive_empty_trash`), `drive_auth_logout`, public links, invitations and invites, album management, `photos_upload` and the sync-file tools. A call to a hidden tool returns an error asking for `PROTON_DRIVE_TOOL_TIER=full`; no CLI command runs.

## Known limitations

These come from the upstream `proton-drive` CLI (v0.8.0), not from this server:

- Big folders cannot be copied yet (`drive_copy` fails with `InvalidRequirementsAPIError` code 2000).
- A `"` in a name becomes `_` when the item is downloaded locally.
- Public-link expiration can be at most ~90 days ahead, to the minute.
- `drive_share_status` only reports sharing set directly on the item — access inherited from a shared parent folder is not shown.
- Roots (`/my-files`, `/photos`, …) cannot be shared; `drive_share_status` on a root returns an error.
- `photos_list_timeline` pages are not a snapshot: photos added or removed between calls shift later pages.
- Upload/download counts include folders, not only files.
- `/albums/...` paths cannot be downloaded — download a photo via `/photos/<name>`.
- A name ending in a backslash (e.g. `tail\`, created by another client) cannot be used as a parent in a path: the CLI reads `tail\/child` as an escaped `/`, and has no escape for a literal backslash (`\\` does not work either). The folder itself is reachable; its children are not reachable by path.
- Trashed items are addressed by name only. When two items in `/trash` or `/photos-trash` share a name, `drive_restore` and `drive_delete` refuse (listing the uids) instead of acting on an arbitrary one — restore or delete that item in the Proton Drive web or desktop app.
- When several programs use the CLI at the same moment (e.g. Claude Desktop and Claude Code), its local cache can briefly report `database is locked`. Read-only calls are retried automatically; writes are not (a retry could repeat the change), so just run the write again. The same read-only retry (up to two more attempts, short jittered backoff, honoring a `Retry-After` of at most 5 s and the call's overall timeout) also covers rate limiting (HTTP 429), single-request timeouts (`Request timed out`) and transient network resets; auth and not-found errors are never retried.

## Platform support

Developed and live-tested on **macOS**. CI runs the test suite on Ubuntu and macOS (Node 22 and 24). **Windows is not supported yet**: the test suite has never passed there and CI does not run it, and the Windows paths in `doctor` / `setup-claude-desktop` (`%APPDATA%`, `PATHEXT` lookup) are untested. The system-PATH warning in `doctor` only knows POSIX directories. Linux is covered by CI with the fake CLI but has not been live-tested against a real Proton account.

## Testing status

Every tool group was live-tested on 2026-09-28 against a real Proton account, **except** `drive_share_leave`, `drive_invitation_accept` and `drive_invitation_reject`. Those three have never been tested against a real account, because the maintainer has no second Proton account to share from; they are only unit-tested against a fake CLI.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PROTON_DRIVE_SYNC_PATH` | Optional | Absolute path to your local Proton Drive sync folder root (e.g. `/Users/you/Proton Drive`). Required only for `drive_read_file` and `drive_write_file`. The Proton Drive desktop app must be running to sync written files to the cloud. |
| `PROTON_DRIVE_BIN` | Optional | Override the `proton-drive` binary name or path (default: `proton-drive`; an empty value counts as unset). Useful for non-standard installations. |
| `PROTON_DRIVE_LOCAL_ROOT` | Optional | Path-delimiter-separated list of local directories that upload/download/photos tools may touch. Unset = any path except the built-in credential denylist. |
| `PROTON_DRIVE_ALLOW_SENSITIVE_PATHS` | Optional | Set to `1` to disable the built-in credential-location denylist (not recommended). |
| `CLAUDE_DESKTOP_CONFIG` | Optional | Path of the Claude Desktop config that `doctor` and `setup-claude-desktop` read/write instead of the per-OS default. |
| `PROTON_DRIVE_RETRY_BASE_MS` | Optional | Test hook: base backoff in ms for retrying read-only calls (default 250). |
| `PROTON_DRIVE_WALK_TTL_MS` | Optional | How long `drive_tree`/`drive_search` reuse a cached folder walk, in ms (default 300000; 0 disables the cache). The cache is also dropped for any path this server writes to. |
| `PROTON_DRIVE_TOOL_TIER` | Optional | `full` (default, all 40 tools) or `core` (18 everyday tools; see [Token cost](#token-cost)). Tools outside the active tier are hidden from `tools/list` and refused at call time. Read once at startup; an unknown value falls back to `full` with a warning on stderr. |

---

## Troubleshooting

**"PROTON_DRIVE_SYNC_PATH is not set"**  
Add `"PROTON_DRIVE_SYNC_PATH": "/absolute/path/to/your/Proton Drive"` to your Claude Desktop MCP config env block. The path must point to the root folder that the Proton Drive desktop app syncs to.

**"proton-drive CLI not found"**  
Download from [proton.me/download/drive/cli](https://proton.me/download/drive/cli/index.html) and ensure the binary is in your `PATH`. Verify with `which proton-drive`.

**"Not authenticated"**  
Run `proton-drive auth login` in your terminal. Auth state is stored in your OS keychain and persists across sessions.

**Claude can't see the connector**  
Restart Claude Desktop fully after changing the MCP config. Check **`+` → Connectors → proton-drive-mcp**. The Proton Drive CLI must be in the `PATH` that Claude Desktop inherits (on macOS this may differ from your shell PATH — use the full binary path in config if needed).

**Upload fails on image files**  
The CLI generates WebP thumbnails by default using Bun's image API. If Bun isn't installed or doesn't support thumbnails on your platform, the MCP passes `--skip-thumbnails` to bypass this. No action needed.

**Custom binary path**  
If the `proton-drive` binary is installed under a non-standard name or location, set `PROTON_DRIVE_BIN` in your environment:
```bash
PROTON_DRIVE_BIN=/usr/local/bin/proton-drive npx proton-drive-mcp
```
Or in Claude Desktop config:
```json
{
  "mcpServers": {
    "proton-drive-mcp": {
      "command": "npx",
      "args": ["-y", "proton-drive-mcp"],
      "env": { "PROTON_DRIVE_BIN": "/usr/local/bin/proton-drive" }
    }
  }
}
```

**Windows PATH issues**  
Use the full path to the `proton-drive.exe` binary in your Claude Desktop config if `npx` can't find it:
```json
{
  "mcpServers": {
    "proton-drive-mcp": {
      "command": "C:\\path\\to\\proton-drive-mcp.cmd"
    }
  }
}
```

---

## Development

```bash
git clone https://github.com/googlarz/proton-drive-mcp.git
cd proton-drive-mcp
npm install
npm run build
npm test
```

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Contributing

Bug reports and pull requests welcome: [github.com/googlarz/proton-drive-mcp/issues](https://github.com/googlarz/proton-drive-mcp/issues)

## License

MIT
