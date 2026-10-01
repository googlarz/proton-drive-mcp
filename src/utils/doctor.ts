import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DriveService } from "../services/drive.js";
import { runDriveRaw } from "./subprocess.js";
import { cliCompatWarning, TESTED_CLI } from "./cliVersion.js";
import { defaultConfigPath, isDirectory, isExecutableFile, resolveBinary, resolveDriveCli, SERVER_KEY } from "./claudeConfig.js";

export interface Check {
  id: string;
  status: "ok" | "warn" | "fail";
  message: string;
  hint?: string;
}

const SYSTEM_PATH_DIRS = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"];
const SETUP_HINT = "Run `proton-drive-cli setup-claude-desktop --write`, then fully restart Claude Desktop.";

function nodeCheck(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 22
    ? { id: "node", status: "ok", message: `Node ${process.versions.node}` }
    : { id: "node", status: "fail", message: `Node ${process.versions.node} (need >= 22)`, hint: "Install Node 22 or newer." };
}

async function cliChecks(): Promise<{ checks: Check[]; cliPath?: string }> {
  const cliPath = resolveDriveCli();
  if (!cliPath) {
    const bin = process.env["PROTON_DRIVE_BIN"];
    return {
      checks: [{
        id: "cli",
        status: "fail",
        message: bin ? `PROTON_DRIVE_BIN=${bin} is not an executable file` : "proton-drive CLI not found in PATH",
        hint: "Install it from https://proton.me/download/drive/cli/index.html, or set PROTON_DRIVE_BIN to its absolute path (`which proton-drive`).",
      }],
    };
  }
  const checks: Check[] = [];
  let version = "";
  let versionText = "";
  try { versionText = await runDriveRaw(["version"]); version = versionText.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ""; } catch { /* reported below */ }
  checks.push(version
    ? { id: "cli", status: "ok", message: `${cliPath} (${version})` }
    : { id: "cli", status: "warn", message: `${cliPath} (version unreadable)`, hint: "Run `proton-drive version` manually to see why." });
  if (version) {
    const warning = cliCompatWarning(versionText);
    checks.push(warning
      ? { id: "cli-version", status: "warn", message: version, hint: warning }
      : { id: "cli-version", status: "ok", message: `matches tested ${TESTED_CLI}.x` });
  }

  try {
    const auth = await new DriveService().authStatus();
    checks.push(auth.authenticated
      ? { id: "auth", status: "ok", message: "Authenticated" }
      : { id: "auth", status: "fail", message: "Not authenticated", hint: "Run `proton-drive auth login`." });
  } catch (e) {
    checks.push({ id: "auth", status: "fail", message: `Authentication probe failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`, hint: "Run `proton-drive auth status` to investigate." });
  }
  return { checks, cliPath };
}

function syncPathCheck(): Check | undefined {
  const p = process.env["PROTON_DRIVE_SYNC_PATH"];
  if (!p) return undefined;
  const abs = resolve(p);
  if (!existsSync(abs)) return { id: "sync-path", status: "fail", message: `${abs} does not exist`, hint: "Create the directory or fix PROTON_DRIVE_SYNC_PATH." };
  if (!isDirectory(abs)) return { id: "sync-path", status: "fail", message: `${abs} is not a directory`, hint: "Point PROTON_DRIVE_SYNC_PATH at a directory." };
  try { accessSync(abs, constants.R_OK | constants.W_OK); }
  catch { return { id: "sync-path", status: "fail", message: `${abs} is not readable and writable`, hint: "Fix the directory permissions." }; }
  return { id: "sync-path", status: "ok", message: abs };
}

function configCheck(configPath: string, cliPath: string | undefined): Check {
  const id = "claude-desktop";
  if (!existsSync(configPath)) {
    return { id, status: "warn", message: `Config not found: ${configPath}`, hint: `If you use Claude Desktop: ${SETUP_HINT}` };
  }
  let servers: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers?: unknown };
    if (parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)) servers = parsed.mcpServers as Record<string, unknown>;
  } catch {
    return { id, status: "fail", message: `${configPath} is not valid JSON`, hint: "Fix the JSON syntax; Claude Desktop ignores an unparsable config." };
  }
  // Only our own entry is ever inspected or reported: other servers' entries hold secrets.
  const key = SERVER_KEY in servers ? SERVER_KEY : Object.keys(servers).find((k) => {
    const a = (servers[k] as { args?: unknown } | null)?.args;
    return Array.isArray(a) && a.some((x) => typeof x === "string" && x.includes(SERVER_KEY));
  });
  if (!key) {
    return { id, status: "warn", message: `No proton-drive-mcp entry in ${configPath}`, hint: SETUP_HINT };
  }
  const entry = servers[key] as { command?: unknown; env?: { PROTON_DRIVE_BIN?: unknown; PROTON_DRIVE_SYNC_PATH?: unknown } } | null;
  const command = typeof entry?.command === "string" ? entry.command : "";
  if (!command || !resolveBinary(command)) {
    return { id, status: "fail", message: `Entry "${key}": command ${command ? `"${command}" ` : ""}does not resolve to an executable`, hint: `Use an absolute path for command. ${SETUP_HINT}` };
  }
  const bin = entry?.env?.PROTON_DRIVE_BIN;
  if (typeof bin === "string" && bin) {
    if (!isExecutableFile(bin)) {
      return { id, status: "fail", message: `Entry "${key}": PROTON_DRIVE_BIN=${bin} is not an executable file`, hint: SETUP_HINT };
    }
  } else if (cliPath && !SYSTEM_PATH_DIRS.some((d) => resolve(cliPath).startsWith(d + "/"))) {
    return {
      id, status: "warn",
      message: `Entry "${key}" found, but has no PROTON_DRIVE_BIN and ${cliPath} is outside Claude Desktop's minimal PATH`,
      hint: `Claude Desktop probably will not find the CLI. ${SETUP_HINT}`,
    };
  }
  const sync = typeof entry?.env?.PROTON_DRIVE_SYNC_PATH === "string" ? `, PROTON_DRIVE_SYNC_PATH=${entry.env.PROTON_DRIVE_SYNC_PATH}` : "";
  return { id, status: "ok", message: `Entry "${key}" in ${configPath} looks good${typeof bin === "string" ? ` (PROTON_DRIVE_BIN=${bin}${sync})` : ""}` };
}

export async function runDoctor(configPath?: string): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [nodeCheck()];
  const cli = await cliChecks();
  checks.push(...cli.checks);
  const sync = syncPathCheck();
  if (sync) checks.push(sync);
  checks.push(configCheck(configPath ? resolve(configPath) : defaultConfigPath(), cli.cliPath));
  return { ok: !checks.some((c) => c.status === "fail"), checks };
}

export function formatDoctor(result: { ok: boolean; checks: Check[] }): string {
  const icon = { ok: "✓", warn: "⚠", fail: "✗" } as const;
  const lines = result.checks.flatMap((c) => [`${icon[c.status]} ${c.id}: ${c.message}`, ...(c.status !== "ok" && c.hint ? [`    → ${c.hint}`] : [])]);
  lines.push("", result.ok ? "No problems found." : "Problems found.");
  return lines.join("\n");
}
