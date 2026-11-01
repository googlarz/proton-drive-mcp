import { deflateSync, inflateSync } from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import { ContentIndexError } from "./contentSeal.js";

// In-memory inverted index for the encrypted content index: tokenizer, document table, postings, BM25 ranking,
// snippets, and the line-based plaintext that contentSeal encrypts chunk by chunk.

export const MIN_TOKEN = 2;
export const MAX_TOKEN = 40;
/** A hostile file with a million distinct tokens must not bloat the index: only the first MAX_TERMS_PER_DOC are kept. */
export const MAX_TERMS_PER_DOC = 20_000;
export const EXCERPT_BYTES = 64 * 1024;
export const SNIPPET_CHARS = 200;
const DATA_VERSION = 1;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const MAX_PREFIX_EXPANSION = 500;

const TOKEN = /[\p{L}\p{N}]+/gu;
const norm = (s: string) => s.normalize("NFKC").toLowerCase();

/** Lowercased letter/digit runs of 2 to 40 characters. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of norm(text).matchAll(TOKEN)) if (m[0].length >= MIN_TOKEN && m[0].length <= MAX_TOKEN) out.push(m[0]);
  return out;
}

/** term -> occurrences, plus the total token count (for BM25 length normalisation). */
export function termFrequencies(text: string): { tf: Map<string, number>; tokens: number } {
  const tf = new Map<string, number>();
  let tokens = 0;
  for (const t of tokenize(text)) {
    tokens++;
    const n = tf.get(t);
    if (n !== undefined) tf.set(t, n + 1);
    else if (tf.size < MAX_TERMS_PER_DOC) tf.set(t, 1);
  }
  return { tf, tokens };
}

export function makeExcerpt(text: string): Buffer {
  let b = Buffer.from(text.slice(0, EXCERPT_BYTES), "utf8");
  if (b.length > EXCERPT_BYTES) b = b.subarray(0, EXCERPT_BYTES);
  return deflateSync(Buffer.from(b.toString("utf8").replace(/�+$/, ""), "utf8"));
}

export interface DocRec {
  path: string;
  size?: number;
  mtime?: string;
  /** Change detection: size|mtime|sha1 as listed by the walk. */
  sig: string;
  at: number;
  tokens: number;
  /** Why no text was indexed (unsupported type, no text layer, too large ...). */
  skipped?: string;
  excerpt?: Buffer;
  /** Estimated bytes this document adds to the file; keeps the size cap check cheap. */
  bytes: number;
}
export interface FolderRec { updatedAt: number; complete: boolean }

export class ContentData {
  created = Date.now();
  folders: Record<string, FolderRec> = {};
  docs = new Map<number, DocRec>();
  /** term -> [docId, tf, docId, tf, ...] */
  postings = new Map<string, number[]>();
  nextId = 1;
  bytes = 0;

  addDoc(rec: Omit<DocRec, "bytes">, tf?: Map<string, number>): number {
    const id = this.nextId++;
    // A new term costs its JSON line ({"k":"term","t":..,"p":[..]}, about 30 bytes of framing) plus the term itself; a term already in the index only adds a posting pair.
    let termBytes = 0;
    if (tf) for (const t of tf.keys()) termBytes += this.postings.has(t) ? 8 : 30 + t.length;
    const bytes = 200 + rec.path.length + (rec.skipped?.length ?? 0) + Math.ceil((rec.excerpt?.length ?? 0) * 1.4) + termBytes;
    this.docs.set(id, { ...rec, bytes });
    this.bytes += bytes;
    if (tf) for (const [t, n] of tf) {
      const p = this.postings.get(t);
      if (p) p.push(id, n);
      else this.postings.set(t, [id, n]);
    }
    return id;
  }

