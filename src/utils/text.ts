// Text shown to the human or echoed in errors: control characters and newlines are neutralised and the MIDDLE of a
// long value is elided, so two long names sharing a prefix (or a spoofed line break) stay distinguishable.
export function showValue(v: unknown, head = 120, tail = 60): string {
  const t = (typeof v === "string" ? v : JSON.stringify(v) ?? String(v)).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, " ");
  return t.length > head + tail + 1 ? `${t.slice(0, head)}…${t.slice(-tail)}` : t;
}

// Characters that change how text is laid out or hide it: bidi embeddings/overrides/isolates and marks, zero-width and
// joiner characters, the BOM, soft hyphen, line/paragraph separators and Unicode tag characters. Shown as a visible \uXXXX so
// the human sees that something is there instead of a silently reordered or invisible name.
// Also every Unicode format character (\p{Cf}) and the default-ignorable look-alikes of a space: Hangul fillers, combining grapheme
// joiner, variation selectors, interlinear annotation marks, musical format characters and Mongolian free variation selectors.
// Blank-looking characters are escaped too: no-break and wide spaces (U+00A0, U+2000-200A, U+202F, U+205F, U+3000) and the Braille blank
// (U+2800) look like a space or nothing, so "Tax File" with one of them would pass for another name.
const INVISIBLE = /[\p{Cf}\u00a0\u00ad\u034f\u061c\u115f\u1160\u180b-\u180e\u2000-\u200f\u2028\u2029\u202a-\u202f\u205f-\u2064\u2066-\u2069\u2800\u3000\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]|[\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// CSI (ESC [ ... final), OSC (ESC ] ... BEL or ST) and other two-byte ESC sequences.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;

const SCRUB = new RegExp(`${ANSI.source}|\\\\|${INVISIBLE.source}`, "gu");

/**
 * Like showValue, for text a human decides on (approval prompts). Also neutralises ANSI escape sequences, C1 controls,
 * bidi overrides/isolates and zero-width characters, and elides the middle of anything over head+tail characters,
 * appending the original length so an elided value is recognisable as such.
 */
export function showValueStrict(v: unknown, head = 120, tail = 60): string {
  const raw = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  // One pass, so an escape this function writes is never read again as input. A literal backslash is doubled: the text `\u200b` in
  // a name then differs from a real zero-width space shown as `\u200b`.
  const t = raw
    .replace(SCRUB, (m) => (m === "\\" ? "\\\\" : m[0] === "\x1b" ? "\\x1b" : `\\u${m.codePointAt(0)!.toString(16).padStart(4, "0")}`))
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  return t.length > head + tail + 1 ? `${t.slice(0, head)}…${t.slice(-tail)} [${raw.length} chars]` : t;
}
