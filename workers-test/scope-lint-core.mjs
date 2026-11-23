// Per-query scope lint (CR 5940418854 condition 1). Every SQL string literal that touches a
// PT-owned table is identified by file :: enclosing function :: fingerprint of the
// normalised SQL. Each must be allowlisted individually (scope-lint.test.mjs); a new or
// edited query anywhere fails until it is reviewed. Pure JS so it also runs under Node.
// PT-owned (or per-tenant secret) tables. CR 5940914487 M4: also pts, users and the Stripe
// account/credential tables; table names may be quoted ("x", `x`, [x]), schema-qualified
// (main.x) or separated from the keyword by comments (FROM/**/x, FROM -- c\n x).
export const TABLES = ['blocks', 'bookings', 'class_sessions', 'attendance', 'email_outbox', 'discount_codes', 'discount_redemptions', 'waitlist_entries', 'stripe_refunds', 'stripe_jobs', 'pts', 'users', 'stripe_connections', 'pt_stripe_credentials', 'pt_subscriptions', 'block_payment_plans', 'booking_instalments'];
const GAP = '(?:\\s|/\\*[\\s\\S]*?\\*/|--[^\\n]*(?:\\n|$))';
const OPEN = '["\\u0060\\[]?', CLOSE = '["\\u0060\\]]?';
const NAME = OPEN + '(?:' + TABLES.join('|') + ')' + CLOSE;
const QUALIFIER = '(?:' + OPEN + '\\w+' + CLOSE + GAP + '*\\.' + GAP + '*)?';
// CR 5941600057 M4: a comma join (`FROM (SELECT 1) z, bookings b`) names a table after ','.
export const PT_OWNED = new RegExp('(?:\\b(?:FROM|JOIN|UPDATE|INTO)|,)(?:' + GAP + '*?(?=["\\u0060\\[])|' + GAP + '+|(?=\\w))' + QUALIFIER + NAME + '(?!\\w|' + GAP + '*\\.)', 'i'); // `, pts.slug` is a column, not a table

/** String/template literals with their start offsets. Templates: ${...} becomes ${}; nested
 *  literals inside expressions are returned separately. Comments are skipped. */
const ESCAPES = { n: '\n', r: '\r', t: '\t', v: '\v', f: '\f', b: '\b', 0: '\0' };
/** One escape sequence at src[i] === '\\': [decoded text, length consumed]. CR 5941600057 M4:
 *  \xHH, \uHHHH and \u{H...} are decoded (`\u0062ookings` is `bookings`); a backslash-newline
 *  line continuation is dropped. */
function unescapeAt(src, i) {
  const c = src[i + 1];
  let m;
  if (c === 'x' && (m = /^[0-9a-fA-F]{2}/.exec(src.slice(i + 2)))) return [String.fromCharCode(parseInt(m[0], 16)), 4];
  if (c === 'u' && (m = /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(i + 2)))) return [String.fromCodePoint(parseInt(m[1], 16)), 2 + m[0].length];
  if (c === 'u' && (m = /^[0-9a-fA-F]{4}/.exec(src.slice(i + 2)))) return [String.fromCharCode(parseInt(m[0], 16)), 6];
  if (c === '\r' && src[i + 2] === '\n') return ['', 3];
  if (c === '\n' || c === '\r') return ['', 2];
  return [ESCAPES[c] ?? c, 2];
}

export function literals(src, comments = []) {
  const out = [];
  let i = 0;
  const n = src.length;
  function readQuoted(q) {
    const start = i; i++;
    let s = '';
    while (i < n && src[i] !== q) { if (src[i] === '\\') { const [t, len] = unescapeAt(src, i); s += t; i += len; } else s += src[i++]; }
    i++;
    out.push({ start, end: i, text: s });
  }
  function readTemplate() {
    const start = i; i++;
    let s = '';
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { const [t, len] = unescapeAt(src, i); s += t; i += len; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; s += '${}'; readCode(true); continue; }
      s += src[i++];
    }
    i++;
    out.push({ start, end: i, text: s });
  }
  function readCode(untilBrace) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { const s0 = i; while (i < n && src[i] !== '\n') i++; comments.push([s0, i]); continue; }
      if (c === '/' && src[i + 1] === '*') { const s0 = i; i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; comments.push([s0, i]); continue; }
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

