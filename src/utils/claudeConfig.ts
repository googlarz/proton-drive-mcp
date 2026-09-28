import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_KEY = "proton-drive-mcp";

export interface McpEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Default Claude Desktop config location; CLAUDE_DESKTOP_CONFIG overrides it. */
export function defaultConfigPath(): string {
  const override = process.env["CLAUDE_DESKTOP_CONFIG"];
  if (override) return resolve(override);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (process.platform === "win32") return join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "Claude", "claude_desktop_config.json");
}

export function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves a command name or path to an absolute executable path, or undefined. */
export function resolveBinary(cmd: string): string | undefined {
  if (!cmd) return undefined;
  if (isAbsolute(cmd) || cmd.includes("/") || cmd.includes("\\")) {
    const abs = resolve(cmd);
    return isExecutableFile(abs) ? abs : undefined;
  }
  const exts = process.platform === "win32" ? ["", ...(process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (isExecutableFile(candidate)) return resolve(candidate);
    }
  }
  return undefined;
}

/** The proton-drive CLI the server would use: PROTON_DRIVE_BIN, else PATH lookup. */
export function resolveDriveCli(): string | undefined {
  return resolveBinary(process.env["PROTON_DRIVE_BIN"] || "proton-drive");
}

/** dist/index.js of this package, located relative to this module (not the cwd). */
export function serverEntryPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
}

export function buildEntry(cliPath: string, syncPath?: string): McpEntry {
  const env: Record<string, string> = { PROTON_DRIVE_BIN: cliPath };
  if (syncPath) env["PROTON_DRIVE_SYNC_PATH"] = syncPath;
  return { command: process.execPath, args: [serverEntryPath()], env };
}

export function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function parseConfig(file: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error(`${file} is not valid JSON; refusing to modify it. Fix or move it, then re-run.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object; refusing to modify it.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Adds/replaces only mcpServers["proton-drive-mcp"], keeping everything else.
 * Returns the backup path (undefined when the file did not exist yet).
 */
export function writeEntry(file: string, entry: McpEntry): string | undefined {
  const exists = existsSync(file);
  const config = exists ? parseConfig(file) : {};
  const servers = config["mcpServers"];
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error(`"mcpServers" in ${file} is not an object; refusing to modify it.`);
  }
  let backup: string | undefined;
  if (exists) {
    backup = `${file}.bak-${timestamp()}`;
    copyFileSync(file, backup);
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }
  config["mcpServers"] = { ...(servers as Record<string, unknown> | undefined), [SERVER_KEY]: entry };
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");

  const written = (parseConfig(file)["mcpServers"] as Record<string, unknown>)[SERVER_KEY];
  if (JSON.stringify(written) !== JSON.stringify(entry)) throw new Error(`Verification failed: ${file} does not contain the expected entry.`);
  return backup;
}
