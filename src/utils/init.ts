import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNpxEntry, inspectEntry, isExecutableFile, resolveBinary, resolveDriveCli, writeEntry, SERVER_KEY } from "./claudeConfig.js";
import { formatDoctor, type Check } from "./doctor.js";

const DOWNLOAD_URL = "https://proton.me/download/drive/cli/index.html";
// Probed when the CLI is not on PATH (a minimal shell, or a fresh install not yet on PATH).
const FALLBACK_DIRS = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
// Directories Claude Desktop (a GUI app) can be expected to find `npx` in.
const GUI_PATH_DIRS = ["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"];

export interface InitOptions {
  configPath: string;
  write: boolean;
}

export interface InitResult {
  ok: boolean;
  text: string;
  json: Record<string, unknown>;
}

/** PROTON_DRIVE_BIN or PATH (the server's own resolver), then the usual install dirs. */
export function locateDriveCli(): { path?: string; viaFallback: boolean } {
  const direct = resolveDriveCli();
  if (direct) return { path: direct, viaFallback: false };
  if (process.env["PROTON_DRIVE_BIN"]) return { viaFallback: false }; // an explicit setting is never second-guessed
  for (const dir of FALLBACK_DIRS) {
    const candidate = join(dir, "proton-drive");
    if (isExecutableFile(candidate)) return { path: candidate, viaFallback: true };
  }
  return { viaFallback: false };
}

/** Quotes for a POSIX shell, inside double quotes. */
export function shellQuote(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Runs `doctor --json` in a child so PROTON_DRIVE_BIN can be set before the CLI path is read at import time. */
function runDoctorChild(configPath: string, cliPath: string | undefined, viaFallback: boolean): Promise<{ ok: boolean; checks: Check[] }> {
  const cliJs = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
  const env = { ...process.env, ...(viaFallback && cliPath ? { PROTON_DRIVE_BIN: cliPath } : {}) };
  return new Promise((res, rej) => {
    // doctor exits 1 when a check fails but still prints its result, so the error is only used if stdout is unusable.
    execFile(process.execPath, [cliJs, "doctor", "--json", "--config", configPath], { env, timeout: 60_000 }, (err, stdout, stderr) => {
      try { res(JSON.parse(stdout)); }
      catch { rej(new Error(`doctor produced no result${err ? `: ${err.message.split("\n")[0]}` : ""}${stderr ? `\n${stderr.trim()}` : ""}`)); }
    });
  });
}

function nextStep(checks: Check[]): string {
  const failed = checks.filter((c) => c.status === "fail");
  const first = failed.find((c) => c.id === "cli") ?? failed[0]!;
  const again = "then re-run `npx -y proton-drive-mcp init`";
  if (first.id === "cli") return `Install the official Proton Drive CLI from ${DOWNLOAD_URL} (or set PROTON_DRIVE_BIN to its absolute path), run \`proton-drive auth login\`, ${again}.`;
  if (first.id === "auth") return `Run \`proton-drive auth login\`, ${again}.`;
  return `${first.hint ?? first.message} (${first.id}), ${again}.`;
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const { configPath, write } = opts;
  const located = locateDriveCli();
  const doctor = await runDoctorChild(configPath, located.path, located.viaFallback);
  // init is what adds the Claude Desktop entry, so doctor's "run setup-claude-desktop" hint would point the wrong way.
  const checks = doctor.checks.map((c) => (c.id === "claude-desktop" && c.status === "warn" ? { ...c, hint: undefined } : c));
  const lines: string[] = ["proton-drive-mcp init", "", formatDoctor({ ok: doctor.ok, checks })];
  const json: Record<string, unknown> = { ok: doctor.ok, cliPath: located.path ?? null, checks };

  if (!doctor.ok) {
    const step = nextStep(checks);
    lines.push("", `Next step: ${step}`);
    json["nextStep"] = step;
  }
  if (!located.path) {
    if (write) lines.push("", "Nothing was written to your Claude Desktop config.");
    return { ok: false, text: lines.join("\n"), json };
  }

  const entry = buildNpxEntry(located.path);
  const shown = JSON.stringify({ mcpServers: { [SERVER_KEY]: entry } }, null, 2);
  const claudeCode = `claude mcp add --env PROTON_DRIVE_BIN=${shellQuote(located.path)} proton-drive -- npx -y proton-drive-mcp`;
  json["claudeCode"] = claudeCode;

  let ok = doctor.ok;
  lines.push("", `Claude Desktop (${configPath}):`, shown);
  try {
    const state = inspectEntry(configPath, entry);
    if (state === "same") {
      lines.push("Already up to date; nothing changed.");
      json["claudeDesktop"] = { configPath, entry, action: "none" };
    } else if (!write) {
      lines.push(`Dry run: nothing changed.${state === "different" ? " An existing proton-drive-mcp entry would be replaced." : ""} Re-run with --write to apply (timestamped backup first; other servers are never touched).`);
      json["claudeDesktop"] = { configPath, entry, action: "dry-run" };
    } else {
      const backup = writeEntry(configPath, entry);
      lines.push(`Wrote ${SERVER_KEY} to ${configPath}${backup ? ` (backup: ${backup})` : ""}.`, "Fully quit and restart Claude Desktop for the change to take effect.");
      json["claudeDesktop"] = { configPath, entry, action: "written", backup: backup ?? null };
    }
  } catch (e) {
    ok = false;
    lines.push(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const npx = resolveBinary("npx");
  if (npx && !GUI_PATH_DIRS.some((d) => npx.startsWith(d + "/"))) {
    lines.push(`Note: npx is at ${npx}, outside the PATH Claude Desktop is likely to use. If it cannot start the server, put that absolute path in "command" and add "PATH" (the directory of node) to env.`);
  }
  lines.push("", "Claude Code:", claudeCode);
  return { ok, text: lines.join("\n"), json };
}
