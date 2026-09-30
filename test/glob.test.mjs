import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { globMatch } from "../dist/utils/glob.js";
import { makeIgnore } from "../dist/services/plan.js";

describe("globMatch", () => {
  it("* stays inside a path segment, ** crosses '/'", () => {
    assert.ok(globMatch("*.pdf", "a.pdf"));
    assert.ok(!globMatch("*.pdf", "dir/a.pdf"));
    assert.ok(globMatch("**.pdf", "dir/a.pdf"));
    assert.ok(globMatch("docs/**/tmp", "docs/a/b/tmp"));
    assert.ok(!globMatch("docs/*/tmp", "docs/a/b/tmp"));
    assert.ok(globMatch("a***b", "a/x/b"));
    assert.ok(globMatch("*", ""));
  });
  it("? matches one non-'/' character", () => {
    assert.ok(globMatch("a?c", "abc"));
    assert.ok(!globMatch("a?c", "a/c"));
    assert.ok(!globMatch("a?c", "ac"));
  });
  it("is anchored, literal for regex metacharacters, and case-insensitive on request", () => {
    assert.ok(!globMatch("a.c", "abc"));
    assert.ok(globMatch("a+(b)[c]", "a+(b)[c]"));
    assert.ok(!globMatch("a", "ab"));
    assert.ok(!globMatch("*.PDF", "a.pdf"));
    assert.ok(globMatch("*.PDF", "a.pdf", true));
  });
  it("agrees with the former regex translation on random inputs", () => {
    const old = (g) => {
      let re = "";
      for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === "*") { if (g[i + 1] === "*") { re += ".*"; while (g[i + 1] === "*") i++; } else re += "[^/]*"; }
        else if (c === "?") re += "[^/]"; else re += c;
      }
      return new RegExp(`^${re}$`, "s");
    };
    let seed = 12345;
    const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const pick = (alpha, len) => Array.from({ length: len }, () => alpha[rnd(alpha.length)]).join("");
    for (let i = 0; i < 20000; i++) {
      const g = pick("ab/*?", 1 + rnd(7));
      const t = pick("ab/", rnd(9));
      assert.equal(globMatch(g, t), old(g).test(t), `glob ${g} text ${t}`);
    }
  });
  it("pathological patterns finish fast (no catastrophic backtracking)", () => {
    const pat = "*a*a*a*a*a*a*a*a*a*b";
    const name = "a".repeat(500);
    const t0 = performance.now();
    assert.equal(globMatch(pat, name, true), false);
    assert.equal(globMatch("**a**a**a**a**a**a**a**a**b", name), false);
    const ms = performance.now() - t0;
    assert.ok(ms < 100, `took ${ms} ms`);
    assert.ok(makeIgnore([pat])("x/" + name) === false);
  });
});
