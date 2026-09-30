import { realpathSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, basename, join, relative, isAbsolute, sep, delimiter } from "node:path";

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
];
const ABS_DENY = ["/etc", "/private/etc", "/var/root"];
const NAME_DENY = [/^\.env(\..*)?$/, /^id_rsa/, /^id_ed25519/, /\.pem$/, /\.p12$/, /\.pfx$/, /\.keychain/];

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
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
      const real = realpathSync(cur);
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
  if (nameDenied(name)) return true;
  const lexical = resolve(fullPath);
  const real = realResolve(lexical);
  for (const d of denied) if (isInside(d, real) || isInside(d, lexical)) return true;
  return false;
}

/**
 * `scan: true` is for operations that READ a directory recursively (sync plan, folder upload): the target must
 * not contain a protected location either. Leave it off for write destinations such as download folders.
 */
export function assertLocalPathAllowed(absPath: string, opts: { scan?: boolean } = {}): void {
  const lexical = resolve(absPath);
  const real = realResolve(lexical);

  const roots = rootsEnv();
  if (roots.length > 0) {
    const ok = roots.some((r) => isInside(realResolve(r), real));
    if (!ok) {
      throw new Error(
        `local path is outside PROTON_DRIVE_LOCAL_ROOT: ${absPath}`
      );
    }
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
  if (opts.scan && isDirectory(real)) {
    for (const d of denied) {
      if (isInside(real, d) || isInside(lexical, d)) {
        throw new Error(
          `local folder contains protected locations and cannot be scanned: ${absPath}; pick a subfolder ` +
            `(set PROTON_DRIVE_LOCAL_ROOT to allow specific folders, or PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 to disable this check)`
        );
      }
    }
  }
}

function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
