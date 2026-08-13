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
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blueviolet)](https://modelcontextprotocol.io)
[![GitHub stars](https://img.shields.io/github/stars/googlarz/proton-drive-mcp?style=social)](https://github.com/googlarz/proton-drive-mcp)
[![Last commit](https://img.shields.io/github/last-commit/googlarz/proton-drive-mcp?color=brightgreen&label=last%20commit)](https://github.com/googlarz/proton-drive-mcp/commits/main)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)](https://github.com/googlarz/proton-drive-mcp)
[![proton-drive-mcp MCP server](https://glama.ai/mcp/servers/googlarz/proton-drive-mcp/badges/score.svg)](https://glama.ai/mcp/servers/googlarz/proton-drive-mcp)

</div>

---

Give Claude Desktop (or any MCP client) full access to your Proton Drive and Proton Photos: list folders, upload and download files, invite collaborators, manage sharing, handle trash, and manage photo albums — all with end-to-end encryption intact. The same capabilities are available as a full CLI for scripting, backups, and cron.

## What you get

- **Claude manages your Proton Drive** — list, upload, download, move, share, trash, restore
- **Proton Photos album management** — list albums, create/delete albums, add and remove photos
- **Full CLI** — same 38 operations, scriptable and pipeable, works in cron and shell scripts
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

**3. Node.js 20 or later** — `node --version` to check.

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
    "proton-drive": {
      "command": "npx",
      "args": ["-y", "proton-drive-mcp"]
    }
  }
}
```

Restart Claude Desktop. Check **`+` → Connectors → proton-drive** to confirm the server is connected.

> **Tip:** Make sure `proton-drive auth login` has been run at least once before starting Claude Desktop.

### If installed globally

```json
{
  "mcpServers": {
    "proton-drive": {
      "command": "proton-drive-mcp"
    }
  }
}
```

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
0 2 * * * proton-drive-cli upload ~/Documents /my-files/Backups/$(date +%Y-%m-%d) --conflict skip

# Check who has access before a team change
proton-drive-cli share status /my-files/Projects
```

---

## Tool surface

### Auth
`drive_auth_status` · `drive_auth_logout` · `drive_version`

### Filesystem
`drive_list` · `drive_info` · `drive_mkdir` · `drive_upload` · `drive_download` · `drive_rename` · `drive_move` · `drive_delete`

### Sharing
`drive_share_status` · `drive_share_invite` · `drive_share_revoke` · `drive_share_remove_all` · `drive_share_set_url` · `drive_share_remove_url`

### Trash
`drive_list_trash` · `drive_trash` · `drive_restore` · `drive_empty_trash`

### Local sync (requires `PROTON_DRIVE_SYNC_PATH`)
`drive_read_file` · `drive_write_file`

### Copy
`drive_copy`

### Invitations
`drive_list_invitations` · `drive_invitation_accept` · `drive_invitation_reject` · `drive_share_leave`

### Photos
`photos_list_albums` · `photos_create_album` · `photos_update_album` · `photos_delete_album` · `photos_list_album_photos` · `photos_add_to_album` · `photos_remove_from_album` · `photos_list_timeline` · `photos_download` · `photos_upload`

---

## Tool reference

| Tool | Description | Key parameters |
|------|-------------|----------------|
| `drive_auth_status` | Check if authenticated (probes `/my-files` — no native status command) | — |
| `drive_auth_logout` | Log out (clear session) | — |
| `drive_version` | CLI and SDK version info | — |
| `drive_list` | List files and folders at a path | `path` |
| `drive_info` | Get full metadata for one file/folder, including revision details | `path` |
| `drive_mkdir` | Create a new empty folder | `path` |
| `drive_upload` | Upload local file or folder | `localPath`, `remotePath`, `fileConflictStrategy?` (skip/create-new-revision/rename/replace), `folderConflictStrategy?` (skip/merge/rename/replace) |
| `drive_download` | Download to local path | `remotePath`, `localPath`, `fileConflictStrategy?` (skip/rename/remove), `folderConflictStrategy?` (skip/merge/rename/remove) |
| `drive_rename` | Rename in place, no move | `path`, `newName` |
| `drive_move` | Move and/or rename | `sourcePath`, `destinationPath` |
| `drive_copy` | Copy file or folder to another Drive location | `sourcePath`, `destinationPath` |
| `drive_delete` | Permanently delete an item already in trash ⚠️ | `path`, `confirmed: true` |
| `drive_list_trash` | List items currently in trash | — |
| `drive_share_status` | Get sharing members and URL | `path` |
| `drive_share_invite` | Invite a user | `path`, `email`, `role` (viewer/editor/admin), `message?` |
| `drive_share_revoke` | Revoke one person's access | `path`, `email` |
| `drive_share_remove_all` | Remove every member + pending invitation at once ⚠️ | `path`, `confirmed: true` |
| `drive_share_set_url` | Create/update a public share link | `path`, `role?` (viewer/editor), `password?`, `expiration?` |
| `drive_share_remove_url` | Remove the public share link ⚠️ | `path` |
| `drive_trash` | Move to trash | `path` |
| `drive_restore` | Restore from trash | `path` |
| `drive_empty_trash` | Permanently delete all trash ⚠️ | `confirmed: true` |
| `drive_read_file` | Read text file from local sync folder | `path` |
| `drive_write_file` | Write text file to local sync folder ⚠️ | `path`, `content` |
| `drive_list_invitations` | List pending sharing invitations received | — |
| `drive_invitation_accept` | Accept a pending invitation | `uid` (from `drive_list_invitations`) |
| `drive_invitation_reject` | Reject a pending invitation ⚠️ | `uid` (from `drive_list_invitations`) |
| `drive_share_leave` | Leave a shared folder shared with you ⚠️ | `path` |
| `photos_list_albums` | List all Proton Photos albums | — |
| `photos_create_album` | Create a new empty album | `name` |
| `photos_update_album` | Rename an album or change its cover photo | `albumPath`, `name?`, `coverPhotoUid?` |
| `photos_delete_album` | Delete an album ⚠️ | `albumPath`, `confirmed: true`, `force?`, `save?` |
| `photos_list_album_photos` | List photos in an album | `albumPath` |
| `photos_add_to_album` | Add a photo from your library to an album | `albumPath`, `photoPath` |
| `photos_remove_from_album` | Remove a photo from an album (keeps it in library) ⚠️ | `albumPath`, `photoPath` |
| `photos_list_timeline` | List photos in your full library timeline | `loadDetails?` |
| `photos_download` | Download photos to a local folder | `photoPaths`, `localFolder`, `conflictStrategy?` (skip/rename/remove) |
| `photos_upload` | Upload local files directly into your Photos library | `localPaths`, `conflictStrategy?` (skip/rename) |

> ⚠️ **Destructive tools** require `confirmed: true`. Use `drive_list_trash` first so you know what will be deleted, then pass `confirmed: true` to proceed.

---

## Compared with other Drive MCPs

| Capability | Generic S3/GDrive MCPs | proton-drive-mcp |
|---|---|---|
| End-to-end encryption | No | Yes (via Proton CLI) |
| Credential exposure | API keys in config | Zero — OS keychain only |
| Sharing & invitations | Rarely | Full (invite, revoke, status) |
| Trash & restore | Rarely | Full |
| CLI parity | No | Full CLI mirrors all MCP tools |
| Shell injection safe | Varies | Yes — `execFile` only |

---

## Operational notes

- `drive_upload` passes `--skip-thumbnails` by default. Remove it from the subprocess args if you want WebP preview generation (requires Bun 1.3.14+ installed).
- `drive_move` accepts a full destination path (parent + new name) for a familiar interface, but the underlying CLI only has separate `move` (change parent) and `rename` (change name) commands — this MCP translates automatically, issuing one or both as needed.
- `drive_delete` only works on items already in `/trash` or `/photos-trash` — the CLI rejects live paths. Trash an item first with `drive_trash`, or use `drive_empty_trash` to clear everything at once.
- `drive_auth_status` has no native CLI equivalent — it probes by resolving `/my-files` and reports authenticated based on whether that succeeds.
- Paths are always Drive-absolute: `/my-files/folder/file.pdf`. Relative paths are not supported.
- All calls include `--json` automatically, except `drive_version`, whose underlying CLI command ignores `--json` and always prints plain text — this MCP parses it directly.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PROTON_DRIVE_SYNC_PATH` | Optional | Absolute path to your local Proton Drive sync folder root (e.g. `/Users/you/Proton Drive`). Required only for `drive_read_file` and `drive_write_file`. The Proton Drive desktop app must be running to sync written files to the cloud. |
| `PROTON_DRIVE_BIN` | Optional | Override the `proton-drive` binary name or path (default: `proton-drive`). Useful for non-standard installations. |

---

## Troubleshooting

**"PROTON_DRIVE_SYNC_PATH is not set"**  
Add `"PROTON_DRIVE_SYNC_PATH": "/absolute/path/to/your/Proton Drive"` to your Claude Desktop MCP config env block. The path must point to the root folder that the Proton Drive desktop app syncs to.

**"proton-drive CLI not found"**  
Download from [proton.me/download/drive/cli](https://proton.me/download/drive/cli/index.html) and ensure the binary is in your `PATH`. Verify with `which proton-drive`.

**"Not authenticated"**  
Run `proton-drive auth login` in your terminal. Auth state is stored in your OS keychain and persists across sessions.

**Claude can't see the connector**  
Restart Claude Desktop fully after changing the MCP config. Check **`+` → Connectors → proton-drive**. The Proton Drive CLI must be in the `PATH` that Claude Desktop inherits (on macOS this may differ from your shell PATH — use the full binary path in config if needed).

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
    "proton-drive": {
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
    "proton-drive": {
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
