// Glob subset: * (no '/'), ** (anything, including '/'), ?  (one char, not '/').
// Table-driven matching over the pattern tokens: O(pattern * text) worst case and no regex is
// ever compiled, so a model-supplied pattern cannot cause catastrophic backtracking.
const STAR = 1; // * : any run without '/'
const ANY = 2; // ** (or more): any run including '/'
const ONE = 3; // ?

export function globMatch(pattern: string, text: string, ignoreCase = false): boolean {
  const pat = ignoreCase ? pattern.toLowerCase() : pattern;
  const txt = ignoreCase ? text.toLowerCase() : text;
  const kinds: number[] = [];
  const lits: string[] = [];
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") {
      let run = 1;
      while (pat[i + 1] === "*") { run++; i++; }
      kinds.push(run >= 2 ? ANY : STAR); lits.push("");
    } else { kinds.push(c === "?" ? ONE : 0); lits.push(c); }
  }
  const m = kinds.length;
  let cur = new Uint8Array(m + 1);
  let next = new Uint8Array(m + 1);
  cur[0] = 1;
  for (let j = 1; j <= m; j++) cur[j] = kinds[j - 1] === STAR || kinds[j - 1] === ANY ? cur[j - 1] : 0;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    const slash = c === "/";
    next[0] = 0;
    for (let j = 1; j <= m; j++) {
      const k = kinds[j - 1];
      next[j] = k === ANY ? (next[j - 1] | cur[j])
        : k === STAR ? (next[j - 1] | (slash ? 0 : cur[j]))
        : k === ONE ? (slash ? 0 : cur[j - 1])
        : (lits[j - 1] === c ? cur[j - 1] : 0);
    }
    [cur, next] = [next, cur];
  }
  return cur[m] === 1;
}
