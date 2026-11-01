// Opt-in local OCR (1.8.0): engine choice, argv and limits (tesseract/pdftoppm shims, no real engine needed),
// fallback rules in drive_read_content / drive_read_many, the content index, doctor, and one REAL Vision-engine group.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chooseEngines, ocrBuffer, ocrImageExt, ocrLanguages, isSparsePdfText, runOcrTool, resolveTool, OcrDeferredError, NO_ENGINE } from "../dist/services/ocr.js";
import { loadDriveText, readDriveContent, pickFormat } from "../dist/services/content.js";
import { driveReadMany } from "../dist/services/readMany.js";
import { driveContentIndex, driveSearchContent } from "../dist/services/contentIndex.js";
import { ocrCheck } from "../dist/utils/doctor.js";
import { sweepStaleTempDirs } from "../dist/utils/tempSweep.js";
import { callContext } from "../dist/utils/subprocess.js";
import { makePdf, skipUnlessOptional, usePrivateTmp } from "./helpers/optional-deps.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PNG = readFileSync(join(HERE, "fixtures", "ocr-sample.png"));
const SCAN_PDF = readFileSync(join(HERE, "fixtures", "ocr-scan-3pages.pdf"));
const needUnpdf = await skipUnlessOptional("unpdf");

const ENV_KEYS = ["PROTON_DRIVE_OCR", "PROTON_DRIVE_OCR_ENGINE", "PROTON_DRIVE_OCR_LANGS", "PROTON_DRIVE_OCR_MAX_PAGES", "PROTON_DRIVE_OCR_MAX_BYTES", "PROTON_DRIVE_OCR_TIMEOUT_MS",
  "PROTON_DRIVE_INDEX_DIR", "PROTON_DRIVE_CONTENT_INDEX", "PROTON_DRIVE_CONTENT_INDEX_KEY", "PATH"];
let savedEnv;
let tmps;
beforeEach(() => { savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])); tmps = []; });
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
const mkTmp = (prefix = "pdocr-") => { const d = mkdtempSync(join(tmpdir(), prefix)); tmps.push(d); return d; };
const ocrDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("pdmcp-ocr-"));

// ---- shims: fake tesseract / pdftoppm / swiftc that log their argv -------------------------------------------------------------
/**
 * Writes executable node scripts into a fresh dir. `tesseract` behaviour: print | fail | hang | slow. Returns { dir, which, calls() }.
 * `which` maps a command name to its shim (or undefined), like resolveTool.
 */
