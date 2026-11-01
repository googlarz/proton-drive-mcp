import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { platform as osPlatform } from "node:os";

/**
 * The 32-byte key of the encrypted content index. Where it lives, in order:
 *   1. PROTON_DRIVE_CONTENT_INDEX_KEY (64 hex characters), if set: used exclusively, no keychain is touched.
 *   2. macOS Keychain via /usr/bin/security, Linux Secret Service via secret-tool.
 * Otherwise (Windows, no secret-tool, no keychain session) it refuses with a message saying what to set. A key is never
 * written to a file, and never passed in an argument list: `security -i` reads its commands from stdin and
 * `secret-tool store` reads the secret from stdin, so `ps` shows neither.
 */
export type KeyBackend = "env" | "macos-keychain" | "secret-tool";
export class ContentKeyError extends Error {}

export const KEY_ENV = "PROTON_DRIVE_CONTENT_INDEX_KEY";
const DEFAULT_SERVICE = "proton-drive-mcp-content-index";
const TIMEOUT_MS = 30_000; // a keychain unlock prompt can wait for the person

export interface KeyDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  securityBin?: string;
  secretToolBin?: string;
}

function serviceName(env: NodeJS.ProcessEnv): string {
  const s = env["PROTON_DRIVE_KEYCHAIN_SERVICE"]?.trim() || DEFAULT_SERVICE;
  // The name is typed into `security -i`'s stdin, where a space, quote or newline would change the command.
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(s)) throw new ContentKeyError("PROTON_DRIVE_KEYCHAIN_SERVICE may only contain letters, digits, '.', '_' and '-' (max 100).");
  return s;
}

function envKey(env: NodeJS.ProcessEnv): Buffer | undefined {
  const raw = env[KEY_ENV];
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(raw.trim())) throw new ContentKeyError(`${KEY_ENV} must be exactly 64 hex characters (32 bytes), e.g. from \`openssl rand -hex 32\`.`);
  return Buffer.from(raw.trim(), "hex");
}

interface Run { code: number | string | null; stdout: string; stderr: string }

function run(bin: string, args: string[], stdin?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
      const code = err ? ((err as { code?: number | string }).code ?? 1) : 0;
      resolve({ code, stdout, stderr });
    });
    child.stdin?.on("error", () => { /* the process exited before reading; its exit code says why */ });
    child.stdin?.end(stdin);
  });
}

const parseHexKey = (s: string): Buffer | undefined => (/^[0-9a-f]{64}$/i.test(s.trim()) ? Buffer.from(s.trim(), "hex") : undefined);

async function macGet(bin: string, svc: string, acct: string): Promise<Buffer | undefined> {
  const r = await run(bin, ["find-generic-password", "-s", svc, "-a", acct, "-w"]);
  if (r.code === 0) {
    const k = parseHexKey(r.stdout);
    if (!k) throw new ContentKeyError("The keychain item for the content index does not hold a valid key. Delete it with `security delete-generic-password` and clear the index.");
    return k;
  }
  if (r.code === 44 || /could not be found/i.test(r.stderr)) return undefined; // errSecItemNotFound
  throw new ContentKeyError(`The macOS Keychain refused or failed to return the content index key (${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}). Unlock the keychain and allow access, or set ${KEY_ENV}.`);
}

async function macSet(bin: string, svc: string, acct: string, hex: string): Promise<void> {
  // `-i` takes commands from stdin, so the secret never appears in the argument list. svc/acct are restricted to a safe charset.
  const r = await run(bin, ["-i"], `add-generic-password -s ${svc} -a ${acct} -l ${svc} -w ${hex}\n`);
  // Whatever the exit code says, the caller reads the item back to be sure it was stored (and to adopt a racing process's key).
  if (r.code !== 0) throw new ContentKeyError(`Could not store the content index key in the macOS Keychain (exit ${r.code}). Set ${KEY_ENV} instead.`);
}

async function linuxGet(bin: string, svc: string, acct: string): Promise<Buffer | undefined> {
  const r = await run(bin, ["lookup", "service", svc, "account", acct]);
  if (r.code === 0 && r.stdout.trim() !== "") {
    const k = parseHexKey(r.stdout);
    if (!k) throw new ContentKeyError("The Secret Service entry for the content index does not hold a valid key. Remove it with `secret-tool clear` and clear the index.");
    return k;
  }
  if (r.code === 0 || r.code === 1) return undefined; // not found
  throw new ContentKeyError(`secret-tool failed (exit ${r.code}: ${r.stderr.trim().split("\n")[0]}). Set ${KEY_ENV} instead.`);
}

async function linuxSet(bin: string, svc: string, acct: string, hex: string): Promise<void> {
  const r = await run(bin, ["store", `--label=${svc}`, "service", svc, "account", acct], hex);
  if (r.code !== 0) throw new ContentKeyError(`secret-tool could not store the content index key (exit ${r.code}: ${r.stderr.trim().split("\n")[0]}). Set ${KEY_ENV} instead.`);
}

const noBackend = (why: string) =>
  new ContentKeyError(`No safe place to keep the content index key: ${why}. Set ${KEY_ENV} to 64 hex characters (\`openssl rand -hex 32\`) in the server's environment, or use macOS / Linux with secret-tool.`);

/** Backend this process would use, without touching it. */
export function plannedBackend(deps: KeyDeps = {}): KeyBackend | "none" {
  const env = deps.env ?? process.env;
  if ((env[KEY_ENV] ?? "").trim() !== "") return "env";
  const p = deps.platform ?? osPlatform();
  return p === "darwin" ? "macos-keychain" : p === "linux" ? "secret-tool" : "none";
}

/**
 * The key for the index of account `acct` (32 hex characters derived from the account fingerprint). With create: false a missing key returns undefined (nothing was ever encrypted);
 * with create: true a missing key is generated and stored, then read back, so two processes racing end up with the stored one.
 */
export async function getContentKey(acct: string, o: { create: boolean } & KeyDeps): Promise<{ key: Buffer; backend: KeyBackend } | undefined> {
  const env = o.env ?? process.env;
  const fromEnv = envKey(env);
  if (fromEnv) return { key: fromEnv, backend: "env" };
  const p = o.platform ?? osPlatform();
  if (p !== "darwin" && p !== "linux") throw noBackend(`${p} has no supported keychain integration`);
  const svc = serviceName(env);
  // acct is typed into `security -i`'s stdin: hex only, so it can never change the command.
  if (!/^[0-9a-f]{32}$/.test(acct)) throw new ContentKeyError("internal error: bad keychain account name");
  const mac = p === "darwin";
  const bin = mac ? (o.securityBin ?? "/usr/bin/security") : (o.secretToolBin ?? "secret-tool");
  const get = mac ? macGet : linuxGet;
  const set = mac ? macSet : linuxSet;
  const backend: KeyBackend = mac ? "macos-keychain" : "secret-tool";
  try {
    let key = await get(bin, svc, acct);
    if (!key && o.create) {
      await set(bin, svc, acct, randomBytes(32).toString("hex")).catch(() => { /* a racing process may have stored one; the read-back decides */ });
      key = await get(bin, svc, acct);
      if (!key) throw new ContentKeyError(`The content index key could not be stored in the ${mac ? "macOS Keychain" : "Secret Service"}. Set ${KEY_ENV} instead.`);
    }
    return key ? { key, backend } : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw noBackend(`${bin} was not found`);
    throw err;
  }
}
