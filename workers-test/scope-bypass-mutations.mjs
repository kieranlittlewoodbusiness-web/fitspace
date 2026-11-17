#!/usr/bin/env node
// CR 5941600057 M4 mutation run. Injects each bypass CR reported at 036cb53 into the PT
// dashboard path, in worker/index.mjs and in src/views.mjs, then runs (1) the scope lint and
// (2) the runtime cross-PT test. KILLED = both fail. The SQL is split ('SELECT b.* FROM' +
// 'bookings b') wherever CR's case is an alias, so only the new rules can catch it.
// Kept outside src/worker/scripts on purpose: its strings ARE the bypasses. Local only.
//   node workers-test/scope-bypass-mutations.mjs [name ...]
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

// If the run is interrupted, put the mutated file back before exiting.
let pending = null; // [file, original]
let created = []; // files a case created (deleted on exit)
const restore = () => {
  if (pending) { writeFileSync(pending[0], pending[1]); pending = null; }
  for (const f of created) rmSync(f, { force: true });
  for (const d of ['lib/qa-dir']) if (existsSync(d) && !readdirSync(d).length) rmSync(d, { recursive: true });
  created = [];
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restore(); process.exit(130); });
process.on('exit', restore);

const SPLIT = "['SELECT b.* FROM', 'bookings b'].join(' ')";
const CASES = {
  db_alias: `(() => { const h = db; return h.all(${SPLIT}); })()`,
  object_property_alias: `(() => { const o = { h: db }; return o.h.all(${SPLIT}); })()`,
  env_destructuring: `(async () => { const { DB: x } = env; return (await x.prepare(${SPLIT}).all()).results; })()`,
  comma_join: "db.all('SELECT b.* FROM (SELECT 1) z, bookings b')",
  unicode_escape: "db.all('SELECT b.* FROM \\u0062ookings b')",
  hex_escape: "db.all('SELECT b.* FROM \\x62ookings b')"
};
const VIEWS_FROM = "    const bookings = await withSessions(db, await scope.bookings(), { reasons: true });\n    const outbox";
const INDEX_FROM = 'return json(200, await dashboard(db, user, { paymentMode, integration }));';
const TARGETS = {
  views: ['src/views.mjs', VIEWS_FROM, c => `    const bookings = await withSessions(db, await ${c}, { reasons: true });\n    const outbox`,
    // views has no env parameter: CR's env case there needs the platform env.
    src => src.replace("import { scopeFor } from './scope.mjs';", "import { scopeFor } from './scope.mjs';\nimport { env } from 'cloudflare:workers';")],
  index: ['worker/index.mjs', INDEX_FROM, c => `return json(200, { bookings: await ${c} });`, src => src]
};
const vitest = file => spawnSync('node_modules/.bin/vitest', ['run', '--config', 'vitest.workers.config.mjs', file], { encoding: 'utf8', timeout: 600000 });
const summary = run => { const out = (run.stdout || '') + (run.stderr || ''); return { failed: run.status !== 0, tests: (out.match(/Tests\s+[^\n]+/) || ['?'])[0].trim(), first: (out.match(/(AssertionError|Error): [^\n]{0,120}/) || [''])[0] }; };