function makeShims({ tesseract = "print", pdfPages = 2, pdftoppm = true, swiftc = false, version = "tesseract 5.3.0" } = {}) {
  const dir = mkTmp("pdocr-shims-");
  const log = join(dir, "calls.jsonl");
  const pidFile = join(dir, "grandchild.pid");
  const node = process.execPath;
  const head = `#!${node}\nconst fs=require('fs'),path=require('path');\nconst argv=process.argv.slice(2);\nconst log=(o)=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(o)+'\\n');\n`;
  const behaviours = {
    print: `log({tool:'tesseract',argv,cwd:process.cwd(),mode:fs.statSync(path.dirname(argv[0])).mode&0o777});process.stdout.write('text of '+path.basename(argv[0])+'\\n');`,
    fail: `log({tool:'tesseract',argv});process.stderr.write('boom: cannot read image\\n');process.exit(1);`,
    slow: `log({tool:'tesseract',argv,ev:'start'});setTimeout(()=>{log({tool:'tesseract',ev:'end'});process.stdout.write('slow text\\n');},300);`,
    hang: `log({tool:'tesseract',argv});const c=require('child_process').spawn('sleep',['60'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`,
  };
  const tess = head + `if(argv[0]==='--version'){console.log(${JSON.stringify(version)});process.exit(0);}\nif(argv[0]==='--list-langs'){console.log('List of available languages (2):\\neng\\npol');process.exit(0);}\n` + behaviours[tesseract];
  // "hang" is a plain sh script: it must be running (and have written its grandchild's pid) within milliseconds, also on a loaded machine.
  writeFileSync(join(dir, "tesseract"), tesseract === "hang" ? `#!/bin/sh\nsleep 60 &\necho $! > ${pidFile}\nwait\n` : tess, { mode: 0o755 });
  if (pdftoppm) {
    const pp = head + `log({tool:'pdftoppm',argv});const li=argv.indexOf('-l');const last=Number(argv[li+1]);const prefix=argv[argv.length-1];const n=Math.min(last,${pdfPages});for(let i=1;i<=n;i++)fs.writeFileSync(prefix+'-'+String(i).padStart(2,'0')+'.png','x');`;
    writeFileSync(join(dir, "pdftoppm"), pp, { mode: 0o755 });
  }
  if (swiftc === true) writeFileSync(join(dir, "swiftc"), head + `log({tool:'swiftc',argv});process.stderr.write('error: no developer tools were found\\n');process.exit(1);`, { mode: 0o755 });
  if (swiftc === "ok") {
    // "Compiles" by writing a node script that behaves like the Vision helper.
    const helper = head + `log({tool:'vision-helper',argv});process.stdout.write(JSON.stringify({engine:'vision',totalPages:1,pages:[{page:1,text:'fake vision text'}]}));`;
    writeFileSync(join(dir, "swiftc"), head + `log({tool:'swiftc',argv});fs.writeFileSync(argv[argv.indexOf('-o')+1],${JSON.stringify(helper)},{mode:0o755});`, { mode: 0o755 });
  }
  const which = (cmd) => (existsSync(join(dir, cmd)) ? join(dir, cmd) : undefined);
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, which, calls, pidFile };
}
const useTesseract = (shims, extra = {}) => {
  process.env.PROTON_DRIVE_OCR = "1";
  process.env.PROTON_DRIVE_OCR_ENGINE = "tesseract";
  return { which: shims.which, platform: "linux", ...extra };
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a fake DriveService for loadDriveText / readDriveContent ------------------------------------------------------------------
function fakeDrive({ node, name = "f", bytes }) {
  const calls = { info: 0, download: 0 };
  return {
    calls,
    info: async () => { calls.info++; return node; },
    download: async (_r, dir) => { calls.download++; writeFileSync(join(dir, name), bytes); return { downloaded: 1, skipped: 0, failed: 0 }; },
  };
}
const fileNode = (extra = {}) => ({ type: "file", mediaType: "text/plain", activeRevision: { claimedSize: 10 }, ...extra });
const pngNode = () => fileNode({ mediaType: "image/png" });
const pdfNode = () => fileNode({ mediaType: "application/pdf" });

// ================================================================================================================================
describe("engine selection", () => {
  const has = (...names) => (c) => (names.includes(c) ? `/bin/${c}` : undefined);
  const pick = (o) => chooseEngines({ platform: "linux", which: has(), ...o });

  it("auto: macOS with swiftc -> vision first, tesseract as the fallback", () => {
    assert.deepEqual(pick({ platform: "darwin", which: has("swiftc", "tesseract") }), { engines: ["vision", "tesseract"] });
    assert.deepEqual(pick({ platform: "darwin", which: has("swiftc") }), { engines: ["vision"] });
  });
  it("auto: macOS without swiftc uses tesseract; Linux never uses vision even when swiftc exists", () => {
    assert.deepEqual(pick({ platform: "darwin", which: has("tesseract") }), { engines: ["tesseract"] });
    assert.deepEqual(pick({ platform: "linux", which: has("swiftc", "tesseract") }), { engines: ["tesseract"] });
  });
  it("auto: nothing found -> the clear 'enabled but no engine' error with install hints", () => {
    for (const platform of ["darwin", "linux"]) {
      const r = pick({ platform });
      assert.equal(r.error, NO_ENGINE);
      assert.match(r.error, /OCR is enabled.*no OCR engine was found/);
      assert.match(r.error, /brew install tesseract tesseract-lang/);
      assert.match(r.error, /apt install tesseract-ocr/);
    }
  });
  it("PROTON_DRIVE_OCR_ENGINE overrides auto", () => {
    assert.deepEqual(pick({ engine: "tesseract", platform: "darwin", which: has("swiftc", "tesseract") }), { engines: ["tesseract"] });
    assert.deepEqual(pick({ engine: "vision", platform: "darwin", which: has("swiftc", "tesseract") }), { engines: ["vision"] });
    assert.match(pick({ engine: "vision", platform: "linux", which: has("swiftc", "tesseract") }).error, /needs macOS and swiftc/);
    assert.match(pick({ engine: "vision", platform: "darwin", which: has("tesseract") }).error, /xcode-select/);
    assert.match(pick({ engine: "tesseract", which: has("swiftc") }).error, /tesseract was not found.*brew install tesseract tesseract-lang/);
  });
  it("an empty or unknown engine value: empty = auto, unknown is refused", () => {
    assert.deepEqual(pick({ engine: "  ", which: has("tesseract") }), { engines: ["tesseract"] });
    assert.match(pick({ engine: "magic", which: has("tesseract") }).error, /must be auto, vision or tesseract/);
  });
  it("heic images need the Vision engine", () => {
    const linux = { platform: "linux", which: has("tesseract") };
    const mac = { platform: "darwin", which: has("swiftc", "tesseract") };
    assert.equal(ocrImageExt("heic", "", linux), undefined);
    assert.equal(ocrImageExt("heic", "", mac), "heic");
    assert.equal(ocrImageExt("jpeg", "", linux), "jpg");
    assert.equal(ocrImageExt("", "image/tiff", linux), "tiff");
    assert.equal(ocrImageExt("gif", "image/gif", linux), undefined);
  });
});

describe("configuration", () => {
  it("languages: letters, _ and + are accepted; anything else is refused (nothing reaches an argv)", () => {
    delete process.env.PROTON_DRIVE_OCR_LANGS;
    assert.equal(ocrLanguages(), undefined);
    for (const ok of ["eng", "eng+pol", "chi_sim+eng", "  deu "]) { process.env.PROTON_DRIVE_OCR_LANGS = ok; assert.equal(ocrLanguages(), ok.trim()); }
    for (const bad of ["-l", "eng pol", "eng;rm -rf /", "eng,pol", "en-US", "$(id)", "eng\npol", "a".repeat(65)]) {
      process.env.PROTON_DRIVE_OCR_LANGS = bad;
      assert.throws(() => ocrLanguages(), /PROTON_DRIVE_OCR_LANGS must be language codes/, JSON.stringify(bad));
    }
  });
  it("sparse text detection: under ~20 non-blank characters per page on average", () => {
    assert.equal(isSparsePdfText("", 1), true);
    assert.equal(isSparsePdfText(" \n\t \n", 5), true);
    assert.equal(isSparsePdfText("a".repeat(19), 1), true);
    assert.equal(isSparsePdfText("a".repeat(20), 1), false);
    assert.equal(isSparsePdfText("a".repeat(59), 3), true);
    assert.equal(isSparsePdfText("a".repeat(60), 3), false);
    assert.equal(isSparsePdfText("a b ".repeat(10), 1), false, "spaces do not count: 20 letters");
    assert.equal(isSparsePdfText("", 0), true);
  });
  it("images are unsupported without PROTON_DRIVE_OCR=1 and 'image' with it", () => {
    delete process.env.PROTON_DRIVE_OCR;
    for (const f of ["a.png", "a.jpg", "a.jpeg", "a.tif", "a.tiff", "a.bmp", "a.webp"]) assert.equal(pickFormat(`/x/${f}`, ""), undefined, f);
    assert.equal(pickFormat("/x/photo", "image/png"), undefined);
    process.env.PROTON_DRIVE_OCR = "1";
    for (const f of ["a.png", "a.PNG", "a.jpg", "a.jpeg", "a.tif", "a.tiff", "a.bmp", "a.webp"]) assert.equal(pickFormat(`/x/${f}`, ""), "image", f);
    assert.equal(pickFormat("/x/photo", "image/jpeg"), "image");
    assert.equal(pickFormat("/x/a.gif", "image/gif"), undefined);
    assert.equal(pickFormat("/x/a.pdf", ""), "pdf");
    process.env.PROTON_DRIVE_OCR = "true";
    assert.equal(pickFormat("/x/a.png", ""), "image");
    process.env.PROTON_DRIVE_OCR = "0";
    assert.equal(pickFormat("/x/a.png", ""), undefined);
  });
});

// ================================================================================================================================
describe("tesseract path (shims): argv, limits, cleanup", () => {
  usePrivateTmp(beforeEach, afterEach);

  it("image: tesseract <abs path in a private temp dir> stdout -l eng; the dir is removed", async () => {
    const s = makeShims();
    const deps = useTesseract(s);
    const r = await ocrBuffer(SAMPLE_PNG, "png", 1_000_000, deps);
    assert.equal(r.engine, "tesseract");
    assert.equal(r.pagesOcrd, 1);
    assert.equal(r.text, "text of in.png");
    const [c] = s.calls();
    assert.equal(c.argv.length, 4);
    assert.match(c.argv[0], /^\/.*pdmcp-ocr-[^/]+\/in\.png$/);
    assert.deepEqual(c.argv.slice(1), ["stdout", "-l", "eng"]);
    assert.ok(!c.argv.some((a, i) => i === 0 && a.startsWith("-")), "the file argument cannot be read as an option");
    assert.equal(ocrDirs().length, 0, "temp dir removed");
  });

  it("the temp dir is private (0700) while the engine runs and gone afterwards", async () => {
    const s = makeShims();
    await ocrBuffer(SAMPLE_PNG, "png", 1000, useTesseract(s));
    const [c] = s.calls();
    assert.equal(c.mode, 0o700);
    assert.equal(existsSync(dirname(c.argv[0])), false);
  });

  it("PROTON_DRIVE_OCR_LANGS reaches -l verbatim, as one argument", async () => {
    const s = makeShims();
    const deps = useTesseract(s);
    process.env.PROTON_DRIVE_OCR_LANGS = "eng+pol";
    await ocrBuffer(SAMPLE_PNG, "png", 1000, deps);
    assert.deepEqual(s.calls()[0].argv.slice(1), ["stdout", "-l", "eng+pol"]);
  });

  it("an invalid language string runs nothing", async () => {
    const s = makeShims();
    const deps = useTesseract(s);
    process.env.PROTON_DRIVE_OCR_LANGS = "eng; touch /tmp/x";
    await assert.rejects(ocrBuffer(SAMPLE_PNG, "png", 1000, deps), /PROTON_DRIVE_OCR_LANGS must be language codes/);
    assert.equal(s.calls().length, 0);
  });

  it("no shell: a temp dir full of shell metacharacters is passed through untouched and nothing is executed", async () => {
    const s = makeShims();
    const deps = useTesseract(s);
    const evil = join(mkTmp("pdocr-evil-"), "a b;touch PWNED;$(touch PWNED2) `touch PWNED3` -x");
    mkdirSync(evil);
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = evil;
    try {
      const r = await ocrBuffer(SAMPLE_PNG, "png", 1000, deps);
      assert.equal(r.text, "text of in.png");
    } finally { process.env.TMPDIR = prev; }
    const argv0 = s.calls()[0].argv[0];
    assert.ok(argv0.startsWith(evil + "/pdmcp-ocr-"), argv0);
    assert.deepEqual(readdirSync(evil), [], "no side effects, temp dir gone");
    for (const f of ["PWNED", "PWNED2", "PWNED3"]) assert.ok(!existsSync(join(s.calls()[0].cwd, f)) && !existsSync(join(dirname(evil), f)), f);
  });

  it("PDF: pdftoppm -r 200 -png -f 1 -l <maxPages> into the private dir, then tesseract per page in page order", async () => {
    const s = makeShims({ pdfPages: 12 });
    const deps = useTesseract(s);
    const r = await ocrBuffer(Buffer.from("%PDF-1.4"), "pdf", 1_000_000, deps);
    const [pp, ...tess] = s.calls();
    assert.equal(pp.tool, "pdftoppm");
    assert.deepEqual(pp.argv.slice(0, 7), ["-r", "200", "-png", "-f", "1", "-l", "30"]);
    assert.match(pp.argv.at(-2), /\/pdmcp-ocr-[^/]+\/in\.pdf$/);
    assert.match(pp.argv.at(-1), /\/pdmcp-ocr-[^/]+\/pg$/);
    assert.equal(tess.length, 12);
    assert.deepEqual(tess.map((c) => c.argv[0].split("/").pop()), Array.from({ length: 12 }, (_, i) => `pg-${String(i + 1).padStart(2, "0")}.png`), "numeric order, not string order");
    assert.equal(r.pagesOcrd, 12);
    assert.equal(r.note, undefined, "fewer pages than the limit");
    assert.equal(ocrDirs().length, 0);
  });

  it("PROTON_DRIVE_OCR_MAX_PAGES limits pdftoppm -l and says so", async () => {
    const s = makeShims({ pdfPages: 12 });
    const deps = useTesseract(s);
    process.env.PROTON_DRIVE_OCR_MAX_PAGES = "3";
    const r = await ocrBuffer(Buffer.from("%PDF-1.4"), "pdf", 1_000_000, deps);
    assert.equal(s.calls()[0].argv[s.calls()[0].argv.indexOf("-l") + 1], "3");
    assert.equal(r.pagesOcrd, 3);
    assert.match(r.note, /at most the first 3 pages/);
  });

  it("the text cap stops recognizing further pages", async () => {
    const s = makeShims({ pdfPages: 12 });
    const deps = useTesseract(s);
    const r = await ocrBuffer(Buffer.from("%PDF-1.4"), "pdf", 30, deps);
    assert.equal(r.capped, true);
    assert.ok(r.text.length <= 30);
    assert.ok(r.pagesOcrd < 12);
  });

  it("pdftoppm missing -> a clear error and nothing else runs", async () => {
    const s = makeShims({ pdftoppm: false });
    const deps = useTesseract(s);
    await assert.rejects(ocrBuffer(Buffer.from("%PDF-1.4"), "pdf", 1000, deps), /pdftoppm was not found.*poppler/);
    assert.equal(s.calls().length, 0);
    assert.equal(ocrDirs().length, 0);
    // An image still works without pdftoppm.
    assert.equal((await ocrBuffer(SAMPLE_PNG, "png", 1000, deps)).text, "text of in.png");
  });

  it("no engine found -> the 'enabled but no engine' error; no temp dir is created", async () => {
    process.env.PROTON_DRIVE_OCR = "1";
    delete process.env.PROTON_DRIVE_OCR_ENGINE;
    await assert.rejects(ocrBuffer(SAMPLE_PNG, "png", 1000, { which: () => undefined, platform: "linux" }), /OCR is enabled.*no OCR engine was found.*brew install tesseract tesseract-lang/);
    assert.equal(ocrDirs().length, 0);
  });

  it("an engine failure surfaces its first stderr line and still removes the temp dir", async () => {
    const s = makeShims({ tesseract: "fail" });
    const deps = useTesseract(s);
    await assert.rejects(ocrBuffer(SAMPLE_PNG, "png", 1000, deps), /tesseract failed: boom: cannot read image/);
    assert.equal(ocrDirs().length, 0);
  });

  it("auto on macOS: when the Vision helper cannot be compiled, tesseract is used instead", async () => {
    const s = makeShims({ swiftc: true });
    process.env.PROTON_DRIVE_OCR = "1";
    delete process.env.PROTON_DRIVE_OCR_ENGINE;
    process.env.PROTON_DRIVE_INDEX_DIR = mkTmp("pdocr-cache-");
    const r = await ocrBuffer(SAMPLE_PNG, "png", 1000, { which: s.which, platform: "darwin" });
    assert.equal(r.engine, "tesseract");
    assert.deepEqual(s.calls().map((c) => c.tool), ["swiftc", "tesseract"]);
    assert.deepEqual(readdirSync(process.env.PROTON_DRIVE_INDEX_DIR), [], "no half-built helper left behind");
  });

  it("PROTON_DRIVE_OCR_ENGINE=vision with a failing compile: the error names the Xcode command line tools, nothing else runs", async () => {
    const s = makeShims({ swiftc: true });
    process.env.PROTON_DRIVE_OCR = "1";
    process.env.PROTON_DRIVE_OCR_ENGINE = "vision";
    process.env.PROTON_DRIVE_INDEX_DIR = mkTmp("pdocr-cache-");
    await assert.rejects(ocrBuffer(SAMPLE_PNG, "png", 1000, { which: s.which, platform: "darwin" }), /Could not compile the macOS Vision OCR helper.*Xcode.*command line tools.*no developer tools were found/);
    assert.deepEqual(s.calls().map((c) => c.tool), ["swiftc"]);
    assert.equal(ocrDirs().length, 0);
  });

  describe("Vision helper build (fake swiftc)", () => {
    const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16);
    const swiftFile = join(HERE, "..", "dist", "ocr", "vision-ocr.swift");
    const setup = () => {
      const s = makeShims({ swiftc: "ok" });
      process.env.PROTON_DRIVE_OCR = "1";
      process.env.PROTON_DRIVE_OCR_ENGINE = "vision";
      const cache = mkTmp("pdocr-cache-");
      process.env.PROTON_DRIVE_INDEX_DIR = cache;
      return { s, cache, deps: { which: s.which, platform: "darwin" } };
    };
    const compiles = (s) => s.calls().filter((c) => c.tool === "swiftc").length;

    it("compiles once into a hash-named 0700 binary, runs it with [input, maxPages, langs], prunes older helpers, reuses it", async () => {
      const { s, cache, deps } = setup();
      writeFileSync(join(cache, "vision-ocr-deadbeefdeadbeef"), "stale", { mode: 0o700 });
      process.env.PROTON_DRIVE_OCR_LANGS = "eng+pol";
      const r = await ocrBuffer(SAMPLE_PNG, "png", 1000, deps);
      assert.equal(r.text, "fake vision text");
      assert.equal(r.engine, "vision");
      const name = `vision-ocr-${sha(swiftFile)}`;
      assert.deepEqual(readdirSync(cache), [name], "stale helper pruned, no .tmp left");
      assert.equal(statSync(join(cache, name)).mode & 0o777, 0o700);
      const [sc, run] = s.calls();
      assert.equal(sc.tool, "swiftc");
      assert.deepEqual(sc.argv.slice(0, 3).map((a, i) => (i === 1 ? a.replace(/.*\/dist\//, "dist/") : a)), ["-O", "dist/ocr/vision-ocr.swift", "-o"]);
      assert.equal(run.tool, "vision-helper");
      assert.match(run.argv[0], /\/in\.png$/);
      assert.deepEqual(run.argv.slice(1), ["30", "eng,pol"]);
      await ocrBuffer(SAMPLE_PNG, "png", 1000, deps);
      assert.equal(compiles(s), 1, "second call does not recompile");
    });

    it("concurrent first calls compile exactly once", async () => {
      const { s, deps } = setup();
      await Promise.all([ocrBuffer(SAMPLE_PNG, "png", 1000, deps), ocrBuffer(SAMPLE_PNG, "png", 1000, deps), ocrBuffer(SAMPLE_PNG, "png", 1000, deps)]);
      assert.equal(compiles(s), 1);
      assert.equal(s.calls().filter((c) => c.tool === "vision-helper").length, 3);
    });

    it("a helper that others can write to is not trusted: it is rebuilt", async () => {
      const { s, cache, deps } = setup();
      await ocrBuffer(SAMPLE_PNG, "png", 1000, deps);
      chmodSync(join(cache, readdirSync(cache)[0]), 0o777);
      await ocrBuffer(SAMPLE_PNG, "png", 1000, deps);
      assert.equal(compiles(s), 2);
      assert.equal(statSync(join(cache, readdirSync(cache)[0])).mode & 0o777, 0o700);
    });

    it("a garbled answer from the helper is an error, not text", async () => {
      const { cache, deps } = setup();
      await ocrBuffer(SAMPLE_PNG, "png", 1000, deps);
      writeFileSync(join(cache, readdirSync(cache)[0]), `#!${process.execPath}\nprocess.stdout.write('not json')`, { mode: 0o700 });
      await assert.rejects(ocrBuffer(SAMPLE_PNG, "png", 1000, deps), /unreadable answer/);
    });
  });

  it("the Vision helper is not built in a cache dir that is not private", async () => {
    const s = makeShims({ swiftc: true });
    process.env.PROTON_DRIVE_OCR = "1";
    process.env.PROTON_DRIVE_OCR_ENGINE = "vision";
    const loose = mkTmp("pdocr-cache-");
    chmodSync(loose, 0o755);
    process.env.PROTON_DRIVE_INDEX_DIR = loose;
    await assert.rejects(ocrBuffer(SAMPLE_PNG, "png", 1000, { which: s.which, platform: "darwin" }), /must be a real directory owned by you with no group\/other access/);
    assert.equal(s.calls().length, 0);
  });

  it("an unknown input type is refused before anything runs", async () => {
    const s = makeShims();
    const deps = useTesseract(s);
    for (const ext of ["../../etc/passwd", "-x", "exe", "", "png "]) await assert.rejects(ocrBuffer(SAMPLE_PNG, ext, 1000, deps), /unsupported input type/, JSON.stringify(ext));
    assert.equal(s.calls().length, 0);
  });

  it("hard timeout kills the engine's whole process group, rejects, and cleans up", async () => {
    const s = makeShims({ tesseract: "hang" });
    const deps = useTesseract(s);
    process.env.PROTON_DRIVE_OCR_TIMEOUT_MS = "1000";
    const t0 = Date.now();
    await assert.rejects(ocrBuffer(SAMPLE_PNG, "png", 1000, deps), /OCR timed out after 1 s/);
    assert.ok(Date.now() - t0 < 5000);
    const pid = Number(readFileSync(s.pidFile, "utf8"));
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
    assert.equal(alive(pid), false, "the grandchild (sleep) was killed with the group");
    assert.equal(ocrDirs().length, 0);
  });

  it("aborting the request kills the engine and rejects with 'cancelled'", async () => {
    const s = makeShims({ tesseract: "hang" });
    const deps = useTesseract(s);
    const ac = new AbortController();
    const p = callContext.run({ signal: ac.signal }, () => ocrBuffer(SAMPLE_PNG, "png", 1000, deps));
    for (let i = 0; i < 100 && !existsSync(s.pidFile); i++) await sleep(50);
    ac.abort();
    await assert.rejects(p, /cancelled/);
    const pid = Number(readFileSync(s.pidFile, "utf8"));
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
    assert.equal(alive(pid), false);
    assert.equal(ocrDirs().length, 0);
  });

  it("stdout cap: a runaway engine is killed and refused", async () => {
    const dir = mkTmp();
    await assert.rejects(runOcrTool("/bin/sh", ["-c", "yes | head -c 200000"], { deadline: Date.now() + 10_000, maxStdout: 1000, what: "fake engine" }), /fake engine produced more output than expected/);
    await assert.rejects(runOcrTool(join(dir, "nope"), [], { deadline: Date.now() + 10_000, what: "fake engine" }), /fake engine was not found/);
  });

  it("concurrency is exactly 1: two OCR calls never overlap", async () => {
    const s = makeShims({ tesseract: "slow" });
    const deps = useTesseract(s);
    await Promise.all([ocrBuffer(SAMPLE_PNG, "png", 1000, deps), ocrBuffer(SAMPLE_PNG, "png", 1000, deps), ocrBuffer(SAMPLE_PNG, "png", 1000, deps)]);
    assert.deepEqual(s.calls().map((c) => c.ev), ["start", "end", "start", "end", "start", "end"]);
  });

  it("a call that gets the slot after its deadline is deferred without running anything", async () => {
    const s = makeShims({ tesseract: "slow" });
    const deps = useTesseract(s);
    const first = ocrBuffer(SAMPLE_PNG, "png", 1000, deps);
    await sleep(50);
    await assert.rejects(ocrBuffer(SAMPLE_PNG, "png", 1000, { ...deps, deadlineAt: Date.now() + 20 }), OcrDeferredError);
    await first;
    assert.equal(s.calls().filter((c) => c.ev === "start").length, 1);
    await assert.rejects(ocrBuffer(SAMPLE_PNG, "png", 1000, { ...deps, deadlineAt: Date.now() - 1 }), OcrDeferredError);
    assert.equal(s.calls().filter((c) => c.ev === "start").length, 1);
    assert.equal(ocrDirs().length, 0);
  });

  it("the stale-temp sweep also covers pdmcp-ocr-* dirs", async () => {
    const base = mkTmp("pdocr-sweep-");
    mkdirSync(join(base, "pdmcp-ocr-old"));
    mkdirSync(join(base, "pdmcp-other"));
    await sweepStaleTempDirs(base, -1);
    assert.deepEqual(readdirSync(base), ["pdmcp-other"]);
  });
});

// ================================================================================================================================
describe("drive_read_content / drive_read_many with OCR", () => {
  usePrivateTmp(beforeEach, afterEach);

  it("OCR off: images stay unsupported (no download) and a scanned PDF stays empty with the old note", async () => {
    const s = makeShims();
    delete process.env.PROTON_DRIVE_OCR;
    const d = fakeDrive({ node: pngNode(), bytes: SAMPLE_PNG, name: "a.png" });
    await assert.rejects(readDriveContent(d, { path: "/my-files/a.png" }, { ocr: { which: s.which, platform: "linux" } }), /unsupported format.*Supported:.*docx.*pdf/);
    assert.equal(d.calls.download, 0);
    assert.equal(s.calls().length, 0);
    if (needUnpdf === false) {
      const p = await readDriveContent(fakeDrive({ node: pdfNode(), bytes: makePdf(null), name: "a.pdf" }), { path: "/my-files/a.pdf" }, { ocr: { which: s.which, platform: "linux" } });
      assert.equal(p.text, "");
      assert.match(p.note, /no text layer/);
      assert.equal(p.ocr, undefined);
      assert.equal(s.calls().length, 0, "no OCR without the opt-in");
    }
  });

  it("OCR on: an image is read by OCR and the result says so", async () => {
    const s = makeShims();
    const deps = { ocr: useTesseract(s) };
    const r = await readDriveContent(fakeDrive({ node: pngNode(), bytes: SAMPLE_PNG, name: "a.png" }), { path: "/my-files/a.png" }, deps);
    assert.equal(r.format, "image");
    assert.equal(r.text, "text of in.png");
    assert.equal(r.ocr, true);
    assert.equal(r.engine, "tesseract");
    assert.equal(r.pagesOcrd, 1);
    assert.match(r.note, /recognized by OCR \(tesseract, 1 page\).*recognition errors/);
    assert.equal(r.truncated, false);
  });

  it("OCR on: an image with no recognizable text returns empty text and says so", async () => {
    const empty = makeShims();
    writeFileSync(join(empty.dir, "tesseract"), `#!${process.execPath}\n`, { mode: 0o755 }); // prints nothing
    const deps = { ocr: useTesseract(empty) };
    const r = await readDriveContent(fakeDrive({ node: pngNode(), bytes: SAMPLE_PNG, name: "a.png" }), { path: "/my-files/a.png" }, deps);
    assert.equal(r.text, "");
    assert.equal(r.note, "no text found by OCR");
  });

  it("OCR on: an image over PROTON_DRIVE_OCR_MAX_BYTES is refused before download", async () => {
    const s = makeShims();
    const deps = { ocr: useTesseract(s) };
    process.env.PROTON_DRIVE_OCR_MAX_BYTES = "1000";
    const d = fakeDrive({ node: fileNode({ mediaType: "image/png", activeRevision: { claimedSize: 5000 } }), bytes: SAMPLE_PNG, name: "a.png" });
    await assert.rejects(readDriveContent(d, { path: "/my-files/a.png" }, deps), /5000 bytes.*over the read cap of 1000 bytes.*PROTON_DRIVE_OCR_MAX_BYTES/);
    assert.equal(d.calls.download, 0);
    assert.equal(s.calls().length, 0);
  });

  it("OCR on, no engine: a clear error for an image", async () => {
    process.env.PROTON_DRIVE_OCR = "1";
    delete process.env.PROTON_DRIVE_OCR_ENGINE;
    await assert.rejects(readDriveContent(fakeDrive({ node: pngNode(), bytes: SAMPLE_PNG, name: "a.png" }), { path: "/my-files/a.png" }, { ocr: { which: () => undefined, platform: "linux" } }), /no OCR engine was found/);
  });

  describe("PDFs", needUnpdf, () => {
    it("a scanned PDF (no text layer) falls back to OCR", async () => {
      const s = makeShims({ pdfPages: 2 });
      const deps = { ocr: useTesseract(s) };
      const r = await readDriveContent(fakeDrive({ node: pdfNode(), bytes: makePdf(null), name: "a.pdf" }), { path: "/my-files/a.pdf" }, deps);
      assert.equal(r.format, "pdf");
      assert.equal(r.ocr, true);
      assert.equal(r.pagesOcrd, 2);
      assert.match(r.text, /text of pg-01\.png\n\ntext of pg-02\.png/);
      assert.match(r.note, /recognition errors/);
      assert.doesNotMatch(r.note, /no text layer/);
    });

    it("a PDF with a real text layer is not OCR'd", async () => {
      const s = makeShims();
      const deps = { ocr: useTesseract(s) };
      const r = await readDriveContent(fakeDrive({ node: pdfNode(), bytes: makePdf("This page carries a genuine text layer"), name: "a.pdf" }), { path: "/my-files/a.pdf" }, deps);
      assert.match(r.text, /genuine text layer/);
      assert.equal(r.ocr, undefined);
      assert.equal(s.calls().length, 0);
    });

    it("sparse text (a stray page number on a scan) also goes to OCR; the threshold is per page on average", async () => {
      const s = makeShims();
      const deps = { ocr: useTesseract(s) };
      const r = await readDriveContent(fakeDrive({ node: pdfNode(), bytes: makePdf("p."), name: "a.pdf" }), { path: "/my-files/a.pdf" }, deps);
      assert.equal(r.ocr, true);
    });

    it("OCR finding nothing keeps the original text and says so", async () => {
      const empty = makeShims();
      writeFileSync(join(empty.dir, "tesseract"), `#!${process.execPath}\n`, { mode: 0o755 });
      const r = await readDriveContent(fakeDrive({ node: pdfNode(), bytes: makePdf(null), name: "a.pdf" }), { path: "/my-files/a.pdf" }, { ocr: useTesseract(empty) });
      assert.equal(r.text, "");
      assert.equal(r.ocr, undefined);
      assert.match(r.note, /no text layer.*no text found by OCR either/);
    });

    it("a scanned PDF over PROTON_DRIVE_OCR_MAX_BYTES is returned as before, with a note, and not OCR'd", async () => {
      const s = makeShims();
      const deps = { ocr: useTesseract(s) };
      process.env.PROTON_DRIVE_OCR_MAX_BYTES = "100";
      const r = await readDriveContent(fakeDrive({ node: pdfNode(), bytes: makePdf(null), name: "a.pdf" }), { path: "/my-files/a.pdf" }, deps);
      assert.equal(r.text, "");
      assert.match(r.note, /not read with OCR.*PROTON_DRIVE_OCR_MAX_BYTES/);
      assert.equal(s.calls().length, 0);
    });

    it("drive_read_many inherits OCR: ocr: true per item and a note about errors", async () => {
      const s = makeShims();
      const deps = { ocr: useTesseract(s) };
      const drive = {
        info: async (p) => (p.endsWith(".png") ? pngNode() : fileNode()),
        download: async (p, dir) => { writeFileSync(join(dir, "f"), p.endsWith(".png") ? SAMPLE_PNG : "plain words"); return { downloaded: 1, skipped: 0, failed: 0 }; },
      };
      const r = await driveReadMany(drive, { paths: ["/my-files/a.png", "/my-files/b.txt"] }, deps);
      assert.equal(r.results[0].ok, true);
      assert.equal(r.results[0].ocr, true);
      assert.equal(r.results[0].text, "text of in.png");
      assert.equal(r.results[1].text, "plain words");
      assert.equal(r.results[1].ocr, undefined);
      assert.match(r.note, /ocr: true were recognized by OCR and may contain recognition errors/);
    });
  });

  it("drive_read_many: without OCR the image item fails as unsupported, as today", async () => {
    delete process.env.PROTON_DRIVE_OCR;
    const drive = { info: async () => pngNode(), download: async () => { throw new Error("must not download"); } };
    const r = await driveReadMany(drive, { paths: ["/my-files/a.png"] });
    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].error, /unsupported format/);
    assert.doesNotMatch(r.note, /OCR/);
  });
});

// ================================================================================================================================
describe("content index with OCR", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pdci-ocr-"));
    process.env.PROTON_DRIVE_INDEX_DIR = dir;
    process.env.PROTON_DRIVE_CONTENT_INDEX = "1";
    process.env.PROTON_DRIVE_CONTENT_INDEX_KEY = "ab".repeat(32);
    process.env.PROTON_DRIVE_OCR = "1";
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const node = (path, o = {}) => ({ path, uid: path, type: "file", size: 10, mtime: "2026-01-01T00:00:00Z", mediaType: path.endsWith(".png") ? "image/png" : path.endsWith(".pdf") ? "application/pdf" : "text/plain", ...o });
  /** files = {path: text | Error | fn}; load results are {text, ocr}. */
  function world(files, ocrPaths = []) {
    const loads = [];
    const deps = (extra = {}) => ({
      walk: async (_d, root) => ({ root, nodes: Object.keys(files).map((p) => node(p)), complete: true, callsMade: 1, skipped: [], fromCache: false, ageMs: 0 }),
      accountKey: async () => "acct-1",
      load: async (_d, p) => {
        loads.push(p);
        const v = typeof files[p] === "function" ? files[p]() : files[p];
        if (v instanceof Error) throw v;
        return { text: v, ocr: ocrPaths.includes(p) || undefined };
      },
      ...extra,
    });
    return { files, loads, deps };
  }
  const update = (w, o = {}, extra = {}) => driveContentIndex({}, { path: "/my-files/Docs", ...o }, w.deps(extra));
  const search = (w, q, o = {}) => driveSearchContent({}, { query: q, ...o }, w.deps());

  it("an OCR'd file is indexed and found; its search result carries ocr: true, an ordinary file does not", async () => {
    const w = world({ "/my-files/Docs/scan.png": "Quokka invoice 4711", "/my-files/Docs/note.txt": "Quokka notes" }, ["/my-files/Docs/scan.png"]);
    const r = await update(w);
    assert.equal(r.indexed, 2);
    const found = await search(w, "quokka");
    const byPath = Object.fromEntries(found.results.map((x) => [x.path, x]));
    assert.equal(byPath["/my-files/Docs/scan.png"].ocr, true);
    assert.equal("ocr" in byPath["/my-files/Docs/note.txt"], false);
    assert.match(found.note, /ocr: true.*recognition errors/);
    // the flag survives the encrypted round trip (a second search reloads the file)
    const again = await search(w, "invoice");
    assert.equal(again.results[0].ocr, true);
  });

  it("images are skipped as unsupported when OCR is off", async () => {
    delete process.env.PROTON_DRIVE_OCR;
    const w = world({ "/my-files/Docs/scan.png": "x", "/my-files/Docs/note.txt": "hello words" });
    const r = await update(w);
    assert.equal(r.indexed, 1);
    assert.equal(r.skippedFiles, 1);
    assert.deepEqual(w.loads, ["/my-files/Docs/note.txt"]);
  });

  it("secret-looking names are never read, images included", async () => {
    const w = world({ "/my-files/Docs/password-scan.png": "hunter2", "/my-files/Docs/id_rsa.png": "k", "/my-files/Docs/api-key.jpg": "k", "/my-files/Docs/scan.png": "invoice words" }, ["/my-files/Docs/scan.png"]);
    const r = await update(w);
    assert.equal(r.skippedSecretNames, 3);
    assert.deepEqual(w.loads, ["/my-files/Docs/scan.png"]);
    assert.equal((await search(w, "hunter2").catch(() => ({ results: [] }))).results.length, 0);
  });

  it("a file whose OCR slot comes after the time budget is not recorded half-way and is retried by the next call", async () => {
    let t = 1_000_000;
    const w = world({
      "/my-files/Docs/a.png": "alpha words",
      "/my-files/Docs/b.png": () => { throw new OcrDeferredError(); },
    }, ["/my-files/Docs/a.png", "/my-files/Docs/b.png"]);
    const first = await update(w, { timeBudgetMs: 5000 }, { now: () => t });
    assert.equal(first.indexed, 1);
    assert.equal(first.remaining, 1);
    assert.equal(first.partial, true);
    assert.equal(first.failedCount, 0);
    assert.equal(first.skippedFiles, 0, "deferred is not a skip");
    assert.equal(first.documents, 1, "no document, no half-indexed file");
    assert.match(first.note, /1 file\(s\) still to index/);
    w.files["/my-files/Docs/b.png"] = "bravo words";
    const second = await update(w, { timeBudgetMs: 5000 }, { now: () => t });
    assert.equal(second.indexed, 1);
    assert.equal(second.unchanged, 1);
    assert.equal(second.partial, false);
    assert.equal((await search(w, "bravo")).results.length, 1);
    assert.equal(w.loads.filter((p) => p.endsWith("a.png")).length, 1, "the finished file was not read again");
  });

  it("OCR timeout is a stable failure (recorded as skipped, not retried every call)", async () => {
    const w = world({ "/my-files/Docs/big.png": new Error("OCR timed out after 90 s"), "/my-files/Docs/ok.txt": "fine words" });
    const first = await update(w);
    assert.equal(first.failedCount, 0);
    assert.equal(first.skippedFiles, 1);
    const second = await update(w);
    assert.equal(second.unchanged, 2);
    assert.equal(w.loads.filter((p) => p.endsWith("big.png")).length, 1);
  });

  it("an engine error (no engine installed) is a failure that is retried, not a stable skip", async () => {
    const w = world({ "/my-files/Docs/a.png": new Error(NO_ENGINE) });
    const first = await update(w);
    assert.equal(first.failedCount, 1);
    assert.equal(first.partial, false);
    const second = await update(w);
    assert.equal(second.failedCount, 1);
    assert.equal(w.loads.length, 2);
  });

  it("files skipped while OCR was off (images, textless PDFs) are read again once OCR is on; no-text-after-OCR is not retried forever", async () => {
    delete process.env.PROTON_DRIVE_OCR;
    const w = world({ "/my-files/Docs/a.png": "scan words", "/my-files/Docs/b.pdf": "" , "/my-files/Docs/c.txt": "plain words" }, ["/my-files/Docs/a.png"]);
    const off = await update(w);
    assert.equal(off.indexed, 1);
    assert.equal(off.skippedFiles, 2);
    process.env.PROTON_DRIVE_OCR = "1";
    const on = await update(w);
    assert.equal(on.unchanged, 1, "only c.txt is untouched");
    assert.equal(on.indexed, 1, "a.png is read now");
    assert.equal(on.skippedFiles, 1, "b.pdf: OCR found nothing either");
    const again = await update(w);
    assert.equal(again.unchanged, 3);
    assert.equal(again.indexed, 0);
    const count = (name) => w.loads.filter((p) => p.endsWith(name)).length;
    assert.deepEqual([count("a.png"), count("b.pdf"), count("c.txt")], [1, 2, 1]);
  });

  it("end to end through the default loader: Drive bytes -> tesseract shim -> index -> search with ocr: true", async () => {
    const s = makeShims();
    process.env.PROTON_DRIVE_OCR_ENGINE = "tesseract";
    process.env.PATH = `${s.dir}:${process.env.PATH}`;
    const drive = {
      info: async () => pngNode(),
      download: async (_p, d) => { writeFileSync(join(d, "x"), SAMPLE_PNG); return { downloaded: 1, skipped: 0, failed: 0 }; },
    };
    const deps = {
      walk: async (_d, root) => ({ root, nodes: [node("/my-files/Docs/scan.png", { size: SAMPLE_PNG.length })], complete: true, callsMade: 1, skipped: [], fromCache: false, ageMs: 0 }),
      accountKey: async () => "acct-1",
    };
    const r = await driveContentIndex(drive, { path: "/my-files/Docs" }, deps);
    assert.equal(r.indexed, 1, JSON.stringify(r));
    const found = await driveSearchContent(drive, { query: "text of in" }, deps);
    assert.equal(found.results.length, 1);
    assert.equal(found.results[0].ocr, true);
    assert.equal(resolveTool("tesseract"), join(s.dir, "tesseract"));
  });
});

// ================================================================================================================================
describe("doctor", () => {
  it("OCR off is a normal state", async () => {
    delete process.env.PROTON_DRIVE_OCR;
    const c = await ocrCheck();
    assert.equal(c.id, "ocr");
    assert.equal(c.status, "ok");
    assert.match(c.message, /^off/);
  });
  it("OCR on with tesseract: version, configured and installed languages", async () => {
    const s = makeShims();
    process.env.PROTON_DRIVE_OCR = "1";
    process.env.PROTON_DRIVE_OCR_ENGINE = "tesseract";
    process.env.PROTON_DRIVE_OCR_LANGS = "eng+pol";
    process.env.PATH = `${s.dir}:${process.env.PATH}`;
    const c = await ocrCheck();
    assert.equal(c.status, "ok", JSON.stringify(c));
    assert.match(c.message, /enabled, engine tesseract.*tesseract 5\.3\.0.*languages eng\+pol \(installed: eng, pol\)/);
  });
  it("a configured language that is not installed is a warning with a hint", async () => {
    const s = makeShims();
    process.env.PROTON_DRIVE_OCR = "1";
    process.env.PROTON_DRIVE_OCR_ENGINE = "tesseract";
    process.env.PROTON_DRIVE_OCR_LANGS = "eng+deu";
    process.env.PATH = `${s.dir}:${process.env.PATH}`;
    const c = await ocrCheck();
    assert.equal(c.status, "warn");
    assert.match(c.hint, /Language data missing for deu/);
  });
  it("an invalid PROTON_DRIVE_OCR_LANGS is reported, not thrown", async () => {
    process.env.PROTON_DRIVE_OCR = "1";
    process.env.PROTON_DRIVE_OCR_LANGS = "eng;rm";
    const c = await ocrCheck();
    assert.equal(c.status, "warn");
    assert.match(c.message, /PROTON_DRIVE_OCR_LANGS is invalid/);
  });
});

// ================================================================================================================================
// REAL engine: the macOS Vision framework through the shipped Swift helper. Skipped (with the reason printed) elsewhere.
const visionSkip = (() => {
  if (process.platform !== "darwin") return `not macOS (${process.platform}); the Vision engine is macOS only`;
  try { execFileSync("swiftc", ["--version"], { stdio: "ignore" }); } catch { return "swiftc is not available (install the Xcode command line tools)"; }
  return false;
})();
if (visionSkip) console.log(`# ocr.test.mjs: real Vision engine tests SKIPPED: ${visionSkip}`);

describe("REAL Vision engine (macOS)", { skip: visionSkip }, () => {
  // The first run of every newly built helper costs ~25 s inside Vision (macOS prepares its model per binary), so the helper is
  // kept in a fixed per-user dir under the OS temp area and later local runs reuse it. TMPDIR is not redirected for the same reason.
  let cache, dirsBefore;
  before(() => {
    cache = join(realpathSync(tmpdir()), `pdmcp-test-vision-cache-${process.getuid()}`);
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    chmodSync(cache, 0o700);
  });
  const env = () => { process.env.PROTON_DRIVE_INDEX_DIR = cache; process.env.PROTON_DRIVE_OCR = "1"; process.env.PROTON_DRIVE_OCR_ENGINE = "vision"; delete process.env.PROTON_DRIVE_OCR_LANGS; };
  beforeEach(() => { env(); dirsBefore = new Set(ocrDirs()); });
  afterEach(() => assert.deepEqual(ocrDirs().filter((d) => !dirsBefore.has(d)), [], "no OCR temp dir left behind"));

  it("reads a PNG: known text comes back; the helper is compiled into a private cache dir", async () => {
    const r = await ocrBuffer(SAMPLE_PNG, "png", 100_000);
    assert.equal(r.engine, "vision");
    assert.equal(r.pagesOcrd, 1);
    assert.match(r.text, /Invoice 4711 Quokka/);
    assert.match(r.text, /Total 129\.50 EUR/);
    const bins = readdirSync(cache).filter((n) => n.startsWith("vision-ocr-"));
    assert.deepEqual(bins, [`vision-ocr-${createHash("sha256").update(readFileSync(join(HERE, "..", "dist", "ocr", "vision-ocr.swift"))).digest("hex").slice(0, 16)}`]);
    assert.equal(statSync(join(cache, bins[0])).mode & 0o777, 0o700);
    assert.equal(statSync(cache).mode & 0o777, 0o700);
  });

  it("second call reuses the compiled binary (same file, not rebuilt)", async () => {
    const [bin] = readdirSync(cache).filter((n) => n.startsWith("vision-ocr-"));
    const before = statSync(join(cache, bin)).mtimeMs;
    await ocrBuffer(SAMPLE_PNG, "png", 100_000);
    assert.equal(statSync(join(cache, bin)).mtimeMs, before);
    assert.deepEqual(readdirSync(cache).filter((n) => n.startsWith("vision-ocr-")), [bin]);
  });

  it("reads a scanned (image-only) PDF page by page and honours the page limit", async () => {
    process.env.PROTON_DRIVE_OCR_MAX_PAGES = "2";
    const r = await ocrBuffer(SCAN_PDF, "pdf", 100_000);
    assert.equal(r.pagesOcrd, 2);
    assert.match(r.text, /Scanned page 1 Quokka\n\nScanned page 2 Quokka/);
    assert.doesNotMatch(r.text, /page 3/);
    assert.match(r.note, /first 2 of 3 pages/);
    process.env.PROTON_DRIVE_OCR_MAX_PAGES = "30";
    const all = await ocrBuffer(SCAN_PDF, "pdf", 100_000);
    assert.equal(all.pagesOcrd, 3);
    assert.match(all.text, /Scanned page 3 Quokka/);
    delete process.env.PROTON_DRIVE_OCR_MAX_PAGES;
  });

  it("languages: a supported one, an unsupported one and a three-letter code never throw", async () => {
    for (const langs of ["eng", "en", "eng+pol", "xx", "xx+eng", "zzz"]) {
      process.env.PROTON_DRIVE_OCR_LANGS = langs;
      const r = await ocrBuffer(SAMPLE_PNG, "png", 100_000);
      assert.match(r.text, /Invoice 4711/, langs);
    }
  });

  it("a corrupt image is an error, not a hang, and leaves no temp dir", async () => {
    await assert.rejects(ocrBuffer(Buffer.from("not an image at all"), "png", 1000), /Vision OCR helper failed: could not read the image/);
  });

  it("end to end: readDriveContent on a PNG and a scanned PDF through the real engine", async () => {
    const img = await readDriveContent(fakeDrive({ node: pngNode(), bytes: SAMPLE_PNG, name: "a.png" }), { path: "/my-files/a.png" });
    assert.equal(img.ocr, true);
    assert.equal(img.engine, "vision");
    assert.match(img.text, /Invoice 4711 Quokka/);
    assert.match(img.note, /recognition errors/);
    if (needUnpdf === false) {
      const pdf = await readDriveContent(fakeDrive({ node: pdfNode(), bytes: SCAN_PDF, name: "a.pdf" }), { path: "/my-files/a.pdf" });
      assert.equal(pdf.ocr, true);
      assert.equal(pdf.pagesOcrd, 3);
      assert.match(pdf.text, /Scanned page 2 Quokka/);
    }
  });

  it("an exhausted time budget fails fast with a timeout error", async () => {
    process.env.PROTON_DRIVE_OCR_TIMEOUT_MS = "1";
    await assert.rejects(ocrBuffer(SAMPLE_PNG, "png", 1000), /OCR timed out/);
  });
});
