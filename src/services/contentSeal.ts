import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, readSync, writeSync } from "node:fs";
import { openPrivateRead, TooLargeError } from "./walkIndex.js";

/**
 * Authenticated encryption container for the content index (PROTON_DRIVE_CONTENT_INDEX=1).
 *
 *   file   = header , chunk*
 *   header = "PDCI" , version(1) , sha256(account fingerprint)(32)
 *   chunk  = ciphertext length(4, BE) , nonce(12, random per chunk) , ciphertext , GCM tag(16)
 *
 * Each chunk is AES-256-GCM with AAD = header , chunk index(4) , final flag(1). The index binds a chunk to its
 * position and the flag marks the last one, so reordering, dropping or appending chunks and cutting the file short all
 * fail authentication. Chunks of at most CHUNK_BYTES are encrypted and written one by one, so neither a whole
 * plaintext nor a whole ciphertext copy is ever in memory. Any problem throws ContentIndexError; nothing is returned
 * from a file that did not verify completely.
 */
export class ContentIndexError extends Error {}

export const SEAL_VERSION = 1;
export const CHUNK_BYTES = 1 << 20;
const MAGIC = Buffer.from("PDCI");
const HEADER_BYTES = MAGIC.length + 1 + 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FILE_NAME = "content-index.enc";
export const SEALED_FILE_NAME = FILE_NAME;

/** What goes in the header (and the AAD) for an account. */
export const accountDigest = (fingerprint: string): Buffer => createHash("sha256").update(fingerprint).digest();

const makeHeader = (digest: Buffer): Buffer => Buffer.concat([MAGIC, Buffer.from([SEAL_VERSION]), digest]);

function aad(header: Buffer, index: number, final: boolean): Buffer {
  const tail = Buffer.alloc(5);
  tail.writeUInt32BE(index, 0);
  tail[4] = final ? 1 : 0;
  return Buffer.concat([header, tail]);
}

/** Buffers plaintext and writes it as encrypted chunks to `fd`; the last chunk (possibly empty) is written by finish(). */
export class SealedWriter {
  private parts: Buffer[] = [];
  private pending = 0;
  private index = 0;
  private written = 0;
  private readonly header: Buffer;

  constructor(private readonly fd: number, private readonly key: Buffer, digest: Buffer, private readonly maxBytes: number) {
    this.header = makeHeader(digest);
    this.out(this.header);
  }

  private out(b: Buffer): void {
    this.written += b.length;
    if (this.written > this.maxBytes) throw new TooLargeError(`content index would exceed ${this.maxBytes} bytes`);
    let off = 0;
    while (off < b.length) off += writeSync(this.fd, b, off, b.length - off);
  }

  private take(n: number): Buffer {
    const all = Buffer.concat(this.parts);
    this.parts = all.length > n ? [all.subarray(n)] : [];
    this.pending = all.length - Math.min(n, all.length);
    return all.subarray(0, n);
  }

  private emit(plain: Buffer, final: boolean): void {
    const nonce = randomBytes(NONCE_BYTES);
    const c = createCipheriv("aes-256-gcm", this.key, nonce);
    c.setAAD(aad(this.header, this.index++, final));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(ct.length, 0);
    this.out(Buffer.concat([len, nonce, ct, c.getAuthTag()]));
  }

  write(s: string | Buffer): void {
    const b = typeof s === "string" ? Buffer.from(s, "utf8") : s;
    this.parts.push(b);
    this.pending += b.length;
    while (this.pending > CHUNK_BYTES) this.emit(this.take(CHUNK_BYTES), false);
  }

  finish(): void {
    this.emit(Buffer.concat(this.parts), true);
    this.parts = [];
    this.pending = 0;
  }
}

function readAt(fd: number, n: number, pos: number, what: string): Buffer {
  const b = Buffer.alloc(n);
  let got = 0;
  while (got < n) {
    const r = readSync(fd, b, got, n - got, pos + got);
    if (r === 0) throw new ContentIndexError(`The content index is truncated (${what}). Clear it and update again.`);
    got += r;
  }
  return b;
}

/** Account digest stored in the header, without decrypting anything. undefined = no index file. */
export function readSealedAccount(maxBytes: number): Buffer | undefined {
  const f = openFile(maxBytes);
  if (!f) return undefined;
  try { return parseHeader(f.fd).digest; } finally { closeSync(f.fd); }
}

function openFile(maxBytes: number): { fd: number; size: number } | undefined {
  try {
    return openPrivateRead(FILE_NAME, maxBytes);
  } catch (err) {
    throw new ContentIndexError(`The content index cannot be used: ${err instanceof Error ? err.message : String(err)}. Clear it (drive_content_index action "clear") and update again.`);
  }
}

function parseHeader(fd: number): { header: Buffer; digest: Buffer } {
  const header = readAt(fd, HEADER_BYTES, 0, "header");
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new ContentIndexError("The content index file is not in the expected format. Clear it and update again.");
  if (header[MAGIC.length] !== SEAL_VERSION) throw new ContentIndexError(`The content index has format version ${header[MAGIC.length]}, this server reads version ${SEAL_VERSION}. Clear it and update again.`);
  return { header, digest: header.subarray(MAGIC.length + 1) };
}

/**
 * Decrypts the whole file, passing each verified chunk to `onPlain` in order. Throws ContentIndexError on a wrong key,
 * a modified, reordered or truncated file, trailing bytes, or another account's digest; the caller must then discard
 * whatever it built from earlier chunks. Returns false when there is no file.
 */
export function readSealed(key: Buffer, expectDigest: Buffer, maxBytes: number, onPlain: (chunk: Buffer) => void): boolean {
  const f = openFile(maxBytes);
  if (!f) return false;
  try {
    const { header, digest } = parseHeader(f.fd);
    if (digest.length !== expectDigest.length || !timingSafeEqual(digest, expectDigest)) {
      throw new ContentIndexError("The content index belongs to another Proton account. Clear it (drive_content_index action \"clear\") and update again.");
    }
    let pos = HEADER_BYTES;
    for (let index = 0; ; index++) {
      const len = readAt(f.fd, 4, pos, "chunk header").readUInt32BE(0);
      if (len > CHUNK_BYTES) throw new ContentIndexError("The content index is corrupt (oversized chunk). Clear it and update again.");
      const body = readAt(f.fd, NONCE_BYTES + len + TAG_BYTES, pos + 4, "chunk");
      pos += 4 + body.length;
      const isLast = pos === f.size; // anything after a final chunk makes the flag (in the AAD) fail
      let plain: Buffer;
      try {
        const d = createDecipheriv("aes-256-gcm", key, body.subarray(0, NONCE_BYTES));
        d.setAAD(aad(header, index, isLast));
        d.setAuthTag(body.subarray(NONCE_BYTES + len));
        plain = Buffer.concat([d.update(body.subarray(NONCE_BYTES, NONCE_BYTES + len)), d.final()]);
      } catch {
        throw new ContentIndexError("The content index could not be decrypted: the key is wrong or the file was modified. It was not read. Clear it (drive_content_index action \"clear\") and update again, or restore the right key.");
      }
      onPlain(plain);
      if (isLast) return true;
    }
  } finally {
    closeSync(f.fd);
  }
}