  /** One pass over all postings, however many documents go. */
  removeDocs(ids: Set<number>): void {
    if (ids.size === 0) return;
    for (const id of ids) {
      const d = this.docs.get(id);
      if (d) this.bytes -= d.bytes;
      this.docs.delete(id);
    }
    for (const [t, p] of this.postings) {
      let w = 0;
      for (let i = 0; i < p.length; i += 2) if (!ids.has(p[i]!)) { p[w++] = p[i]!; p[w++] = p[i + 1]!; }
      if (w === 0) this.postings.delete(t);
      else p.length = w;
    }
  }

  idByPath(): Map<string, number> {
    const m = new Map<string, number>();
    for (const [id, d] of this.docs) m.set(d.path, id);
    return m;
  }
}

// ---- plaintext: JSON lines -----------------------------------------------------------------------------------------

/** meta line, one line per document, one line per term. `emit` receives each line with its newline. */
export function serializeData(d: ContentData, emit: (s: string) => void): void {
  emit(JSON.stringify({ k: "meta", v: DATA_VERSION, created: d.created, next: d.nextId, folders: d.folders }) + "\n");
  for (const [id, r] of d.docs) {
    emit(JSON.stringify({ k: "doc", id, p: r.path, s: r.size, m: r.mtime, g: r.sig, at: r.at, n: r.tokens, x: r.skipped, e: r.excerpt?.toString("base64"), b: r.bytes }) + "\n");
  }
  for (const [t, p] of d.postings) emit(JSON.stringify({ k: "term", t, p }) + "\n");
}

const corrupt = (why: string) => new ContentIndexError(`The content index is corrupt (${why}). Clear it and update again.`);
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
const optStr = (x: unknown) => (x === undefined || typeof x === "string");

/** Feeds decrypted chunks in order; call finish() after the last one. Throws ContentIndexError on any malformed line. */
export class DataLoader {
  private readonly data = new ContentData();
  private readonly dec = new StringDecoder("utf8");
  private carry = "";
  private sawMeta = false;

  push(chunk: Buffer): void {
    const text = this.carry + this.dec.write(chunk);
    const lines = text.split("\n");
    this.carry = lines.pop()!;
    for (const l of lines) if (l !== "") this.line(l);
  }

  finish(): ContentData {
    if (this.carry + this.dec.end() !== "") throw corrupt("unterminated line");
    if (!this.sawMeta) throw corrupt("no header");
    return this.data;
  }

  private line(l: string): void {
    let o: any;
    try { o = JSON.parse(l); } catch { throw corrupt("unparseable line"); }
    const d = this.data;
    if (!this.sawMeta) {
      if (o?.k !== "meta" || o.v !== DATA_VERSION) throw corrupt("unknown version");
      if (!isInt(o.next) || typeof o.created !== "number" || !o.folders || typeof o.folders !== "object") throw corrupt("bad header");
      d.created = o.created;
      d.nextId = o.next;
      d.folders = o.folders;
      this.sawMeta = true;
    } else if (o?.k === "doc") {
      if (!isInt(o.id) || typeof o.p !== "string" || typeof o.g !== "string" || !isInt(o.at) || !isInt(o.n) || !isInt(o.b) || !optStr(o.m) || !optStr(o.x) || !optStr(o.e) || (o.s !== undefined && !isInt(o.s)) || d.docs.has(o.id)) throw corrupt("bad document");
      d.docs.set(o.id, { path: o.p, size: o.s, mtime: o.m, sig: o.g, at: o.at, tokens: o.n, skipped: o.x, excerpt: o.e === undefined ? undefined : Buffer.from(o.e, "base64"), bytes: o.b });
      d.bytes += o.b;
    } else if (o?.k === "term") {
      if (typeof o.t !== "string" || !Array.isArray(o.p) || o.p.length % 2 !== 0 || !o.p.every(isInt)) throw corrupt("bad term");
      d.postings.set(o.t, o.p);
    } else throw corrupt("unknown record");
  }
}

// ---- query and ranking -------------------------------------------------------------------------------------------

export interface ParsedQuery { terms: string[]; prefix?: string }

