// Text shown to the human or echoed in errors: control characters and newlines are neutralised and the MIDDLE of a
// long value is elided, so two long names sharing a prefix (or a spoofed line break) stay distinguishable.
export function showValue(v: unknown, head = 120, tail = 60): string {
  const t = (typeof v === "string" ? v : JSON.stringify(v) ?? String(v)).replace(/[\x00-\x1f\x7f\u2028\u2029]/g, " ");
  return t.length > head + tail + 1 ? `${t.slice(0, head)}…${t.slice(-tail)}` : t;
}
