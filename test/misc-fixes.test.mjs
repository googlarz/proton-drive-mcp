import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveService } from "../dist/services/drive.js";
import { validateMessage } from "../dist/utils/validation.js";
import { DriveCliNotFoundError } from "../dist/utils/errors.js";
import { makeSandbox, startServer } from "./helpers/mcp-client.mjs";

function makeRunner() {
  const calls = [];
  const queued = [];
  const runner = async (args) => {
    calls.push([...args]);
    if (!queued.length) return null;
    const q = queued.shift();
    if (q instanceof Error) throw q;
    return q;
  };
  return { runner, calls, queue: (...rs) => queued.push(...rs) };
}

describe("move() with a missing source", () => {
  it("reports 'Source not found' instead of 'Destination already exists'", async () => {
    const t = makeRunner();
    t.queue([{ name: { ok: true, value: "new.pdf" }, type: "file" }], new Error("Node not found: ghost.pdf"));
    await assert.rejects(
      () => new DriveService(t.runner).move("/my-files/ghost.pdf", "/my-files/Archive/new.pdf"),
      (e) => /Source not found: \/my-files\/ghost\.pdf/.test(e.message) && !/Destination already exists/.test(e.message)
    );
    assert.ok(!t.calls.some((c) => c[1] === "move" || c[1] === "rename"), "nothing may be mutated");
  });
});

describe("shareStatus() on a root", () => {
  for (const root of ["/my-files", "/photos", "/albums", "/trash", "/photos-trash", "/shared-with-me", "/shared-by-me", "/devices"]) {
    it(`refuses ${root} without calling the CLI`, async () => {
      const t = makeRunner();
      await assert.rejects(() => new DriveService(t.runner).shareStatus(root), /Roots cannot be shared — pass a file or folder inside it/);
      assert.equal(t.calls.length, 0);
    });
  }
});

describe("mkdir() final-segment validation", () => {
  it("rejects a spaces-only folder name like rename does", async () => {
    const t = makeRunner();
    await assert.rejects(() => new DriveService(t.runner).mkdir("/my-files/   "), /name must not be empty/);
    assert.equal(t.calls.length, 0);
  });
});

describe("validateMessage() length", () => {
  it("rejects more than 500 characters", () => {
    assert.throws(() => validateMessage("a".repeat(501)), /500 characters/);
  });
  it("counts code points, not UTF-16 units (500 emoji are fine)", () => {
    assert.equal([...validateMessage("😀".repeat(500))].length, 500);
  });
});

describe("shareRemoveAll() with a public link", () => {
  it("reports that the public link is still active", async () => {
    const t = makeRunner();
    t.queue({ members: [{ inviteeEmail: "a@pm.me" }], urlAccess: { url: "https://u" } }, null);
    assert.deepEqual(await new DriveService(t.runner).shareRemoveAll("/my-files/x"), { removed: 1, publicLink: true });
  });
});

describe("shareSetUrl() partial update", () => {
  it("warns when only a password is passed and an expiration existed", async () => {
    const t = makeRunner();
    t.queue({ urlAccess: { url: "https://u", expirationTime: "2026-10-03T00:00:00Z" } }, { url: "https://u" });
    const link = await new DriveService(t.runner).shareSetUrl("/my-files/R", "viewer", "pw12345678");
    assert.match(link.warning, /previously had a password and\/or expiration/);
  });
  it("does not warn when only a password is passed and there was no expiration", async () => {
    const t = makeRunner();
    t.queue({ urlAccess: { url: "https://u" } }, { url: "https://u" });
    const link = await new DriveService(t.runner).shareSetUrl("/my-files/R", "viewer", "pw12345678");
    assert.equal(link.warning, undefined);
  });
});

describe("assertItemsOk readable errors", () => {
  const cases = [
    ["copy", (d) => d.copy("/a", "/b"), "InvalidRequirementsAPIError", 2000, /Copy failed: Proton cannot copy this item: big folders cannot be copied yet.*\(InvalidRequirementsAPIError \(code 2000\)/],
    ["move", (d) => d.move("/a/x", "/b/x"), "InvalidRequirementsAPIError", 2000, /Move failed: the destination is inside the source, or the source no longer exists \(InvalidRequirementsAPIError/],
    ["restore", (d) => d.restore("/trash/x"), "APICodeError", 2511, /Restore failed: its original parent folder is still in the trash — restore the parent first \(APICodeError \(code 2511\)/],
  ];
  for (const [label, fn, name, code, re] of cases) {
    it(`maps ${name} ${code} on ${label}`, async () => {
      const t = makeRunner();
      t.queue([{ uid: "n", ok: false, error: { name, code } }]);
      await assert.rejects(() => fn(new DriveService(t.runner)), re);
    });
  }
  it("maps APICodeError 2500 on add-to-album", async () => {
    const t = makeRunner();
    t.queue([{ name: { ok: true, value: "A" } }], [{ uid: "n", ok: false, error: { name: "APICodeError", code: 2500 } }]);
    await assert.rejects(() => new DriveService(t.runner).addPhotoToAlbum("/albums/A", "/photos/p.jpg"), /Add to album failed: that photo is already in the album \(APICodeError \(code 2500\)\)/);
  });
});

describe("CLI-not-found guidance", () => {
  it("mentions PROTON_DRIVE_BIN", () => {
    assert.match(new DriveCliNotFoundError().message, /PROTON_DRIVE_BIN/);
  });
});

describe("drive_download description", () => {
  let c, sb;
  before(async () => { sb = makeSandbox(); c = await startServer("json", sb); });
  after(async () => { await c?.close(); sb?.cleanup(); });
  it("is at most 1024 characters and still says localPath is a FOLDER", async () => {
    const d = (await c.listTools()).find((t) => t.name === "drive_download").description;
    assert.ok(d.length <= 1024, `length ${d.length}`);
    assert.match(d, /localPath is a destination FOLDER/);
  });
});

describe("describeFailure noise", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdm-noise-"));
  const bin = join(dir, "noisy-cli");
  writeFileSync(bin, `#!/bin/sh
cat >&2 <<'X'
20075 |     const decrypted = await decryptSessionKeys(keys);
                            ^
error: Error decrypting session keys: No decryption key packets found
      at em (node_modules/openpgp/dist/node/openpgp.mjs:20079:20)
Error details:
{}
X
exit 1
`);
  chmodSync(bin, 0o755);
  after(() => rmSync(dir, { recursive: true, force: true }));
  it("keeps the real error line and drops bundled source and empty details", async () => {
    process.env.PROTON_DRIVE_BIN = bin;
    const { runDrive } = await import(`../dist/utils/subprocess.js?noise`);
    await assert.rejects(() => runDrive(["filesystem", "info", "/x"]), (e) => {
      assert.match(e.message, /Error decrypting session keys/);
      assert.ok(!/20075 \||decryptSessionKeys\(keys\)|Error details|\{\}|^\s*\^/m.test(e.message), e.message);
      return true;
    });
  });
});
