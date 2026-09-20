import { realpathSync, lstatSync, readlinkSync } from "node:fs";
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
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
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

export function assertLocalPathAllowed(absPath: string): void {
  const lexical = resolve(absPath);
  const real = realResolve(lexical);

  const rootsEnv = process.env["PROTON_DRIVE_LOCAL_ROOT"];
  const roots = rootsEnv ? rootsEnv.split(delimiter).filter((r) => r.trim() !== "") : [];
  if (roots.length > 0) {
    const ok = roots.some((r) => isInside(realResolve(r), real));
    if (!ok) {
      throw new Error(
        `local path is outside PROTON_DRIVE_LOCAL_ROOT: ${absPath}`
      );
    }
    return;
  }

  if (process.env["PROTON_DRIVE_ALLOW_SENSITIVE_PATHS"] === "1") return;

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
  for (const d of denied) {
    if (isInside(d, real) || isInside(d, lexical)) {
      throw new Error(
        `local path is in a protected location and cannot be used: ${absPath} ` +
          `(set PROTON_DRIVE_LOCAL_ROOT to allow specific folders, or PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 to disable this check)`
      );
    }
  }
  for (const name of [basename(lexical), basename(real)]) {
    const lower = name.toLowerCase();
    if (NAME_DENY.some((re) => re.test(lower))) {
      throw new Error(
        `local path looks like a credential/secret file and cannot be used: ${absPath} ` +
          `(set PROTON_DRIVE_ALLOW_SENSITIVE_PATHS=1 to disable this check)`
      );
    }
  }
}
