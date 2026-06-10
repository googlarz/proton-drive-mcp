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
