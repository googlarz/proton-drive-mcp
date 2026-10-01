// Loads the optional packages (fflate, unpdf) for tests; PDMCP_TEST_DEPS may point at a directory
// containing node_modules/ with them when they are not installed in the project.
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadOptional(name) {
  try {
    return await import(name);
  } catch (e) {
    const dir = process.env.PDMCP_TEST_DEPS;
    if (!dir) throw e;
    const req = createRequire(join(dir, "package.json"));
    const pkg = req(join(dir, "node_modules", name, "package.json"));
    const entry = typeof pkg.exports?.["."] === "object" ? (pkg.exports["."].import?.default ?? pkg.exports["."].import ?? pkg.exports["."].default) : (pkg.module ?? pkg.main);
    return import(pathToFileURL(join(dir, "node_modules", name, entry)).href);
  }
}

/**
 * `describe` option for groups that need optional packages: a skip reason when one cannot be resolved,
 * false otherwise. On CI nothing is skipped (the group runs and fails), so a plain `npm ci` can never
 * silently drop these tests.
 */
export async function skipUnlessOptional(...names) {
  if (process.env.CI) return false;
  const missing = [];
  for (const n of names) { try { await loadOptional(n); } catch { missing.push(n); } }
  return missing.length ? { skip: `optional package ${missing.join("/")} not installed` } : false;
}

let privateTmpSeq = 0;
/**
 * Point os.tmpdir() (TMPDIR) at a fresh private dir for the tests in the calling describe, so tests that
 * count or glob temp dirs only see their own. Pass the node:test `beforeEach`/`afterEach` hooks.
 */
export function usePrivateTmp(beforeEach, afterEach) {
  let prev, dir;
  beforeEach(() => { prev = process.env.TMPDIR; dir = mkdtempSync(join(realpathSync(tmpdir()), `pdmcp-private-${process.pid}-${privateTmpSeq++}-`)); process.env.TMPDIR = dir; });
  afterEach(() => { if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev; rmSync(dir, { recursive: true, force: true }); });
}

/** Minimal one-page text PDF ("text" null = a page with no text, like a scanned image-only page). */
export function makePdf(text, pages = 1) {
  const esc = (s) => s.replace(/[\\()]/g, "\\$&");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 0; i < pages; i++) {
    const stream = text === null ? "0 0 m 10 10 l S" : `BT /F1 18 Tf 72 700 Td (${esc(text)} ${i + 1}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
