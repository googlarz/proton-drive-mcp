import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNpxEntry, isExecutableFile, planNpxEntry, resolveBinary, resolveDriveCli, writeEntry, SERVER_KEY } from "./claudeConfig.js";
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

/** Single-quotes for a POSIX shell: nothing inside expands (not `$`, backticks or history `!`); a literal `'` becomes '\''. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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

/** Doctor's claude-desktop line echoes the values of the existing entry's PROTON_DRIVE_* env; init never prints env values. */
function redact(c: Check): Check {
  if (c.id !== "claude-desktop") return c;
  const message = c.message
    .replace(/ \(PROTON_DRIVE_BIN=.*\)$/, " (env values not shown)")
    .replace(/PROTON_DRIVE_BIN=.* is not an executable file$/, "PROTON_DRIVE_BIN in the entry is not an executable file");
  return { ...c, message };
}

const verdict = (ok: boolean): string => (ok ? "No problems found." : "Problems found.");

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const { configPath, write } = opts;
  if (process.platform === "win32") {
    const text = "init is not supported on Windows (see \"Platform support\" in the README).";
    return { ok: false, text, json: { ok: false, error: text } };
  }
  const located = locateDriveCli();
  const doctor = await runDoctorChild(configPath, located.path, located.viaFallback);
  // init is what fixes the Claude Desktop entry, so a stale or missing one is shown as a warning, must not block it,
  // and doctor's "run setup-claude-desktop" hint would point the wrong way. Other failures still block.
  const checks = doctor.checks.map((c) => {
    const r = redact(c);
    if (r.id !== "claude-desktop" || r.status === "ok") return r;
    return { ...r, status: "warn" as const, ...(r.hint?.includes("setup-claude-desktop") ? { hint: undefined } : {}) };
  });
  const doctorOk = !checks.some((c) => c.status === "fail");
  // formatDoctor ends with a blank line and its own verdict; init prints one verdict at the very end instead.
  const lines: string[] = ["proton-drive-mcp init", "", ...formatDoctor({ ok: true, checks }).split("\n").slice(0, -2)];
  const json: Record<string, unknown> = { ok: doctorOk, cliPath: located.path ?? null, checks };

  if (!doctorOk) {
    const step = nextStep(checks);
    lines.push("", `Next step: ${step}`);
    json["nextStep"] = step;
  }
  if (!located.path) {
    lines.push("", ...(write ? ["Nothing was written to your Claude Desktop config.", ""] : []), verdict(false));
    return { ok: false, text: lines.join("\n"), json };
  }

  const shown = JSON.stringify({ mcpServers: { [SERVER_KEY]: buildNpxEntry(located.path) } }, null, 2);
  const claudeCode = `claude mcp add --env PROTON_DRIVE_BIN=${shellQuote(located.path)} proton-drive -- npx -y proton-drive-mcp`;
  json["claudeCode"] = claudeCode;

  let ok = doctorOk;
  let bareNpx = true;
  lines.push("", `Claude Desktop (${configPath}):`, shown);
  try {
    const plan = planNpxEntry(configPath, located.path);
    bareNpx = plan.entry.command === "npx";
    const kept = plan.preservedEnvKeys.length ? ` Kept as they are in the existing entry: env ${plan.preservedEnvKeys.join(", ")} (values not shown).` : "";
    const extra = [
      ...(plan.fromPinned ? ["The existing entry runs a pinned install (setup-claude-desktop form); the npx form runs the latest published version instead."] : []),
      ...(plan.droppedVersionPin ? [`The version pin ${plan.droppedVersionPin} is dropped in favor of the latest published version.`] : []),
      ...plan.notes.map((n) => `Note: ${n}.`),
    ].map((t) => ` ${t}`).join("");
    json["claudeDesktop"] = {
      configPath, entry: buildNpxEntry(located.path), preservedEnvKeys: plan.preservedEnvKeys, fromPinned: plan.fromPinned,
      droppedVersionPin: plan.droppedVersionPin ?? null, notes: plan.notes,
    };
    if (plan.state === "other-key") {
      ok = false;
      const names = plan.otherKeys.map((k) => `"${k}"`).join(", ");
      lines.push(`Not changed: this server is already registered under ${names} in ${configPath}, and a second entry would start a second copy and double the tools. To proceed, remove ${plan.otherKeys.length > 1 ? "those entries" : "that entry"}${plan.hasOwnKey ? "" : ` (or rename it to "${SERVER_KEY}" so init can update it)`}, then re-run \`npx -y proton-drive-mcp init${write ? " --write" : ""}\`.`);
      json["claudeDesktop"] = { ...(json["claudeDesktop"] as object), action: "refused", otherKeys: plan.otherKeys };
    } else if (plan.state === "same") {
      lines.push(`Already up to date; nothing changed.${kept}${extra}`);
      json["claudeDesktop"] = { ...(json["claudeDesktop"] as object), action: "none" };
    } else if (!write) {
      lines.push(`Dry run: nothing changed.${plan.state === "different" ? " An existing proton-drive-mcp entry would be replaced." : ""}${kept}${extra} Re-run with --write to apply (timestamped backup first; other servers are never touched).`);
      json["claudeDesktop"] = { ...(json["claudeDesktop"] as object), action: "dry-run" };
    } else {
      const backup = writeEntry(configPath, plan.entry);
      lines.push(`Wrote ${SERVER_KEY} to ${configPath}${backup ? ` (backup: ${backup})` : ""}.${kept}${extra}`, "Fully quit and restart Claude Desktop for the change to take effect.");
      json["claudeDesktop"] = { ...(json["claudeDesktop"] as object), action: "written", backup: backup ?? null };
    }
  } catch (e) {
    ok = false;
    lines.push(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
  lines.push("Note: the npx entry runs with the Node that Claude Desktop finds on its own PATH (it needs Node 22 or newer); doctor cannot check that.");
  const npx = resolveBinary("npx");
  if (bareNpx && npx && !GUI_PATH_DIRS.some((d) => npx.startsWith(d + "/"))) {
    lines.push(`Note: npx is at ${npx}, outside the PATH Claude Desktop is likely to use. If it cannot start the server, put that absolute path in "command" and add "PATH" (the directory of node) to env.`);
  }
  lines.push("", "Claude Code:", claudeCode, "", verdict(ok));
  return { ok, text: lines.join("\n"), json };
}
