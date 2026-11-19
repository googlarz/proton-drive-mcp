# Architecture

proton-drive-mcp is an MCP server (and a companion CLI) that drives the official `proton-drive` CLI. The official CLI owns authentication, encryption and every Proton API call; this project adds the MCP layer, input validation, guards and response shaping. See [SPEC.md](SPEC.md) for the tool list and [THREAT_MODEL.md](THREAT_MODEL.md) for the security model.

## Layout of `src/`

| Path | Role |
|---|---|
| `index.ts` | MCP server entry (`dist/index.js`). The `TOOLS` array (tool definitions and JSON schemas), `CORE_TOOL_NAMES`, the guard sets, the `tools/list` and `tools/call` handlers, and the big `switch (name)` that runs each tool. Also exports the sets the tests import. |
| `cli.ts` | Companion CLI (`dist/cli.js`, bin `proton-drive-cli`). Its own `usage()` and `case` per command; calls the same services. |
| `prompts.ts` | MCP prompts. A prompt is offered only if every tool it `requires` is in the active tier. |
| `services/` | Logic behind the tools. `drive.ts` wraps the CLI commands; `walk.ts`, `walkIndex.ts`, `find.ts`, `analytics.ts`, `plan.ts`, `changes.ts`, `refreshIndex.ts` handle tree walks, the optional saved index, search, sharing audits and bulk plans; `content*.ts` and `readMany.ts` read file text and run the encrypted content index; `ocr.ts` runs OCR; `snapshot.ts` copies a file aside before an overwrite. |
| `utils/` | Cross-cutting helpers. `subprocess.ts` runs the CLI; `validation.ts` checks arguments; `remoteroots.ts`, `audit.ts`, `syncfs.ts`, `localguard.ts` implement the guard layer; `errors.ts`, `logger.ts`, `doctor.ts`, `cliVersion.ts`, `tempDirs.ts`, `tempSweep.ts` and others. |
| `ocr/vision-ocr.swift` | Swift helper for macOS Vision OCR. `npm run build` copies `src/ocr` to `dist/ocr`; it is compiled on first use. |
| `types/` | Shared types. |

Outside `src/`: `test/` (node:test files plus `test/helpers/fake-cli.mjs`, a fake `proton-drive`), `scripts/` (`pack-smoke.mjs`, `build-mcpb.mjs`), `mcpb/` (Claude Desktop bundle), `glama.json` and `smithery.yaml` (registry listings that must list the same tools).

## How a tool call reaches the CLI

1. The client sends `tools/call`. The `callTool` handler in `src/index.ts` looks the tool up in `TOOL_DEFS`.
2. Gates run before any CLI call, in this order: tool tier and readonly mode (`activeDefs`), argument check against the tool's `inputSchema` (`checkArgs`), `PROTON_DRIVE_REMOTE_ROOTS` (`rootsRefusal`), then the audit log writability check for mutating tools.
3. The `switch (name)` case validates arguments (`validateRemotePath`, `validateLocalPath` and friends in `src/utils/validation.ts`), builds an `Operation` for destructive or outward-facing tools and passes it to the approval gate (`requireApproval` -> `ApprovalGate.require`), then calls a service.
4. Services call `runDrive` or `runDriveRaw` from `src/utils/subprocess.ts`. These `spawn` the binary (`PROTON_DRIVE_BIN`, default `proton-drive`) with an argument array: no shell, stdin ignored, output size and timeout limits, children tracked and killed on shutdown. Other local programs (OCR engines, the keychain lookup in `utils/contentKey.ts`) are started the same way, from argument arrays.
5. The CLI's JSON output is parsed, shaped and returned as the tool result.

## How to add a tool

Use an existing tool of the same kind as a template. Every step below is enforced by a test unless noted.

