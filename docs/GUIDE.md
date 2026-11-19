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
- A checkup sends the model a score, counts, sizes and at most 3 example names for each kind of problem (the result says how many names it contains). If you ask for the details of one kind of problem, up to 200 names are sent. The full list of files a cleanup would move to the trash is shown to you by the server in its own question, not sent through the model.
- Nothing new leaves your computer because of the checkup, cleanup or undo tools: no new network connection, no tracking.

## 3. Six prompts to paste

| Prompt | Tool | Changes anything? |
|---|---|---|
| "Give /my-files/Documents a checkup." | `drive_checkup` | No. It reports a score and what it found, and changes nothing. It also works in read-only mode. |
| "Who has access to my shared folders? Which public links never expire?" | `drive_sharing_audit` | No. Link URLs are left out of the result. |
| "Propose how to move the PDFs in /my-files/Documents/Inbox into /my-files/Documents/PDFs. Show me the plan first and wait for my yes." | `drive_bulk_move` | Not until you approve: it first returns a plan only, and applying needs your approval of the exact list. Needs writes enabled (section 5). |
| "Find the document that mentions my 2023 tax return." | `drive_search_content` | No change on Drive. Needs the opt-in content index (below). |
| "How much space does each folder under /my-files/Documents use? Show the five biggest." | `drive_usage` | No. |
| "What changed in /my-files/Documents in the last 7 days?" | `drive_recent_changes` | No. |

Want only the duplicates? "Find duplicate files in /my-files/Documents. List them with the space they waste. Do not delete anything." uses `drive_find_duplicates`, which only reports.

Content search is off by default. Add `"PROTON_DRIVE_CONTENT_INDEX": "1"` to the same `env` block, restart, then ask: "Index my /my-files/Documents folder." That calls `drive_content_index`, which writes an encrypted file on your computer, not on Drive, and also works in read-only mode. Details: [Content search](../README.md#content-search-opt-in). The README [Recipes](../README.md#recipes) cover similar flows in more depth.

## 4. Checkup, cleanup and undo

**Run a checkup.** Ask: "Give /my-files/Documents a checkup." You get a score from 0 to 100 and a short list: copies of the same file, empty folders, big old files, public links that never expire, things shared with other people, file names that look private (passport, tax, contract and similar) in shared places, and what is in the trash. The score is only a conversation starter. The "looks private" list is a guess from file names; no file is opened. If the answer says the scan is partial, ask again a minute later. On a big drive, point it at one folder.

**Clean up.** If the checkup finds extra copies or empty folders, Claude can offer a cleanup. Writes must be enabled for this (section 5). Claude does not choose the files: the server builds the list itself and leaves out the copy it keeps, anything shared, and anything whose name is already in the trash. Then the server asks you a question of its own. It shows a line for every file, for example:

```
/my-files/Documents/Inbox/2024-03 (1).pdf  (keeps /my-files/Documents/Invoices/2024-03.pdf)
```

Read it. The part in brackets is the copy that stays. If the list is long, the question shows the first 50 lines and counts per folder. Accept only if it is what you want. Nothing is deleted: the files go to the Drive trash. One call handles up to 200 items; Claude will tell you how many are left.

**What you see afterwards.** A short result with how many items went to the trash and an undo code such as `U7K2-M9XD`. Space is not freed until you empty the trash yourself, and emptying it cannot be undone.

**Undo.** Say "undo that". Claude shows what would be put back, and the server asks you again. It always asks, even for a simple restore, because an old move could put files back into a shared folder. After you accept, each item goes back to its original folder and the server checks that this exact item is there. If the original folder is gone, or a file of that name already exists there, that item is skipped and you are told why; nothing is overwritten. A batch can be undone once. "Show my undo list" shows the last batches (time, what was done, how many items; no names).

**Limits you should know.**
- Undo works only while the items are still in the trash, and only if no other item in the trash has the same name (the Proton Drive CLI restores by name). Cleanup leaves such items out. Trashing items one by one or in bulk still works but the result says how many cannot be undone.
- After you empty the trash, undo is not possible.
- The undo list is a file on your computer with the names of the items you changed, kept for 30 days. Set `PROTON_DRIVE_UNDO` to `0` in the same `env` block to switch it off (then there is no undo). Do not put the file inside your sync folder.
- Cleanup and undo have not been run against a real Proton account yet, and it is not verified that Claude Desktop shows the question (see the terminal route in section 5).

## 5. Before you allow writes

- [ ] Try the read-only prompts first and check the results look right.
- [ ] Trash is reversible: `drive_trash` and `drive_bulk_trash` move items to the Drive trash, and `drive_restore` brings them back (`drive_list_trash` shows what is there). `drive_delete` and `drive_empty_trash` are permanent; do not ask for them.
- [ ] Bulk operations are two-step: `drive_bulk_move`, `drive_bulk_trash` and `drive_cleanup` return a plan and change nothing until you approve the exact list. Read the plan before saying yes. `drive_undo` asks you the same way.
- [ ] **You are asked by the server, not by the assistant.** For anything that deletes, shares, makes a public link, accepts an invitation or replaces a file, the server shows you a question of its own. Chat messages like "yes, go ahead" are not the approval. Read the paths, the email address and the role in that question before you accept. If you are not sure, decline.
- [ ] Know the second way to approve. Some apps cannot show the question (it is not verified whether Claude Desktop can). Then the assistant tells you a code such as `K7Q2-M9XD`. Open a terminal yourself and run `proton-drive-cli approve K7Q2-M9XD` (without a global install: `npx -y -p proton-drive-mcp proton-drive-cli approve K7Q2-M9XD`). The terminal must use the same `PROTON_DRIVE_APPROVAL_DIR` (or the same `HOME` / `XDG_CACHE_HOME`) as the server, otherwise it says the code is unknown. The same route is offered when an app can show the question but you close it without answering. It prints what the server recorded; read it, and type `yes` only if it is what you wanted. Then ask the assistant to try again with the same request. `proton-drive-cli approvals` lists open requests and `proton-drive-cli deny K7Q2-M9XD` cancels one. The approval works once and expires after a few minutes. This is untested on Windows.
- [ ] Do not set `PROTON_DRIVE_APPROVAL=model`. It lets the assistant approve for itself.
- [ ] Set `PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE=1` so a file is copied into a `.versions` folder next to it before anything overwrites it.
- [ ] Keep `PROTON_DRIVE_REMOTE_ROOTS` on the narrowest folder that works, and keep the audit log on.
- [ ] To allow writes, remove `PROTON_DRIVE_MODE` from the config (the default is `full`) and restart.

## 6. If something looks wrong

1. Stop the conversation and close Claude Desktop.
2. Check the trash: `drive_list_trash` lists it and `drive_restore` brings an item back. If the last change was a cleanup, move or rename, `drive_undo` puts the batch back. Proton Drive in the browser also has a trash.
3. Read the audit log at the path you set in `PROTON_DRIVE_AUDIT_LOG`. It is a text file with one JSON line per call (`tool`, `args`, `outcome`). The `drive_audit_log` tool shows the newest entries and checks the hash chain, but it is unavailable while `PROTON_DRIVE_REMOTE_ROOTS` is set, so open the file directly.
4. End the session: run `proton-drive-cli auth logout` in a terminal. It clears the session from your OS keychain. Sign in again later with `proton-drive auth login`.