/** Source with every string/template literal and comment blanked (same offsets), so code
 *  patterns can be matched without false hits inside strings or comments. */
export function masked(src) {
  const comments = [];
  const lits = literals(src, comments);
  const chars = src.split('');
  for (const [a, b] of [...lits.map(l => [l.start, l.end]), ...comments]) for (let k = a; k < b; k++) if (chars[k] !== '\n') chars[k] = ' ';
  return { text: chars.join(''), lits };
}

const SQL_CALL = /(?:\b(?:db|d1|sqlite|database)\s*\.\s*(get|all|run|stmt|guard|exec)|\.\s*(prepare))\s*\(/g;

/** Every SQL call whose SQL argument is NOT a single plain string literal: concatenation or
 *  any other expression (expr), a template with ${...} (dynamic), or an identifier (const or
 *  parameter). Each must be allowlisted by key; a plain literal is covered by ptOwnedQueries. */
export function nonLiteralSqlCalls(sources) {
  const found = [];
  for (const [file, src] of Object.entries(sources)) {
    const { text, lits } = masked(src);
    const litAt = new Map(lits.map(l => [l.start, l]));
    SQL_CALL.lastIndex = 0;
    let m;
    while ((m = SQL_CALL.exec(text))) {
      let p = m.index + m[0].length;
      const skipWs = () => { while (/\s/.test(src[p] || '')) p++; };
      skipWs();
      if (m[1] === 'guard') { // guard(name, condition, ...): the SQL is the 2nd argument
        const name = litAt.get(p);
        if (!name) { found.push(entry(file, src, m.index, 'expr', argText(src, text, p))); continue; }
        p = name.end; skipWs();
        if (src[p] !== ',') { found.push(entry(file, src, m.index, 'expr', argText(src, text, p))); continue; }
        p++; skipWs();
      }
      const lit = litAt.get(p);
      if (lit) {
        let q = lit.end; while (/\s/.test(src[q] || '')) q++;
        if (src[q] !== ',' && src[q] !== ')') found.push(entry(file, src, m.index, 'expr', argText(src, text, p)));
        else if (src[lit.start] === '`' && lit.text.includes('${}')) found.push(entry(file, src, m.index, 'dynamic', lit.text));
        continue;
      }
      const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(p));
      let q = p + (id ? id[0].length : 0); while (/\s/.test(src[q] || '')) q++;
      if (id && (src[q] === ',' || src[q] === ')')) found.push(entry(file, src, m.index, 'ident:' + id[0], ''));
      else found.push(entry(file, src, m.index, 'expr', argText(src, text, p)));
    }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
}
function argText(src, text, p) { // up to the top-level ',' or ')' (masked text keeps offsets)
  let depth = 0, q = p;
  for (; q < text.length; q++) { const c = text[q]; if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) { if (depth === 0) break; depth--; } else if (c === ',' && depth === 0) break; }
  return src.slice(p, q);
}
function entry(file, src, offset, kind, body) {
  return { key: `${file}::${enclosing(src, offset)}::${kind}${body ? '::' + fingerprint(body) : ''}`, sql: normaliseSql(body) };
}

