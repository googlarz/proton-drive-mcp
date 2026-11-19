import { realpathSync, lstatSync, readlinkSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, basename, join, relative, isAbsolute, sep, delimiter } from "node:path";

import { resolveApprovalDir } from "./approvalStore.js";

const HOME_DENY = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".npmrc",
  ".netrc",
  ".pgpass",
  ".config/gcloud",
  ".claude",
  ".claude.json",
  "Library/Keychains",
  "Library/Application Support/Claude",
  // Autostart locations and shell start-up files: a file written here runs later with the user's rights.
  "Library/LaunchAgents",
  "Library/LaunchDaemons",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".zlogout",
  ".bash_logout",
];
const ABS_DENY = ["/etc", "/private/etc", "/var/root", "/Library/LaunchAgents", "/Library/LaunchDaemons"];
const MAX_TREE_ENTRIES = 200_000;
const NAME_DENY = [
  /^\.env(\..*)?$/, /^id_rsa/, /^id_ed25519/, /^id_ecdsa/, /^id_dsa/, /\.pem$/, /\.p12$/, /\.pfx$/, /\.keychain/,
  /^\.netrc$/, /^\.npmrc$/, /^\.pgpass$/, /^\.git-credentials$/,
  // gcloud credential files and folder, so a copied gcloud config is caught under any folder name
  /^credentials\.db$/, /^access_tokens\.db$/, /^application_default_credentials\.json$/, /^legacy_credentials$/,
];
// Folders that hold nothing but credentials wherever they sit: a copied ~/.ssh inside an upload folder is a credential tree.
const SECRET_DIR_NAMES = new Set([".ssh", ".aws", ".gnupg"]);
// Ordinary folders of tools that also keep one credential file in them: refuse that file (or folder), not the whole folder.
const SECRET_UNDER = new Map<string, string[]>([[".docker", ["config.json"]], [".kube", ["config"]], [".config", ["gcloud"]]]);

// macOS and Windows file systems are case-insensitive by default: ~/.SSH is ~/.ssh there, so the comparison must be too.
const fold = (p: string): string => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p);

function isInside(root: string, target: string): boolean {
  const rel = relative(fold(root), fold(target));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + sep);
}