/** A trailing `*` after the last word makes it a prefix (`invoi*`). Throws when nothing searchable is left. */
export function parseQuery(q: string): ParsedQuery {
  const star = /([\p{L}\p{N}]+)\s*\*\s*$/u.exec(q);
  const prefix = star ? norm(star[1]!) : undefined;
  if (prefix !== undefined && (prefix.length < MIN_TOKEN || prefix.length > MAX_TOKEN)) throw new Error(`A prefix needs ${MIN_TOKEN} to ${MAX_TOKEN} characters before the *.`);
  const terms = [...new Set(tokenize(star ? q.slice(0, star.index) : q))].filter((t) => t !== prefix);
  if (terms.length === 0 && prefix === undefined) throw new Error(`The query has no searchable words (words are letters or digits, ${MIN_TOKEN} to ${MAX_TOKEN} characters long).`);
  return prefix === undefined ? { terms } : { terms, prefix };
}

export interface Hit { id: number; path: string; score: number; at: number }

/** AND over all terms (the prefix, if any, matches any term starting with it); BM25 with k1=1.2, b=0.75. */
export function searchData(d: ContentData, q: ParsedQuery, o: { limit: number; filter?: (path: string) => boolean }): { hits: Hit[]; total: number; snippetTerms: string[] } {
  const sets: { term: string; m: Map<number, number> }[] = [];
  const asMap = (p: number[] | undefined, into = new Map<number, number>()) => {
    if (p) for (let i = 0; i < p.length; i += 2) into.set(p[i]!, (into.get(p[i]!) ?? 0) + p[i + 1]!);
    return into;
  };
  for (const t of q.terms) sets.push({ term: t, m: asMap(d.postings.get(t)) });
  if (q.prefix) {
    const m = new Map<number, number>();
    let n = 0;
    for (const [t, p] of d.postings) if (t.startsWith(q.prefix) && n++ < MAX_PREFIX_EXPANSION) asMap(p, m);
    sets.push({ term: q.prefix, m });
  }
  let nDocs = 0, sumLen = 0;
  for (const r of d.docs.values()) if (r.tokens > 0) { nDocs++; sumLen += r.tokens; }
  const avg = nDocs ? sumLen / nDocs : 1;
  sets.sort((a, b) => a.m.size - b.m.size);
  const idf = (df: number) => Math.log(1 + (nDocs - df + 0.5) / (df + 0.5));
  const hits: Hit[] = [];
  const first = sets[0]!;
  for (const [id] of first.m) {
    if (!sets.every((s) => s.m.has(id))) continue;
    const r = d.docs.get(id);
    if (!r || (o.filter && !o.filter(r.path))) continue;
    let score = 0;
    for (const s of sets) {
      const tf = s.m.get(id)!;
      score += idf(s.m.size) * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * r.tokens) / avg)));
    }
    hits.push({ id, path: r.path, score, at: r.at });
  }
  hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byIdf = [...sets].sort((a, b) => a.m.size - b.m.size).map((s) => s.term);
  return { hits: hits.slice(0, o.limit), total: hits.length, snippetTerms: byIdf };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** About SNIPPET_CHARS characters of the excerpt around the first match of the rarest matching term, whitespace collapsed. */
export function makeSnippet(excerpt: Buffer | undefined, terms: string[]): string {
  if (!excerpt) return "";
  let text: string;
  try { text = inflateSync(excerpt, { maxOutputLength: EXCERPT_BYTES * 4 }).toString("utf8"); } catch { return ""; }
  let at = 0;
  for (const t of terms) {
    const m = new RegExp(`(?<![\\p{L}\\p{N}])${esc(t)}`, "iu").exec(text);
    if (m) { at = m.index; break; }
  }
  const start = Math.max(0, at - 70);
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  const body = text.slice(start, end).replace(/[\x00-\x1f\x7f\u2028\u2029\s]+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}