const only = process.argv.slice(2);
const rows = [];
for (const [where, [file, from, to, prep]] of Object.entries(TARGETS)) {
  for (const [name, code] of Object.entries(CASES)) {
    if (only.length && !only.includes(name)) continue;
    const original = readFileSync(file, 'utf8');
    if (original.split(from).length !== 2) { rows.push({ where, name, result: 'ERROR: anchor not found once' }); continue; }
    let mutated = original.replace(from, to(code));
    if (name === 'env_destructuring') mutated = prep(mutated);
    pending = [file, original]; writeFileSync(file, mutated);
    try {
      const lint = summary(vitest('workers-test/scope-lint.test.mjs'));
      const rt = summary(vitest('workers-test/scope-runtime.test.mjs'));
      rows.push({ where, name, lint: lint.failed ? 'FAIL' : 'pass', runtime: rt.failed ? 'FAIL' : 'pass', runtimeDetail: rt.tests + (rt.first ? ' | ' + rt.first : ''), result: lint.failed && rt.failed ? 'KILLED' : 'SURVIVED' });
    } finally { writeFileSync(file, original); pending = null; }
  }
}
// Paired case: CR's env-destructuring bypass in index WITHOUT the structural guard (withoutDb)
// must LEAK (cross-PT rows, not a 503), proving withoutDb is what makes it fail closed.
if (!only.length || only.includes('env_destructuring_without_withoutDb')) {
  const file = 'worker/index.mjs', original = readFileSync(file, 'utf8');
  const mutated = original.replace(INDEX_FROM, TARGETS.index[2](CASES.env_destructuring)).replace('  env = withoutDb(env);\n', '  env = { ...env };\n');
  pending = [file, original]; writeFileSync(file, mutated);
  try {
    const rt = summary(vitest('workers-test/scope-runtime.test.mjs'));
    const leaked = /expected \[ …\(4\) \] to deeply equal \[ …\(2\) \]/.test(rt.first);
    rows.push({ where: 'index', name: 'env_destr_no_withoutDb', lint: '-', runtime: rt.failed ? 'FAIL' : 'pass', runtimeDetail: rt.tests + ' | ' + rt.first, result: leaked ? 'KILLED' : 'SURVIVED' });
  } finally { writeFileSync(file, original); pending = null; }
}
// QA D2 (f978692): file discovery. A NEW file holding unscoped SQL, imported into the PT
// dashboard path. Before D2 the lint never read src/*.js or files outside src/worker/scripts.
const LEAK_SQL = "'SELECT b.* FROM bookings b'";
const FILE_CASES = {
  js_in_src: { target: 'views', file: 'src/qa-leak-hidden.js', spec: './qa-leak-hidden.js', code: `export const hidden = (db) => db.all(${LEAK_SQL});\n` },
  outside_mjs: { target: 'views', file: 'lib/qa-leak.mjs', spec: '../lib/qa-leak.mjs', code: `export const hidden = (db) => db.all(${LEAK_SQL});\n` },
  outside_index_js: { target: 'views', file: 'lib/qa-dir/index.js', spec: '../lib/qa-dir/index.js', code: `export const hidden = (db) => db.all(${LEAK_SQL});\n` },
  ts_in_src: { target: 'views', file: 'src/qa-leak-hidden.ts', spec: './qa-leak-hidden.ts', code: `type Db = { all(sql: string, ...a: unknown[]): Promise<unknown[]> };\nexport const hidden = (db: Db): Promise<unknown[]> => db.all(${LEAK_SQL});\n` },
  outside_ts: { target: 'views', file: 'lib/qa-leak.ts', spec: '../lib/qa-leak.ts', code: `export const hidden = (db: { all(q: string): Promise<unknown[]> }) => db.all(${LEAK_SQL});\n` },
  // QA's exact miss 1: src/*.js reading env.DB, imported from the Worker entry.
  // CR 5943169048 C1, verbatim: the helper takes the SQL; the call site builds it in views.
  cr_zzhelper: { target: 'views', file: 'lib/zzhelper.mjs', code: 'export const q=(db,s)=>db.all(s)\n', importLine: "import { q } from '../lib/zzhelper.mjs';\n", call: "q(db,'SELECT * FROM '+'bookings')" },
  js_env_db_from_worker: { target: 'index', file: 'src/qa-leak-env.js', spec: '../src/qa-leak-env.js', code: `export const hidden = async (env) => (await env.DB.prepare(${LEAK_SQL}).all()).results;\n`, arg: 'env' }
};
for (const [name, c] of Object.entries(FILE_CASES)) {
  if (only.length && !only.includes(name)) continue;
  const [file, from, to] = TARGETS[c.target];
  const original = readFileSync(file, 'utf8');
  if (existsSync(c.file)) { rows.push({ where: c.target, name, result: 'ERROR: ' + c.file + ' exists' }); continue; }
  mkdirSync(dirname(c.file), { recursive: true });
  created = [c.file]; writeFileSync(c.file, c.code);
  pending = [file, original];
  writeFileSync(file, (c.importLine ?? `import { hidden as qaHidden } from '${c.spec}';\n`) + original.replace(from, to(c.call ?? `qaHidden(${c.arg || 'db'})`)));
  try {
    const lint = summary(vitest('workers-test/scope-lint.test.mjs'));
    const rt = summary(vitest('workers-test/scope-runtime.test.mjs'));
    rows.push({ where: c.target, name, lint: lint.failed ? 'FAIL' : 'pass', runtime: rt.failed ? 'FAIL' : 'pass', runtimeDetail: rt.tests + (rt.first ? ' | ' + rt.first : ''), result: lint.failed && rt.failed ? 'KILLED' : 'SURVIVED' });
  } finally { restore(); }
}
for (const r of rows) console.log(`${r.result.padEnd(8)} ${r.where.padEnd(5)} ${r.name.padEnd(22)} lint=${r.lint} runtime=${r.runtime}  ${r.runtimeDetail || ''}`);
const killed = rows.filter(r => r.result === 'KILLED').length;
console.log(`${killed}/${rows.length} killed`);
process.exit(killed === rows.length ? 0 : 1);
