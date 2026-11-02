import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
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

/** npx runs packages from a cache that gets pruned; a config pointing there breaks later. */
export function isEphemeralInstall(p: string): boolean {
  return /[\\/]_npx[\\/]/.test(p);
}

export function buildEntry(cliPath: string, syncPath?: string): McpEntry {
  const entryPath = serverEntryPath();
  if (isEphemeralInstall(entryPath)) {
    throw new Error(`${entryPath} is in a temporary npx cache and would stop working once the cache is pruned. Install it first (npm install -g proton-drive-mcp) and run proton-drive-cli from there.`);
  }
  const env: Record<string, string> = { PROTON_DRIVE_BIN: cliPath };
  if (syncPath) env["PROTON_DRIVE_SYNC_PATH"] = syncPath;
  return { command: process.execPath, args: [entryPath], env };
}

/** Entry for the `npx -y proton-drive-mcp` form: nothing is pinned to an install or cache path, except the CLI. */
export function buildNpxEntry(cliPath: string): McpEntry {
  return { command: "npx", args: ["-y", "proton-drive-mcp"], env: { PROTON_DRIVE_BIN: cliPath } };
}

export function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, "0")}`;
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

// `proton-drive-mcp` or `proton-drive-mcp@<version>` as one argument (npx form), or a package directory in a path (global install).
const PACKAGE_SPEC = /^proton-drive-mcp(@\S+)?$/;
const PACKAGE_DIR = /(^|[\\/])proton-drive-mcp[\\/]dist[\\/]/;

/** True for a server entry that starts this package: command `proton-drive-mcp`, or an argument naming it exactly (not a substring such as `proton-drive-mcp-notes`). */
export function looksLikeOurServer(entry: unknown): boolean {
  const e = entry as { command?: unknown; args?: unknown } | null;
  if (typeof e?.command === "string" && basename(e.command) === SERVER_KEY) return true;
  return Array.isArray(e?.args) && e.args.some((x) => typeof x === "string" && (PACKAGE_SPEC.test(x) || PACKAGE_DIR.test(x)));
}

/** The key our server is registered under: "proton-drive-mcp" if present, else the first entry that looks like it. */
export function findOwnServerKey(servers: Record<string, unknown>): string | undefined {
  return SERVER_KEY in servers ? SERVER_KEY : Object.keys(servers).find((k) => looksLikeOurServer(servers[k]));
}

export interface NpxPlan {
  state: "no-file" | "absent" | "same" | "different" | "other-key";
  /** What gets written: the npx form, PROTON_DRIVE_BIN set, every other key and field of an existing entry kept. */
  entry: McpEntry;
  /** Names (never values) of the env keys of an existing entry that are kept. */
  preservedEnvKeys: string[];
  /** The existing entry is the pinned install written by setup-claude-desktop (node + this package's dist/index.js). */
  fromPinned: boolean;
  /** A version pin (`proton-drive-mcp@1.8.0`) in the existing args that the npx form drops in favour of the latest. */
  droppedVersionPin?: string;
  /** Things in the existing entry other than command, args and env that matter: `disabled: true`, a `cwd`. Values are never included. */
  notes: string[];
  /** Keys other than "proton-drive-mcp" under which this package is already registered. */
  otherKeys: string[];
  /** An entry already exists under "proton-drive-mcp". */
  hasOwnKey: boolean;
}

/**
 * What `init` would do to the config at `file`. An existing entry is compared on command, args and PROTON_DRIVE_BIN only
 * (an absolute path to an existing `npx` is a valid command and is kept), and replacing it overrides just those:
 * all other env keys (mode, roots, audit log, sync path, ...) and fields survive. Throws like writeEntry on an unusable file.
 */
export function planNpxEntry(file: string, cliPath: string): NpxPlan {
  const fresh = buildNpxEntry(cliPath);
  const base = { entry: fresh, preservedEnvKeys: [] as string[], fromPinned: false, notes: [] as string[], otherKeys: [] as string[], hasOwnKey: false };
  if (!existsSync(file)) return { ...base, state: "no-file" };
  const servers = parseConfig(file)["mcpServers"];
  if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
    throw new Error(`"mcpServers" in ${file} is not an object; refusing to modify it.`);
  }
  const all = (servers ?? {}) as Record<string, unknown>;
  const otherKeys = Object.keys(all).filter((k) => k !== SERVER_KEY && looksLikeOurServer(all[k]));
  const current = all[SERVER_KEY];
  if (current === undefined) return { ...base, state: otherKeys.length ? "other-key" : "absent", otherKeys };
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error(`mcpServers["${SERVER_KEY}"] in ${file} is not an object; refusing to modify it.`);
  }
  const cur = current as Record<string, unknown>;
  const curEnv = cur["env"] && typeof cur["env"] === "object" && !Array.isArray(cur["env"]) ? (cur["env"] as Record<string, unknown>) : {};
  const curCommand = typeof cur["command"] === "string" ? cur["command"] : "";
  const keepCommand = curCommand !== "npx" && basename(curCommand) === "npx" && resolveBinary(curCommand) !== undefined;
  const command = keepCommand ? curCommand : fresh.command;
  const curArgs = Array.isArray(cur["args"]) ? (cur["args"] as unknown[]) : [];
  const entry = { ...cur, command, args: fresh.args, env: { ...curEnv, PROTON_DRIVE_BIN: cliPath } } as unknown as McpEntry;
  const same = (keepCommand || curCommand === fresh.command) && JSON.stringify(cur["args"]) === JSON.stringify(fresh.args) && curEnv["PROTON_DRIVE_BIN"] === cliPath;
  const pin = curArgs.find((x): x is string => typeof x === "string" && /^proton-drive-mcp@\S+$/.test(x) && x !== "proton-drive-mcp@latest");
  const notes: string[] = [];
  if (cur["disabled"] === true) notes.push('the existing entry has "disabled": true (kept), so Claude Desktop will not start it until you enable it');
  if ("cwd" in cur) notes.push('the existing entry has a "cwd" field (kept); the npx form does not need one');
  return {
    state: otherKeys.length ? "other-key" : same ? "same" : "different",
    entry,
    preservedEnvKeys: Object.keys(curEnv).filter((k) => k !== "PROTON_DRIVE_BIN"),
    fromPinned: !keepCommand && curCommand !== fresh.command && curArgs.some((x) => typeof x === "string" && /[\\/]dist[\\/]index\.js$/.test(x)),
    ...(pin ? { droppedVersionPin: pin } : {}),
    notes,
    otherKeys,
    hasOwnKey: true,
  };
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
  const target = exists ? realpathSync(file) : file;
  if (exists && JSON.stringify((servers as Record<string, unknown> | undefined)?.[SERVER_KEY]) === JSON.stringify(entry)) return undefined;
  let backup: string | undefined;
  if (exists) {
    backup = `${target}.bak-${timestamp()}`;
    copyFileSync(target, backup, constants.COPYFILE_EXCL);
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }
  config["mcpServers"] = { ...(servers as Record<string, unknown> | undefined), [SERVER_KEY]: entry };
  // Write beside the target and rename, so a crash or a concurrent reader never sees a truncated config.
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: exists ? statSync(target).mode & 0o777 : 0o600 });
  renameSync(tmp, target);

  const written = (parseConfig(file)["mcpServers"] as Record<string, unknown>)[SERVER_KEY];
  if (JSON.stringify(written) !== JSON.stringify(entry)) throw new Error(`Verification failed: ${file} does not contain the expected entry.`);
  return backup;
}
