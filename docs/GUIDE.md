# Using Proton Drive with an AI assistant safely

A short guide for people who are not developers and want to stay in control. It does not repeat the reference: for every option see the [README](../README.md), for the full list of controls see [SECURITY.md](../SECURITY.md#secure-deployment-profile), and for what the controls do not cover see [THREAT_MODEL.md](../THREAT_MODEL.md).

## 1. Start read-only

Edit `claude_desktop_config.json` (see [Connect to Claude Desktop](../README.md#connect-to-claude-desktop)) and replace the paths:

```json
{
  "mcpServers": {
    "proton-drive-mcp": {
      "command": "npx",
      "args": ["-y", "proton-drive-mcp"],
      "env": {
        "PROTON_DRIVE_BIN": "/Users/you/.local/bin/proton-drive",
        "PROTON_DRIVE_MODE": "readonly",
        "PROTON_DRIVE_REMOTE_ROOTS": "/my-files/Documents",
        "PROTON_DRIVE_AUDIT_LOG": "/Users/you/proton-audit/audit.jsonl"
      }
    }
  }
}
```

- `PROTON_DRIVE_MODE=readonly`: every tool that changes Drive or your account is hidden and refused.
- `PROTON_DRIVE_REMOTE_ROOTS`: the assistant can only work inside this folder.
- `PROTON_DRIVE_AUDIT_LOG`: one line per tool call, refused calls included. Use an absolute path outside your Proton Drive sync folder.

Restart Claude Desktop afterwards.

## 2. What your model provider sees

- File and folder names, sizes, dates and sharing status that the tools return are part of the conversation, so your model provider sees them.
- Any file text you ask the assistant to read, and any search snippet it shows, is sent to your model provider too.
- Your files stay encrypted in Proton Drive; the assistant only gets what a tool returns.

## 3. Six prompts to paste

| Prompt | Tool | Changes anything? |
|---|---|---|
| "Find duplicate files in /my-files/Documents. List them with the space they waste. Do not delete anything." | `drive_find_duplicates` | No. It only reports and never deletes. |
| "Who has access to my shared folders? Which public links never expire?" | `drive_sharing_audit` | No. Link URLs are left out of the result. |
| "Propose how to move the PDFs in /my-files/Documents/Inbox into /my-files/Documents/PDFs. Show me the plan first and wait for my yes." | `drive_bulk_move` | Not until you confirm: without `confirmed` it returns a plan only. Needs writes enabled (section 4). |
| "Find the document that mentions my 2023 tax return." | `drive_search_content` | No change on Drive. Needs the opt-in content index (below). |
| "How much space does each folder under /my-files/Documents use? Show the five biggest." | `drive_usage` | No. |
| "What changed in /my-files/Documents in the last 7 days?" | `drive_recent_changes` | No. |

Content search is off by default. Add `"PROTON_DRIVE_CONTENT_INDEX": "1"` to the same `env` block, restart, then ask: "Index my /my-files/Documents folder." That calls `drive_content_index`, which writes an encrypted file on your computer, not on Drive, and also works in read-only mode. Details: [Content search](../README.md#content-search-opt-in). The README [Recipes](../README.md#recipes) cover similar flows in more depth.

## 4. Before you allow writes

- [ ] Try the read-only prompts first and check the results look right.
- [ ] Trash is reversible: `drive_trash` and `drive_bulk_trash` move items to the Drive trash, and `drive_restore` brings them back (`drive_list_trash` shows what is there). `drive_delete` and `drive_empty_trash` are permanent; do not ask for them.
- [ ] Bulk operations are two-step: `drive_bulk_move` and `drive_bulk_trash` return a plan and change nothing until the call is repeated with `confirmed=true`. Read the plan before saying yes.
- [ ] Set `PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE=1` so a file is copied into a `.versions` folder next to it before anything overwrites it.
- [ ] Keep `PROTON_DRIVE_REMOTE_ROOTS` on the narrowest folder that works, and keep the audit log on.
- [ ] To allow writes, remove `PROTON_DRIVE_MODE` from the config (the default is `full`) and restart.

## 5. If something looks wrong

1. Stop the conversation and close Claude Desktop.
2. Check the trash: `drive_list_trash` lists it and `drive_restore` brings an item back. Proton Drive in the browser also has a trash.
3. Read the audit log at the path you set in `PROTON_DRIVE_AUDIT_LOG`. It is a text file with one JSON line per call (`tool`, `args`, `outcome`). The `drive_audit_log` tool shows the newest entries and checks the hash chain, but it is unavailable while `PROTON_DRIVE_REMOTE_ROOTS` is set, so open the file directly.
4. End the session: run `proton-drive-cli auth logout` in a terminal. It clears the session from your OS keychain. Sign in again later with `proton-drive auth login`.
