const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validatePath(path: unknown): string {
  const p = String(path ?? "").trim();
  if (!p) throw new Error("path must not be empty");
  if (p.startsWith("-")) throw new Error(`path must not start with '-': ${p}`);
  if (/[\x00-\x1f]/.test(p)) throw new Error("path contains control characters");
  if (p.includes("..")) throw new Error(`path must not contain '..' segments: ${p}`);
  return p;
}

export function validateMessage(message: unknown): string {
  const m = String(message ?? "").trim();
  if (m.startsWith("-")) throw new Error(`message must not start with '-': ${m}`);
  return m;
}

export function validateEmail(email: unknown): string {
  const e = String(email ?? "").trim();
  if (e.startsWith("-")) throw new Error(`email must not start with '-': ${e}`);
  if (/[\x00-\x1f]/.test(e)) throw new Error("email contains control characters");
  if (!EMAIL_RE.test(e)) throw new Error(`invalid email address: ${e}`);
  return e;
}
