#!/usr/bin/env node
// Guard mutation run (CR 5940914487 M5). Each mutation disables ONE guard, runs the Workers
// suite WITHOUT the scope lint (a fingerprint change alone must not count as a kill), and
// restores the file. KILLED = at least one behavioural test failed. Local only.
//   node scripts/guard-mutations.mjs [name ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// If the run is interrupted, put the mutated file back before exiting.
let pending = null; // [file, original]
const restore = () => { if (pending) { writeFileSync(pending[0], pending[1]); pending = null; } };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restore(); process.exit(130); });
process.on('exit', restore);

const always = name => [`db.guard('${name}', `, `db.guard('${name}', '1 OR ' + `];
const MUTATIONS = {
  // The six CR 5940914487 reported as surviving:
  job_not_done: ['src/ops/stripe-jobs.mjs', ...always('job_not_done')],
  one_active_refund: ['src/ops/stripe-jobs.mjs', ...always('one_active_refund')],
  auth_mail_claim: ['src/mail.mjs', "AND claimed_until<=? RETURNING *\", now + LEASE_MS, id, now)", "AND ?<>-1 RETURNING *\", now + LEASE_MS, id, now)"],
  pts_create_key_unique: ['migrations/0004_phase3.sql', 'CREATE UNIQUE INDEX pts_create_key', 'CREATE INDEX pts_create_key'],
  pt_webhook_event_match: ['worker/index.mjs', 'if (authoritative.id !== event.id || authoritative.type !== event.type || authoritative.data?.object?.id !== event.data?.object?.id) throw', 'if (false) throw'],
  invite_secret_length: ['worker/index.mjs', 'if (secret.length < 32) throw', 'if (false) throw'],
  // The other commit-time guards (regression check):
  password_unchanged: ['src/ops/accounts.mjs', ...always('password_unchanged')],
  code_available: ['src/ops/codes.mjs', ...always('code_available')],
  capacity_not_below_holds: ['src/ops/manage.mjs', ...always('capacity_not_below_holds')],
  dates_unlocked: ['src/ops/manage.mjs', ...always('dates_unlocked')],
  booking_still_paid: ['src/ops/manage.mjs', ...always('booking_still_paid')],
  reset_link_valid: ['src/ops/password-reset.mjs', ...always('reset_link_valid')],
  account_not_other_pt: ['src/ops/stripe-jobs.mjs', ...always('account_not_other_pt')],
  checkout_session_matches: ['src/ops/stripe-jobs.mjs', ...always('checkout_session_matches')],
  refund_total_within_payment: ['src/ops/webhooks.mjs', ...always('refund_total_within_payment')],
  blocks_create_key_unique: ['migrations/0004_phase3.sql', 'CREATE UNIQUE INDEX blocks_create_key', 'CREATE INDEX blocks_create_key'],
  // CR 5941600057:
  payment_readiness: ['worker/index.mjs', "if (route.startsWith('/api/')) paymentReadiness(", "if (false) paymentReadiness("],
  readiness_webhook_and_https: ['worker/index.mjs', "if (paymentMode !== 'demo' && ((integration", "if (false && ((integration"],
  reset_off_writes_nothing: ['worker/index.mjs', "if (resetConfigured(env)) await write(env, 'requestReset'", "if (true) await write(env, 'requestReset'"],
  cron_enabled_gate: ['worker/index.mjs', "if (env.CRON_ENABLED !== 'true') return", "if (false) return"],
  // route_env_without_db is an equivalent mutant on its own (no current code reads env.DB
  // downstream); workers-test/scope-bypass-mutations.mjs pairs it with CR's injected
  // env-destructuring bypass and shows it turns a 503 into a cross-PT leak.
  writer_env_without_db: ['src/writer.mjs', 'this.appEnv = withoutDb(env);', 'this.appEnv = env;'],
  wrapper_hides_binding: ['src/db.mjs', 'return Object.freeze({', 'return Object.freeze({ d1,']
};

const only = process.argv.slice(2);
const results = [];
for (const [name, [file, from, to]] of Object.entries(MUTATIONS)) {
  if (only.length && !only.includes(name)) continue;
  const original = readFileSync(file, 'utf8');
  if (original.split(from).length !== 2) { results.push({ name, file, result: 'ERROR: pattern not found exactly once' }); continue; }
  pending = [file, original]; writeFileSync(file, original.replace(from, to));
  try {
    const run = spawnSync('node_modules/.bin/vitest', ['run', '--config', 'vitest.workers.config.mjs', '--exclude', 'workers-test/scope-lint.test.mjs'], { encoding: 'utf8', timeout: 600000 });
    const out = (run.stdout || '') + (run.stderr || '');
    const failed = [...out.matchAll(/^ (?:FAIL|×) +(.+?)(?: \d+ms)?$/gm)].map(m => m[1].trim());
    const summary = (out.match(/Tests\s+(.*)/) || [])[1] || 'no summary';
    results.push({ name, file, result: run.status === 0 ? 'SURVIVED' : 'KILLED', summary: summary.trim(), killedBy: [...new Set(failed)].slice(0, 4) });
  } finally {
    writeFileSync(file, original); pending = null;
  }
  const r = results.at(-1);
  console.log(`${r.result.padEnd(8)} ${name.padEnd(28)} ${r.summary}`);
  for (const t of r.killedBy || []) console.log('           by: ' + t.slice(0, 200));
}
const survived = results.filter(r => r.result !== 'KILLED');
console.log(`\n${results.length - survived.length}/${results.length} mutations killed` + (survived.length ? '; not killed: ' + survived.map(r => r.name).join(', ') : ''));
process.exit(survived.length ? 1 : 0);