/** Raw access that would let code reach D1 without going through a visible SQL call. */
export function rawAccess(sources) {
  const rules = [
    [/\bdb\s*\[/, 'db[...]'],
    [/\bdb\s*\.\s*(get|all|run|stmt|guard|prepare|exec|batch)\b(?!\s*\()/, 'db method reference'],
    [/\{[^}]*\}\s*=\s*db\b/, 'destructured db'],
    [/\{\s*(?:[\w$]+\s*(?::\s*[\w$]+\s*)?,\s*)*(?:all|stmt|guard|batch|d1|prepare)\b[^}]*\}\s*(?:=[^=>]|\)\s*=>)/, 'destructured SQL method'],
    [/\.\s*d1\b/, '.d1 (raw binding)'],
    // CR 5941600057 M4: `const q = db`, `{ h: db }`, `x => db`, `c ? db : ...` (an alias of the
    // wrapper; calls on it are also caught by foreignReceiverCalls).
    [/(?:(?<![=!<>])=(?![=>])|:|=>|\?)\s*(?:this\s*\.\s*)?db\b(?!\s*(?:[.\w$]|=>))/, 'db alias'],
    // The raw binding: only `createDb(env.DB)` at the entry points may name DB (blanked below);
    // `const { DB: x } = env`, `env.DB`, `foo(env.DB)` are all reported.
    [/\bDB\b/, 'raw DB binding'],
    [/\{[^{}]*\}\s*=\s*(?:this\s*\.\s*)?env\b/, 'destructured env'],
    [/\b(?:env|this\s*\.\s*env)\s*\[/, 'computed env access'],
    [/\bthis\s*\.\s*env\b/, 'this.env (raw Durable Object env)'],
    [/\bReflect\b/, 'Reflect']
  ];
  const out = [];
  for (const [file, src] of Object.entries(sources)) {
    if (file.endsWith('/src/db.mjs')) continue;
    const text = masked(src).text.replace(/createDb\(\s*env\s*\.\s*DB\s*\)/g, m => 'createDb(' + ' '.repeat(m.length - 10) + ')');
    for (const [re, what] of rules) { const g = new RegExp(re.source, 'g' + re.flags.replace('g', '')); let m; while ((m = g.exec(text))) out.push(`${file}::${enclosing(src, m.index)}::${what}`); }
    // The platform env (with the raw DB binding) is importable from any module: only the
    // Writer's `import { DurableObject } from 'cloudflare:workers'` is allowed.
    for (const m of src.matchAll(/cloudflare:workers/g)) {
      const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index) < 0 ? undefined : src.indexOf('\n', m.index));
      if (!/^import \{ DurableObject \} from 'cloudflare:workers';$/.test(line.trim())) out.push(`${file}::${enclosing(src, m.index)}::cloudflare:workers import`);
    }
  }
  return out.sort();
}

// Receivers whose get/all/run/... are never D1 (standard library and request objects).
export const SAFE_RECEIVERS = new Set(['Promise', 'request.headers', 'headers', 'url.searchParams', 'searchParams']);
const DB_RECEIVERS = new Set(['db', 'this.db', 'd1', 'sqlite', 'database']);

/** CR 5941600057 M4: a get/all/run/stmt/exec/prepare/batch/guard call on ANY receiver other
 *  than the `db` wrapper (whose calls are linted as SQL calls) or a statement returned by
 *  prepare()/stmt(). Catches aliases (`q.all`, `o.h.all`, `(await x).all`). Each is reported as
 *  `file::fn::receiver:<receiver>.<method>` and must be allowlisted (RECEIVERS in the test). */
