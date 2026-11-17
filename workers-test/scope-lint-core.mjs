// Per-query scope lint (CR 5940418854 condition 1). Every SQL string literal that touches a
// PT-owned table is identified by file :: enclosing function :: fingerprint of the
// normalised SQL. Each must be allowlisted individually (scope-lint.test.mjs); a new or
// edited query anywhere fails until it is reviewed. Pure JS so it also runs under Node.
export const PT_OWNED = /\b(FROM|JOIN|UPDATE|INTO)\s+(blocks|bookings|class_sessions|attendance|email_outbox|discount_codes|discount_redemptions|waitlist_entries|stripe_refunds|stripe_jobs)\b/i;

/** String/template literals with their start offsets. Templates: ${...} becomes ${}; nested
 *  literals inside expressions are returned separately. Comments are skipped. */
export function literals(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  function readQuoted(q) {
    const start = i; i++;
    let s = '';
    while (i < n && src[i] !== q) { if (src[i] === '\\') { s += src[i + 1]; i += 2; } else s += src[i++]; }
    i++;
    out.push({ start, text: s });
  }
  function readTemplate() {
    const start = i; i++;
    let s = '';
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { s += src[i + 1]; i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; s += '${}'; readCode(true); continue; }
      s += src[i++];
    }
    i++;
    out.push({ start, text: s });
  }
  function readCode(untilBrace) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
      if (c === "'" || c === '"') { readQuoted(c); continue; }
      if (c === '`') { readTemplate(); continue; }
      if (c === '/' && /[=(,:;!&|?{}\[]\s*$/.test(src.slice(Math.max(0, i - 20), i)) && src[i + 1] !== '/') {
        // regex literal: skip to its closing slash
        i++; let cls = false;
        while (i < n && (src[i] !== '/' || cls)) { if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; i++; }
        i++; continue;
      }
      if (untilBrace) { if (c === '{') depth++; else if (c === '}') { if (depth === 0) { i++; return; } depth--; } }
      i++;
    }
  }
  readCode(false);
  return out;
}

// Function-level names only: function declarations, const arrow/function expressions,
// object/class methods, and top-level constants (SQL kept in module constants).
const DECL = /(?:^|\n)(?:[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)|[ \t]*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|\([^)\n]*\)\s*=>|\w+\s*=>)|(?:export\s+)?const\s+(\w+)\s*=|[ \t]+(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)\n]*\)\s*\{)/g;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function']);

/** "outer" or "outer>inner": the top-level declaration containing `offset`, plus the
 *  nested function/method containing it. A nested declaration's extent ends at the first
 *  later line indented no deeper than the declaration (code here is consistently indented). */
export function enclosing(src, offset) {
  let outer = '<module>', inner = null, m;
  DECL.lastIndex = 0;
  while ((m = DECL.exec(src)) && m.index < offset) {
    const found = m[1] || m[2] || m[3] || m[4];
    if (!found || KEYWORDS.has(found)) continue;
    const at = m.index + (m[0].startsWith('\n') ? 1 : 0);
    const indent = /^[ \t]*/.exec(src.slice(at))[0].length;
    if (indent === 0) { outer = found; inner = null; continue; }
    const lineEnd = src.indexOf('\n', at);
    const rest = src.slice(lineEnd + 1, offset).split('\n');
    rest.pop(); // the line holding the literal itself
    const closed = rest.some(line => line.trim() && /^[ \t]*/.exec(line)[0].length <= indent);
    if (!closed && lineEnd < offset) inner = found;
    else if (!closed) inner = found;
  }
  return inner ? `${outer}>${inner}` : outer;
}

export const normaliseSql = sql => sql.replace(/\s+/g, ' ').trim();

// FNV-1a 32-bit, hex: short, stable fingerprint of a normalised query.
export function fingerprint(sql) {
  let h = 0x811c9dc5;
  for (const ch of normaliseSql(sql)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** All PT-owned queries in the given { file: source } map, as sorted keys. */
export function ptOwnedQueries(sources) {
  const found = [];
  for (const [file, src] of Object.entries(sources)) {
    for (const lit of literals(src)) {
      if (!PT_OWNED.test(lit.text)) continue;
      found.push({ key: `${file}::${enclosing(src, lit.start)}::${fingerprint(lit.text)}`, sql: normaliseSql(lit.text) });
    }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

// `node workers-test/scope-lint-core.mjs` prints the current keys (to update the allowlist).
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('scope-lint-core.mjs')) {
  const fs = await import('node:fs');
  const files = ['src', 'worker', 'scripts'].flatMap(d => fs.readdirSync(d, { recursive: true }).filter(f => f.endsWith('.mjs')).map(f => `${d}/${f}`));
  const sources = Object.fromEntries(files.map(f => ['../' + f, fs.readFileSync(f, 'utf8')]));
  for (const q of ptOwnedQueries(sources)) console.log(q.key, '|', q.sql);
}
