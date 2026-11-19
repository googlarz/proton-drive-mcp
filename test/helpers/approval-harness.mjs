// Shared harness for the 1.11.0 approval suites: an SDK client that can answer elicitation, the fake CLI, an audit log and
// helpers that tell reads from changes in the fake CLI's argv log.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, fakeEnv, DIST_INDEX, nonVersionCalls } from "./mcp-client.mjs";

export const ACCEPT = { action: "accept", content: { approve: true } };
export const DECLINE = { action: "decline" };
export const CANCEL = { action: "cancel" };
export const NO_APPROVE = { action: "accept", content: { approve: false } };
export const THROWS = Symbol("throws");

const READ_PREFIXES = [["filesystem", "list"], ["filesystem", "info"], ["filesystem", "size"], ["sharing", "status"], ["invitation", "list"], ["album", "list"]];
/** CLI calls that are not plain reads. */
export const changes = (argvLog) => nonVersionCalls(argvLog).filter((a) => !READ_PREFIXES.some(([x, y]) => a[0] === x && a[1] === y));

export const text = (r) => r.content?.[0]?.text ?? "";

/**
 * Starts the built server against the fake CLI with an SDK client.
 * opts.caps: client capabilities (default elicitation form). opts.replies: array consumed one per elicitation request, or a
 * function (message, index) => reply. opts.approval: PROTON_DRIVE_APPROVAL (null = unset).
 * fn(ctx): ctx = { client, sb, dir, asked, messages, call, changes, audit, lastAudit, env }.
 */
export async function withServer(opts, fn) {
  const { caps = { elicitation: { form: {} } }, replies = [], fakeMode = "json", env = {}, approval = "human", setup } = opts;
  const sb = makeSandbox();
  mkdirSync(join(sb.dir, "work"), { recursive: true });
  const auditFile = join(sb.dir, "audit", "audit.log");
  const extra = { PROTON_DRIVE_APPROVAL: approval, PROTON_DRIVE_AUDIT_LOG: auditFile, ...(setup?.(sb) ?? {}), ...env };
  const client = new Client({ name: "approval-test", version: "0" }, { capabilities: caps });
  const messages = [];
  let idx = 0;
  if (caps.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      messages.push(req.params.message);
      const r = typeof replies === "function" ? await replies(req.params.message, idx) : replies[idx];
      idx++;
      if (r === THROWS || r === undefined) throw new Error("test client error");
      return r;
    });
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_INDEX], env: fakeEnv(fakeMode, sb, extra), stderr: "pipe" });
  let stderr = "";
  await client.connect(transport);
  transport.stderr?.on("data", (d) => { stderr += d; });
  const audit = () => (existsSync(auditFile) ? readFileSync(auditFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const ctx = {
    client, sb, dir: sb.dir, messages, auditFile, audit,
    get asked() { return messages.length; },
    get stderr() { return stderr; },
    lastAudit: () => audit().at(-1),
    changes: () => changes(sb.argvLog),
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
  };
  try { return await fn(ctx); } finally { await client.close(); sb.cleanup(); }
}

/** A JSON file {folder: [items]} for FAKE_TREE; returns its path. */
export function writeTree(dir, tree) {
  const p = join(dir, "tree.json");
  writeFileSync(p, JSON.stringify(tree));
  return p;
}
