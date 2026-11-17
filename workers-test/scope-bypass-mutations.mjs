#!/usr/bin/env node
// CR 5941600057 M4 mutation run. Injects each bypass CR reported at 036cb53 into the PT
// dashboard path, in worker/index.mjs and in src/views.mjs, then runs (1) the scope lint and
// (2) the runtime cross-PT test. KILLED = both fail. The SQL is split ('SELECT b.* FROM' +
// 'bookings b') wherever CR's case is an alias, so only the new rules can catch it.
// Kept outside src/worker/scripts on purpose: its strings ARE the bypasses. Local only.
//   node workers-test/scope-bypass-mutations.mjs [name ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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
    writeFileSync(file, mutated);
    try {
      const lint = summary(vitest('workers-test/scope-lint.test.mjs'));
      const rt = summary(vitest('workers-test/scope-runtime.test.mjs'));
      rows.push({ where, name, lint: lint.failed ? 'FAIL' : 'pass', runtime: rt.failed ? 'FAIL' : 'pass', runtimeDetail: rt.tests + (rt.first ? ' | ' + rt.first : ''), result: lint.failed && rt.failed ? 'KILLED' : 'SURVIVED' });
    } finally { writeFileSync(file, original); }
  }
}
for (const r of rows) console.log(`${r.result.padEnd(8)} ${r.where.padEnd(5)} ${r.name.padEnd(22)} lint=${r.lint} runtime=${r.runtime}  ${r.runtimeDetail || ''}`);
const killed = rows.filter(r => r.result === 'KILLED').length;
console.log(`${killed}/${rows.length} killed`);
process.exit(killed === rows.length ? 0 : 1);