/** realpath of the deepest existing ancestor + remaining segments; follows dangling symlinks manually. */
function realResolve(p: string, depth = 0): string {
  const rest: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      // .native returns the on-disk spelling of existing components, not the spelling the caller typed.
      const real = realpathSync.native(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // EACCES: an unreadable ancestor (e.g. /var/root) can't be resolved; keep walking up so the denylist still matches by path.
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "EACCES") throw e;
      let linkTarget: string | null = null;
      try {
        if (lstatSync(cur).isSymbolicLink()) linkTarget = readlinkSync(cur);
      } catch {
        /* not present */
      }
      if (linkTarget !== null) {
        if (depth > 16) throw new Error(`too many symlink levels: ${p}`);
        const next = resolve(dirname(cur), linkTarget);
        const base = realResolve(next, depth + 1);
        return rest.length ? join(base, ...rest.reverse()) : base;
      }
      const parent = dirname(cur);
      if (parent === cur) return rest.length ? join(cur, ...rest.reverse()) : cur;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** Protected absolute locations, or null when the denylist is off (allowlist set or PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1). */
function deniedPaths(): Set<string> | null {
  if (rootsEnv().length > 0 || process.env["PROTON_DRIVE_ALLOW_SENSITIVE_PATHS"] === "1") return null;
  const home = homedir();
  const denied = new Set<string>();
  for (const rel of HOME_DENY) {
    denied.add(resolve(home, rel));
    denied.add(realResolve(join(home, rel)));
  }
  for (const a of ABS_DENY) {
    denied.add(a);
    denied.add(realResolve(a));
  }
  return denied;
}

function rootsEnv(): string[] {
  const env = process.env["PROTON_DRIVE_LOCAL_ROOT"];
  return env ? env.split(delimiter).filter((r) => r.trim() !== "") : [];
}

const nameDenied = (name: string): boolean => NAME_DENY.some((re) => re.test(name.toLowerCase()));

/** True when a directory entry must not be read during a recursive scan (secret-file name or protected path). Always false when the denylist is off. */
export function isProtectedEntry(fullPath: string, name: string): boolean {
  const denied = deniedPaths();
  if (!denied) return false;
  const lexical = resolve(fullPath);
  return isDeniedEntry(denied, name, realResolve(lexical), lexical);
}

function isDeniedEntry(denied: Set<string>, name: string, real: string, lexical: string): boolean {
  if (nameDenied(name)) return true;
  for (const d of denied) if (isInside(d, real) || isInside(d, lexical)) return true;
  return false;
}

/**
 * Walks a folder that is about to be uploaded: no entry may have a secret name (or be a credential file inside a tool
 * folder such as .docker/config.json), and no symlink may lead out of the folder (the upload tool would read through
 * it). Protected locations inside the folder were already refused by the caller, so entries are only checked by name.
 * `realRoot` is already symlink-free.
 */
function assertTreeAllowed(realRoot: string, checkNames: boolean, label: string): void {
  const stack = [realRoot];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop() as string;
    const parentName = fold(basename(dir));
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > MAX_TREE_ENTRIES) {
        throw new Error(`local folder has more than ${MAX_TREE_ENTRIES} entries, too many to check for protected files: ${label}; pick a smaller folder`);
      }
      const full = join(dir, e.name);
      const rel = relative(realRoot, full);
      if (e.isSymbolicLink()) {
        const target = realResolve(full);
        if (!isInside(realRoot, target)) throw new Error(`local folder contains a symlink that points outside it and cannot be uploaded: ${rel} in ${label}`);
        continue;
      }
      const lower = fold(e.name);
      if (checkNames && (nameDenied(e.name) || (e.isDirectory() && SECRET_DIR_NAMES.has(lower)) || SECRET_UNDER.get(parentName)?.includes(lower))) {
        throw new Error(`local folder contains a protected or secret file and cannot be uploaded: ${rel} in ${label} (set PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 to disable this check)`);
      }
      if (e.isDirectory()) stack.push(full);
    }
  }
}

/** True when a `.versions` folder exists anywhere under `dir`. Throws when the folder is too big to finish checking (fail closed). */
function hasVersionsDir(dir: string): boolean {
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const d = stack.pop() as string;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > MAX_TREE_ENTRIES) throw new Error(`local folder has more than ${MAX_TREE_ENTRIES} entries, too many to check for .versions snapshot folders: ${dir}`);
      if (!e.isDirectory()) continue;
      if (e.name.toLowerCase() === ".versions") return true;
      stack.push(join(d, e.name));
    }
  }
  return false;
}

/**
 * The audit log and the sync folder's .versions snapshots must not be reachable through a local write destination:
 * the path may not be, or lie inside, one of them. `contains: true` is for the path an item will be written to
 * (download folder + remote name): the CLI writes everything below it, so it may not hold them either.
 */
function assertNotWriteProtected(lexical: string, real: string, absPath: string, contains: boolean): void {
  const log = process.env["PROTON_DRIVE_AUDIT_LOG"];
  if (log && isAbsolute(log)) {
    for (const f of [log, log + ".lock"]) {
      const rf = realResolve(f);
      if (isInside(rf, real) || isInside(rf, lexical)) throw new Error(`local path is the audit log and cannot be written: ${absPath}`);
      if (contains && (isInside(real, rf) || isInside(lexical, rf))) throw new Error(`the item would be written over a folder that holds the audit log, which cannot be written: ${absPath}`);
    }
  }
  // The approvals folder holds the human's yes/no records: no local write may reach it, equal it, or (for write targets) contain it.
  const approvals = realResolve(resolveApprovalDir(process.env));
  const approvalsLex = resolve(resolveApprovalDir(process.env));
  for (const a of new Set([approvals, approvalsLex])) {
    if (isInside(a, real) || isInside(a, lexical)) throw new Error(`local path is the approvals folder and cannot be written: ${absPath}`);
    if (contains && (isInside(real, a) || isInside(lexical, a))) throw new Error(`the item would be written over a folder that holds the approvals folder, which cannot be written: ${absPath}`);
  }
  const sync = process.env["PROTON_DRIVE_SYNC_PATH"];
  if (sync && isAbsolute(sync)) {
    const syncReal = realResolve(sync);
    const inSync = isInside(syncReal, real);
    if (inSync && fold(relative(syncReal, real)).split(sep).includes(".versions")) {
      throw new Error(`local path is inside a .versions snapshot folder and cannot be written: ${absPath}`);
    }
    if (contains && ((isInside(real, syncReal) && !inSync) || (inSync && isDirectory(real) && hasVersionsDir(real)))) {
      throw new Error(`the item would be written over a folder that holds a .versions snapshot folder, which cannot be written: ${absPath}`);
    }
  }
}

