# proton-drive-mcp

Claude Desktop MCP and companion CLI for [Proton Drive](https://proton.me/drive). List, upload, download, share, and manage files with end-to-end encryption — directly from Claude or your terminal.

Built on the official [Proton Drive CLI](https://proton.me/download/drive/cli/index.html).

## Prerequisites

1. **Proton Drive CLI** — download from [proton.me/download/drive/cli](https://proton.me/download/drive/cli/index.html) and add to your `PATH`
2. **Authenticate** — run `proton-drive auth login` in your terminal before using the MCP

## Claude Desktop Setup

Add to your `claude_desktop_config.json`:

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

Then restart Claude Desktop.

## Companion CLI

```bash
# Check auth
proton-drive-cli auth status

# List files
proton-drive-cli list /my-files

# Upload
proton-drive-cli upload ./reports /my-files/Reports --conflict skip

# Download
proton-drive-cli download /my-files/report.pdf ./local/report.pdf

# Share
proton-drive-cli share invite /my-files/Reports alice@pm.me editor --message "Please review"
proton-drive-cli share status /my-files/Reports
proton-drive-cli share revoke /my-files/Reports alice@pm.me

# Trash
proton-drive-cli trash /my-files/old-report.pdf
proton-drive-cli restore /my-files/old-report.pdf
proton-drive-cli trash empty
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `drive_auth_status` | Check authentication status |
| `drive_auth_logout` | Log out |
| `drive_version` | CLI/SDK version info |
| `drive_list` | List files at a path |
| `drive_upload` | Upload local file/folder |
| `drive_download` | Download to local path |
| `drive_move` | Move or rename |
| `drive_delete` | Delete permanently |
| `drive_share_status` | Get sharing info |
| `drive_share_invite` | Invite a user |
| `drive_share_revoke` | Revoke access |
| `drive_trash` | Move to trash |
| `drive_restore` | Restore from trash |
| `drive_empty_trash` | Empty trash |

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
