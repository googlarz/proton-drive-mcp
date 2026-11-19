// Text shown to the human or echoed in errors: control characters and newlines are neutralised and the MIDDLE of a
// long value is elided, so two long names sharing a prefix (or a spoofed line break) stay distinguishable.
export function showValue(v: unknown, head = 120, tail = 60): string {
  const t = (typeof v === "string" ? v : JSON.stringify(v) ?? String(v)).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, " ");
  return t.length > head + tail + 1 ? `${t.slice(0, head)}…${t.slice(-tail)}` : t;
}

// Characters that change how text is laid out or hide it: bidi embeddings/overrides/isolates and marks, zero-width and
// joiner characters, the BOM, soft hyphen, line/paragraph separators and Unicode tag characters. Shown as a visible \uXXXX so
// the human sees that something is there instead of a silently reordered or invisible name.
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|[\u{e0000}-\u{e007f}]/gu;
// CSI (ESC [ ... final), OSC (ESC ] ... BEL or ST) and other two-byte ESC sequences.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;

/**
 * Like showValue, for text a human decides on (approval prompts). Also neutralises ANSI escape sequences, C1 controls,
 * bidi overrides/isolates and zero-width characters, and elides the middle of anything over head+tail characters,
 * appending the original length so an elided value is recognisable as such.
 */
export function showValueStrict(v: unknown, head = 120, tail = 60): string {
  const raw = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  const t = raw
    .replace(ANSI, "\\x1b")
    .replace(INVISIBLE, (c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  return t.length > head + tail + 1 ? `${t.slice(0, head)}…${t.slice(-tail)} [${raw.length} chars]` : t;
}
