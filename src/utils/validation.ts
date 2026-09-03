import { isAbsolute } from "node:path";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Control chars: 0x00-0x1F, DEL (0x7F), Unicode separators U+2028 and U+2029.
const CONTROL_RE = new RegExp("[\\x00-\\x1f\\x7f\\u2028\\u2029]");

export function validatePath(path: unknown): string {
  const p = String(path ?? "").trim();
  if (!p) throw new Error("path must not be empty");
  if (p.startsWith("-")) throw new Error(`path must not start with '-': ${p}`);
  if (CONTROL_RE.test(p)) throw new Error("path contains control characters");
  if (p.split("/").some((seg) => seg === ".." || seg === ".")) throw new Error(`path must not contain '.' or '..' segments: ${p}`);
  return p;
}

export function validateRemotePath(path: unknown): string {
  const p = validatePath(path);
  if (!p.startsWith("/")) throw new Error(`remote path must be absolute (start with '/'): ${p}`);
  return p;
}

export function validateMessage(message: unknown): string {
  const m = String(message ?? "").trim();
  if (m.startsWith("-")) throw new Error(`message must not start with '-': ${m}`);
  if (CONTROL_RE.test(m)) throw new Error("message contains control characters");
  if (m.length > 2000) throw new Error("message must be 2000 characters or fewer");
  return m;
}

// For bare filename/name arguments passed as a positional CLI arg (not a
// path) — e.g. rename's newName, album create/update's name. Guards against
// flag injection the same way validatePath/validateEmail/validateMessage do.
//
// Also rejects '/': confirmed live that renaming a file to a name containing
// '/' (e.g. "evil/nested.txt") succeeds on the CLI side, but the resulting
// item's actual Drive name contains the slash literally — it is not two path
// segments. Every other tool computes this item's path by joining parent +
// name (see list()), producing a path that LOOKS like a nested folder but
// isn't, and that path then fails to resolve ("Node not found") in every
// other tool (info, download, move, delete, ...). The item becomes
// unreachable except by listing its real parent and matching by prefix.
export function validateName(name: unknown): string {
  const n = String(name ?? "").trim();
  if (!n) throw new Error("name must not be empty");
  if (n.startsWith("-")) throw new Error(`name must not start with '-': ${n}`);
  if (n.includes("/")) throw new Error(`name must not contain '/': ${n}`);
  if (CONTROL_RE.test(n)) throw new Error("name contains control characters");
  return n;
}

// Guards a value passed to a bare CLI flag (e.g. --password, --expiration)
// against flag injection — confirmed live: `sharing set-url --password "-x"`
// makes the real CLI's arg parser treat "-x" as an unknown flag and print
// usage instead of setting the password. Unlike validateName, allows '/'
// since these aren't Drive item names.
export function validateFlagValue(value: unknown, label: string): string {
  const v = String(value ?? "").trim();
  if (v.startsWith("-")) throw new Error(`${label} must not start with '-': ${v}`);
  if (CONTROL_RE.test(v)) throw new Error(`${label} contains control characters`);
  return v;
}

export function validateLocalPath(path: unknown): string {
  const p = validatePath(path);
  if (!isAbsolute(p)) throw new Error(`local path must be absolute: ${p}`);
  return p;
}

export function validateEmail(email: unknown): string {
  const e = String(email ?? "").trim();
  if (e.startsWith("-")) throw new Error(`email must not start with '-': ${e}`);
  if (CONTROL_RE.test(e)) throw new Error("email contains control characters");
  if (!EMAIL_RE.test(e)) throw new Error(`invalid email address: ${e}`);
  return e;
}