/** Startup check: the approvals folder must not sit inside the sync folder (it would sync to Drive and be editable with drive_write_file). */
export function assertApprovalDirUsable(dir: string, env: Record<string, string | undefined> = process.env): void {
  const sync = env["PROTON_DRIVE_SYNC_PATH"];
  if (!sync || !isAbsolute(sync)) return;
  const d = realResolve(dir);
  const s = realResolve(sync);
  if (isInside(s, d) || isInside(resolve(sync), resolve(dir))) {
    throw new Error("The approvals folder (PROTON_DRIVE_APPROVAL_DIR) must be outside PROTON_DRIVE_SYNC_PATH (the sync folder is uploaded and can be edited with drive_write_file).");
  }
}

/**
 * `scan: true` is for operations that READ a directory recursively (sync plan, folder upload): the target must
 * not contain a protected location either. `upload: true` (with `scan`) is for a folder that is handed to the CLI
 * as a whole: it is checked entry by entry (symlinks out of it, secret-file and secret-folder names). `ancestors: true` is only
 * the "contains a protected location" part, for write targets (a downloaded folder named like a parent of a protected
 * location). `writeTarget: true` (for the path an item is written to) also refuses a path that holds the audit log or a `.versions` folder of the sync folder.
 */
export function assertLocalPathAllowed(absPath: string, opts: { scan?: boolean; ancestors?: boolean; upload?: boolean; writeTarget?: boolean } = {}): void {
  const lexical = resolve(absPath);
  const real = realResolve(lexical);
  if (!opts.scan) assertNotWriteProtected(lexical, real, absPath, opts.writeTarget === true);

  const roots = rootsEnv();
  if (roots.length > 0) {
    const ok = roots.some((r) => isInside(realResolve(r), real));
    if (!ok) {
      throw new Error(
        `local path is outside PROTON_DRIVE_LOCAL_ROOT: ${absPath}`
      );
    }
    if (opts.upload && isDirectory(real)) assertTreeAllowed(real, false, absPath);
    return;
  }

  const denied = deniedPaths();
  if (!denied) return;

  for (const d of denied) {
    if (isInside(d, real) || isInside(d, lexical)) {
      throw new Error(
        `local path is in a protected location and cannot be used: ${absPath} ` +
          `(set PROTON_DRIVE_LOCAL_ROOT to allow specific folders, or PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 to disable this check)`
      );
    }
  }
  for (const name of [basename(lexical), basename(real)]) {
    if (nameDenied(name)) {
      throw new Error(
        `local path looks like a credential/secret file and cannot be used: ${absPath} ` +
          `(set PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 to disable this check)`
      );
    }
  }
  if ((opts.scan || opts.ancestors) && isDirectory(real)) {
    for (const d of denied) {
      if (isInside(real, d) || isInside(lexical, d)) {
        throw new Error(
          `local folder contains protected locations and cannot be scanned: ${absPath}; pick a subfolder ` +
            `(set PROTON_DRIVE_LOCAL_ROOT to allow specific folders, or PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 to disable this check)`
        );
      }
    }
  }
  if (opts.upload && isDirectory(real)) assertTreeAllowed(real, true, absPath);
}

function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