1. **Definition.** Add an entry to the `TOOLS` array in `src/index.ts` with `name`, `description`, `annotations` (`readOnlyHint` for reads, `destructiveHint` and so on) and `inputSchema` (`additionalProperties: false`). Keep the description short: `tools/list` is sent to the model every session.
2. **Handler.** Add a `case "your_tool":` to the `switch (name)` in `callTool`, validate inputs with `src/utils/validation.ts`, if it deletes or exposes data, build an `Operation` after validation and call the gate before the first `drive.` call (see "Approval gate" below), and put the logic in `src/services/`. Add paging via `PAGE_DEFAULTS` if it returns a list.
3. **Classify it** (`test/guards.test.mjs`). Put the name in exactly one of `MUTATING_TOOL_NAMES` or `READ_TOOL_NAMES`. Mutating tools are hidden and refused in readonly mode.
4. **Scope it to roots.** Either list its Drive path arguments in `REMOTE_PATH_ARGS` (`strict: true` when acting on the root folder itself would take it out of scope), or add it to `ROOT_UNSCOPED_TOOL_NAMES` (it takes no Drive path, so it is refused while roots are set), or to `ROOT_EXEMPT_TOOL_NAMES` (it touches no Drive content; only `drive_auth_status` and `drive_version` today).
5. **Tier.** Add it to `CORE_TOOL_NAMES` only if it belongs in the small `PROTON_DRIVE_TOOL_TIER=core` set. Most tools should not be.
6. **Size budget.** `test/tool-tier.test.mjs` asserts the `tools/list` payload stays within a byte budget for `full` and `core`, and asserts the tool counts (also in `test/server.test.mjs`). Update the counts, and raise a budget only on purpose, with a comment saying why.
7. **CLI.** Either add a command to `src/cli.ts` (and its `usage()` text) and an entry in the `CLI_COMMAND` map in `test/parity.test.mjs`, or add the name to `MCP_ONLY` there if it needs the sync folder or the server's own state.
8. **Listings.** `test/parity.test.mjs` compares `tools/list` with the `case` labels in `src/index.ts`, `glama.json`, `smithery.yaml`, the README tool table (a `| \`name\` |` row) and the README grouped tool list. Update all of them.
9. **Tests.** Add tests in `test/` using the fake CLI (`test/helpers/mcp-client.mjs` starts the server against it). Cover the happy path, bad arguments, readonly mode and roots where they apply.
10. **Docs.** Update `README.md` (including the tool and CLI counts), `CHANGELOG.md` and `SPEC.md` (tool count and list).

Then run `npm run lint && npm test`.

## Approval gate

Destructive and outward-facing operations need a human yes (`PROTON_DRIVE_APPROVAL`: `human` default, `strict`, `model`).

- `src/utils/approval.ts` (pure, injectable): the `Operation` object, `opHash`, `renderOperation`, the gated set (`GATED_TOOLS`, `requiresApproval`), `resolveApprovalMode` and `ApprovalGate`. An `Operation` is `{tool, effect, fields, display?}`: validated values with defaults applied, never `confirmed`. What the human sees (`renderOperation`: a fixed title per tool in `TOOL_TITLES`, then one line per field, values neutralised by `showValueStrict`), what is hashed (`opHash`, sha256 of the sorted-key JSON of tool, effect and fields) and what runs are the same object. Secrets go into `fields` as `...Digest` values (hashed, never shown) with a harmless entry in `display`.
- `ApprovalGate.require(op)`: in `model` mode it accepts `confirmed: true`; otherwise it asks through channel 1 (`elicit`, MCP elicitation, with a decline budget of 5 per minute) when the client can, else channel 2 (the store), else it refuses with `approval_required`. Results: `ok` with the channel, or a refusal code (`approval_required`, `approval_declined`, `approval_unavailable`); bulk tools add `approval_changed` when the plan differs after approval.
- `src/utils/approvalStore.ts`: the out-of-band store (`pending`, `approved`, `consumed` folders of one-file-per-request JSON, `0700` / `0600`, state changes by atomic rename). Used by the server (`request`, `consume`) and by `proton-drive-cli approvals | approve | deny` (`src/cli.ts`).
- `src/utils/localguard.ts`: the approvals folder cannot be written by the download tools, and `assertApprovalDirUsable` refuses it inside `PROTON_DRIVE_SYNC_PATH`.

**How to add a gated tool.** (1) Add its name and a prompt title to `TOOL_TITLES`, and to `GATED_TOOLS` (plus `ALWAYS` or a conditional in `requiresApproval`) if it belongs in the default gated set. Every tool in `MUTATING_TOOL_NAMES` is gated in `strict` automatically. (2) In its `case`, validate arguments first, then build the `Operation` from the validated values only and call `requireApproval(op, need)` before the first `drive.` call; never read the raw `a` afterwards. (3) Run the tests: the table test in `test/approval-gate.test.mjs` fails if a tool is in neither the gated nor the not-gated list, or if a gated tool reaches the CLI without passing the gate. (4) Add the tool's wording to the README list of gated tools and to the THREAT_MODEL.