export function foreignReceiverCalls(sources) {
  const out = [];
  for (const [file, src] of Object.entries(sources)) {
    if (file.endsWith('/src/db.mjs')) continue;
    const { text } = masked(src);
    for (const m of text.matchAll(/\.\s*(get|all|run|stmt|exec|prepare|batch|guard)\s*\(/g)) {
      let p = m.index - 1;
      while (p >= 0 && /\s/.test(text[p])) p--;
      let receiver;
      if (text[p] === ')' || text[p] === ']') {
        const close = text[p], open = close === ')' ? '(' : '[';
        let depth = 0, q = p;
        for (; q >= 0; q--) { if (text[q] === close) depth++; else if (text[q] === open && --depth === 0) break; }
        const before = /([\w$.\s]*)$/.exec(text.slice(Math.max(0, q - 80), q))[1].replace(/\s+/g, '');
        if (close === ')' && /(?:^|\.)(?:prepare|stmt)$/.test(before)) continue; // statement from a linted prepare()/stmt()
        receiver = (before || '') + (close === ')' ? '(...)' : '[...]');
      } else {
        receiver = /((?:[\w$]+\s*\.\s*)*[\w$]+)$/.exec(text.slice(Math.max(0, p - 120), p + 1))?.[1].replace(/\s+/g, '') || '?';
      }
      if (DB_RECEIVERS.has(receiver) || SAFE_RECEIVERS.has(receiver)) continue;
      out.push(`${file}::${enclosing(src, m.index)}::receiver:${receiver}.${m[1]}`);
    }
  }
  return [...new Set(out)].sort();
}

/** Module-level constants holding PT-owned SQL, and every use of one outside its own file
 *  (import or reference): `file::uses:NAME`. Reusing an allowlisted query elsewhere must be
 *  allowlisted too. */
export function sqlConstantUses(sources) {
  const owners = new Map();
  for (const q of ptOwnedQueries(sources)) {
    const [file, fn] = q.key.split('::');
    if (fn.includes('>') || fn === '<module>') continue;
    // SQL-holding constants: a string/template, or an arrow returning one or an array of them.
    if (new RegExp('(?:^|\\n)(?:export\\s+)?const\\s+' + fn + '\\s*=\\s*(?:[\'"\\u0060]|\\([^)]*\\)\\s*=>\\s*[\\[\\u0060\'"])').test(sources[file])) owners.set(fn, file);
  }
  const out = [];
  for (const [file, src] of Object.entries(sources)) {
    const { text } = masked(src);
    for (const [name, owner] of owners) if (owner !== file && new RegExp('\\b' + name + '\\b').test(text)) out.push(`${file}::uses:${name}`);
  }
  return out.sort();
}

/** SQL calls of any kind in one file (worker/index.mjs must have none). */
export function sqlCallCount(src) {
  const { text } = masked(src);
  return [...text.matchAll(SQL_CALL)].length + [...text.matchAll(/\.\s*(batch|prepare|exec)\s*\(/g)].length;
}

// ---- QA D2 (f978692): which files the lint covers -------------------------------------------
// Before: only src/**/*.mjs, worker/**/*.mjs and scripts/**/*.mjs were globbed, so unscoped SQL in
// src/x.js, or in any file outside those folders that the Worker imports, was never read. Now the
// lint set is (1) every file reachable through the import graph from the Worker entries and the
// scripts, resolving relative imports for every JS/TS extension and index files, plus (2) a
// backstop of every JS/TS file under src/, worker/ and scripts/. Anything the graph cannot
// account for (a relative import that does not resolve, a non-literal import()/require(), an
// absolute/#/file: specifier, a Worker import of legacy code) is itself a violation.
export const JS_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx'];
const isJs = f => JS_EXTENSIONS.some(e => f.endsWith(e));
const LEGACY = /^\.\.\/(?:app|netlify)\//;
const BACKSTOP = /^\.\.\/(?:src|worker|scripts)\//;
const EXCLUDED = /(?:^|\/)(?:node_modules|tests?|workers-test|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

function normalise(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length && out.at(-1) !== '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}
/** Resolve a relative specifier from a file key ('../src/a.mjs') against the known files. */
export function resolveImport(from, spec, files) {
  const base = normalise(from.slice(0, from.lastIndexOf('/') + 1) + spec);
  const swapped = /\.(?:js|mjs|cjs|jsx)$/.test(base) ? ['.ts', '.mts', '.cts', '.tsx'].map(e => base.replace(/\.[^./]+$/, e)) : []; // TS: './x.js' -> x.ts
  const candidates = [base, ...swapped, ...JS_EXTENSIONS.map(e => base + e), ...JS_EXTENSIONS.map(e => base + '/index' + e)];
  return candidates.find(c => c in files) ?? null;
}
/** Module specifiers in one source: static import/export-from, import(), require(). */
export function importSpecifiers(src) {
  const comments = [];
  literals(src, comments);
  let code = src;
  for (const [a, b] of comments) code = code.slice(0, a) + ' '.repeat(b - a) + code.slice(b);
  const out = [];
  for (const m of code.matchAll(/(?:^|[^\w$.])(?:import|export)\s*(?:type\s+)?(?:[\w$*{}\s,]+?\s*from\s*)?(['"])([^'"\n]+)\1/g)) out.push({ spec: m[2], kind: 'static' });
  for (const m of code.matchAll(/(?:^|[^\w$.])(import|require)\s*\(\s*([^)]*?)\s*\)/g)) {
    const lit = /^(['"`])([^'"`$\n]+)\1$/.exec(m[2]);
    out.push(lit ? { spec: lit[2], kind: m[1] } : { spec: null, kind: m[1], expr: m[2].slice(0, 60) });
  }
  return out;
}
/** Walk the import graph. `aliases` maps generated specifiers (file::spec) to a real file. */
// CR 5943169048 C1: a relative import that resolves outside src/, worker/ and scripts/ is also
// reported on its own (the file is still scanned), unless the edge is listed in outsideEdges.
export function importGraph(entries, files, { aliases = {}, legacyEdges = [], workerEntries = [], outsideEdges = [] } = {}) {
  const reached = new Set(), problems = [], legacy = [];
  const workerReach = new Set();
  const walk = (start, marks) => {
    const queue = [start];
    while (queue.length) {
      const f = queue.shift();
      if (marks.has(f)) continue;
      marks.add(f);
      for (const { spec, kind, expr } of importSpecifiers(files[f] ?? '')) {
        if (spec === null) { problems.push(`${f}::non-literal ${kind}(${expr})`); continue; }
        if (!spec.startsWith('.') && !spec.startsWith('/')) {
          if (/^(?:#|file:|data:|https?:)/.test(spec)) problems.push(`${f}::unsupported specifier ${spec}`);
          continue; // packages and node:/cloudflare: built-ins (not repo code)
        }
        if (spec.startsWith('/')) { problems.push(`${f}::absolute specifier ${spec}`); continue; }
        const aliased = aliases[`${f}::${spec}`];
        if (aliased === null) continue; // generated data module (listed)
        const target = aliased ?? resolveImport(f, spec, files);
        if (!target) {
          if (!isJs(spec) && /\.[a-z0-9]+$/i.test(spec)) continue; // data import (.txt/.html/.sql/.json): its use is linted at the call site
          problems.push(`${f}::unresolved import ${spec}`); continue;
        }
        if (LEGACY.test(target)) { legacy.push(`${f} -> ${target}`); continue; } // legacy Netlify app: not walked
        if (!BACKSTOP.test(target) && !outsideEdges.includes(`${f} -> ${target}`)) problems.push(`${f} -> ${target}::import outside the scanned roots (src/, worker/, scripts/)`);
        queue.push(target);
      }
    }
  };
  for (const e of workerEntries) walk(e, workerReach);
  for (const e of entries) walk(e, reached);
  for (const f of workerReach) reached.add(f);
  const uniq = [...new Set(legacy)];
  for (const edge of uniq) {
    const from = edge.split(' -> ')[0];
    if (workerReach.has(from)) problems.push(`${edge}::Worker code imports legacy code`);
    else if (!legacyEdges.includes(edge)) problems.push(`${edge}::unlisted import of legacy code`);
  }
  for (const edge of legacyEdges) if (!uniq.includes(edge)) problems.push(`${edge}::stale legacy edge`);
  return { reached, problems: [...new Set(problems)].sort(), legacy: uniq.sort() };
}
/** The files the scope lint reads: graph ∪ backstop (all JS/TS under src/, worker/, scripts/). */
export function lintSet(files, opts) {
  const g = importGraph([...(opts.entries || []), ...(opts.workerEntries || [])], files, opts);
  const set = new Set(g.reached);
  for (const f of Object.keys(files)) if (BACKSTOP.test(f) && isJs(f) && !EXCLUDED.test(f)) set.add(f);
  const sources = Object.fromEntries([...set].filter(f => f in files && !LEGACY.test(f)).sort().map(f => [f, files[f]]));
  return { sources, problems: g.problems, legacy: g.legacy, graph: [...g.reached].sort() };
}

// `node workers-test/scope-lint-core.mjs` prints the current keys (to update the allowlist).
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('scope-lint-core.mjs')) {
  const fs = await import('node:fs');
  const files = ['src', 'worker', 'scripts'].flatMap(d => fs.readdirSync(d, { recursive: true }).filter(f => isJs(f)).map(f => `${d}/${f}`)); // backstop set; the test adds the import graph
  const sources = Object.fromEntries(files.map(f => ['../' + f, fs.readFileSync(f, 'utf8')]));
  for (const q of ptOwnedQueries(sources)) console.log(q.key, '|', q.sql);
  for (const q of nonLiteralSqlCalls(sources)) console.log('NONLITERAL', q.key, '|', q.sql.slice(0, 100));
  for (const r of rawAccess(sources)) console.log('RAW', r);
  for (const r of foreignReceiverCalls(sources)) console.log('RECEIVER', r);
  for (const r of sqlConstantUses(sources)) console.log('USES', r);
}
