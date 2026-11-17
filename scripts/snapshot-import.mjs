#!/usr/bin/env node
// RC-4 phase 4: snapshot -> D1 import. LOCAL ONLY (no --remote option).
//
// The live app (netlify/functions/platform.mjs + lib/storage.mjs) keeps the WHOLE SQLite
// database as one bytea "snapshot" row in Postgres (fitspace_preview_state). This script
// takes that SQLite file and loads it into a D1 database at the RC-4 schema:
//   1. copy the snapshot to a private temp dir (the source file is never modified);
//   2. open the copy with app/db.cjs connect(), i.e. run the app's own idempotent
//      migrations, exactly as the live app would on its next request (old snapshots are
//      upgraded the same way);
//   3. check the schema equals migrations/0001 (tables + columns), else STOP;
//   4. the cutover gate (PM ruling): duplicate live bookings -> STOP with a report (exit 2),
//      unless the opt-in --mark-duplicates-for-review --confirm <phrase> is given;
//   5. generate INSERT statements (explicit columns, FK order) -> a 0600 SQL file;
//   6. --persist-to (0700): refuse unless that LOCAL D1 has no tables (checked first, before
//      anything else), apply ALL migrations, execute the file, verify row counts table by
//      table; on a mismatch the imported rows are removed again.
//
//   node scripts/snapshot-import.mjs --snapshot fitspace.sqlite --persist-to .rc4-import [--out import.sql]
//   node scripts/snapshot-import.mjs --snapshot fitspace.b64 --base64 --out import.sql
//
// Getting the snapshot is an OWNER step (it reads production data; needs Kieran's approval):
//   psql "$DATABASE_URL" -At -c "SELECT encode(snapshot,'base64') FROM fitspace_preview_state WHERE namespace='<DATA_NAMESPACE>'" > fitspace.b64
// Loading into the REAL D1 is also owner-only, after approval: `wrangler d1 migrations apply
// DB --remote`, then `wrangler d1 execute DB --remote --file <out.sql>` (see doc §11).
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile, copyFile, rm, mkdir, readdir, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DUPLICATE_REPORT_SQL, MARK_SQL, CONFIRM_PHRASE } from '../src/cutover.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Parents before children (foreign keys). Every 0001 table must be listed exactly once.
export const TABLE_ORDER = ['pts', 'users', 'sessions', 'blocks', 'class_sessions', 'bookings', 'attendance', 'email_outbox', 'webhook_events', 'audit_log', 'stripe_jobs', 'stripe_refunds', 'stripe_connections', 'password_resets', 'password_reset_limits', 'auth_mail_jobs', 'pt_stripe_credentials'];

const columns = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
const userTables = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);

/** Expected schema: migrations/0001 applied to an empty in-memory SQLite. */
export async function expectedSchema() {
  const mem = new DatabaseSync(':memory:');
  mem.exec(await readFile(join(ROOT, 'migrations/0001_initial_schema.sql'), 'utf8'));
  const out = Object.fromEntries(userTables(mem).map(t => [t, columns(mem, t)]));
  mem.close();
  return out;
}

/** Problems (empty = OK): missing/extra tables, missing/extra columns. */
export function schemaProblems(db, expected) {
  const problems = [];
  const have = userTables(db);
  for (const t of Object.keys(expected)) if (!have.includes(t)) problems.push(`missing table ${t}`);
  for (const t of have) {
    if (!expected[t]) { problems.push(`unexpected table ${t}`); continue; }
    const cols = columns(db, t);
    for (const c of expected[t]) if (!cols.includes(c)) problems.push(`${t}: missing column ${c}`);
    for (const c of cols) if (!expected[t].includes(c)) problems.push(`${t}: unexpected column ${c}`);
  }
  return problems;
}

export function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') { if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite number'); return String(v); }
  if (v instanceof Uint8Array) return "X'" + Buffer.from(v).toString('hex') + "'";
  return "'" + String(v).replaceAll("'", "''") + "'";
}

/** One INSERT per row, FK order. */
export function insertStatements(db) {
  const missing = userTables(db).filter(t => !TABLE_ORDER.includes(t));
  if (missing.length) throw new Error('No import order for tables: ' + missing.join(', '));
  const out = [];
  for (const t of TABLE_ORDER) {
    const cols = columns(db, t);
    const list = cols.map(c => `"${c}"`).join(',');
    for (const row of db.prepare(`SELECT ${list} FROM "${t}" ORDER BY rowid`).all()) out.push(`INSERT INTO "${t}"(${list}) VALUES(${cols.map(c => sqlValue(row[c])).join(',')})`);
  }
  return out;
}

export const rowCounts = db => Object.fromEntries(TABLE_ORDER.map(t => [t, db.prepare(`SELECT count(*) n FROM "${t}"`).get().n]));

/**
 * Steps 1-5. Returns { status: 'ok' | 'halted' | 'schema', statements, counts, report, problems, marked }.
 * Never modifies `snapshotPath`.
 */
export async function prepareImport(snapshotPath, { base64 = false, markDuplicates = false, confirm, now = Date.now() } = {}) {
  if (markDuplicates && confirm !== CONFIRM_PHRASE) throw new Error(`Refusing to change bookings: pass --confirm ${CONFIRM_PHRASE}`);
  const dir = await mkdtemp(join(tmpdir(), 'rc4-snapshot-'));
  try {
    const file = join(dir, 'working.sqlite');
    if (base64) await writeFile(file, Buffer.from((await readFile(snapshotPath, 'utf8')).trim(), 'base64'), { mode: 0o600 });
    else await copyFile(snapshotPath, file);
    const { connect } = require('../app/db.cjs');
    const upgraded = connect(file); // the app's own migrations; no seeding
    upgraded.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    upgraded.close();
    const db = new DatabaseSync(file);
    try {
      const problems = schemaProblems(db, await expectedSchema());
      if (problems.length) return { status: 'schema', problems };
      let report = db.prepare(DUPLICATE_REPORT_SQL).all();
      let marked = [];
      if (report.length && markDuplicates) {
        db.exec('BEGIN');
        for (const sql of MARK_SQL(now, null)) db.exec(sql);
        db.exec('COMMIT');
        marked = db.prepare("SELECT target_id booking_id, action FROM audit_log WHERE action LIKE 'duplicate_import:kept=%' AND created_at=?").all(now).map(r => ({ ...r }));
        report = db.prepare(DUPLICATE_REPORT_SQL).all();
      }
      if (report.length) return { status: 'halted', report: report.map(r => ({ ...r })) };
      return { status: 'ok', statements: insertStatements(db), counts: rowCounts(db), marked };
    } finally { db.close(); }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const arg = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

// SQL run on the LOCAL target before anything else (CR 5941600057): a fresh D1 has no tables.
const TABLES_SQL = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name";

/** The CLI, testable: `wrangler(...args)` runs `wrangler d1 <args>` and returns stdout (the real
 *  one is the project's pinned binary, always --local). Returns the exit code; refusals throw. */
export async function run(argv, { wrangler = pinnedWrangler, log = console.log, error = console.error } = {}) {
  if (argv.includes('--remote')) throw new Error('No --remote option: loading the real D1 is owner-only after approval (doc §11).');
  const snapshot = arg(argv, '--snapshot');
  if (!snapshot) throw new Error('--snapshot <file> is required.');
  const persist = arg(argv, '--persist-to'), out = arg(argv, '--out');
  if (!persist && !out) throw new Error('Give --persist-to <local D1 dir> and/or --out <file.sql>.');
  const local = (...a) => wrangler(...a.slice(0, 2), '--local', '--persist-to', persist, ...a.slice(2));
  if (persist) {
    // CR 5941600057: refuse a non-fresh target BEFORE applying migrations or reading the snapshot,
    // and keep the local copy private (0700).
    await mkdir(persist, { recursive: true, mode: 0o700 });
    await chmod(persist, 0o700);
    const tables = JSON.parse(local('execute', 'DB', '--json', '--command', TABLES_SQL))[0].results.map(r => r.name);
    if (tables.length) throw new Error('Target D1 is not fresh (has tables: ' + tables.join(', ') + '); import into a new, empty local database only.');
  }
  const result = await prepareImport(snapshot, { base64: argv.includes('--base64'), markDuplicates: argv.includes('--mark-duplicates-for-review'), confirm: arg(argv, '--confirm') });
  if (result.status === 'schema') { error('IMPORT STOPPED: snapshot schema differs from migrations/0001:\n  ' + result.problems.join('\n  ')); return 3; }
  if (result.status === 'halted') {
    const reportDir = arg(argv, '--report-dir') || 'cutover-reports';
    await mkdir(reportDir, { recursive: true, mode: 0o700 });
    const path = join(reportDir, `duplicates-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(path, JSON.stringify({ halted: true, reason: 'duplicate live bookings (bookings_one_live_per_customer would fail)', rows: result.report }, null, 2) + '\n', { mode: 0o600 });
    error(`IMPORT HALTED: ${result.report.length} live bookings in duplicate groups. Report: ${path}`);
    return 2;
  }
  if (result.marked.length) log(`Opt-in: ${result.marked.length} duplicate bookings set to status=review (audit_log duplicate_import:kept=<id>).`);
  const sql = result.statements.join(';\n') + ';\n';
  let file = out, tmp;
  if (out) await writeFile(out, sql, { mode: 0o600 });
  else { tmp = await mkdtemp(join(tmpdir(), 'rc4-import-')); file = join(tmp, 'import.sql'); await writeFile(file, sql, { mode: 0o600 }); }
  try {
    log(`Prepared ${result.statements.length} rows: ${JSON.stringify(result.counts)}`);
    if (!persist) return 0;
    local('migrations', 'apply', 'DB');
    // One row of scalar subqueries (D1 rejects a 17-term UNION ALL: "too many terms in compound SELECT").
    const count = () => JSON.parse(local('execute', 'DB', '--json', '--command', 'SELECT ' + TABLE_ORDER.map(t => `(SELECT count(*) FROM "${t}") AS "${t}"`).join(', ')))[0].results[0];
    const before = Object.entries(count()).filter(([, n]) => n > 0).map(([t]) => t);
    if (before.length) throw new Error('Target D1 is not empty (' + before.join(', ') + '); import into a fresh database only.');
    local('execute', 'DB', '--file', file);
    const after = count();
    const diff = TABLE_ORDER.filter(t => after[t] !== result.counts[t]);
    if (diff.length) {
      // The target was verified fresh above, so removing every row restores it (CR 5941600057).
      local('execute', 'DB', '--command', [...TABLE_ORDER].reverse().map(t => `DELETE FROM "${t}"`).join('; '));
      throw new Error('Row counts differ after import: ' + diff.map(t => `${t} ${result.counts[t]} -> ${after[t]}`).join(', ') + '. The imported rows were removed again; nothing was kept.');
    }
    log(`Imported into local D1 (${persist}); row counts verified for ${TABLE_ORDER.length} tables.`);
    return 0;
  } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
}

// The project's pinned wrangler (never an npx download), local only. Exported so the backup
// --local check is tested on its own (CR 5943169048 nit).
export function pinnedWrangler(...a) {
  if (!a.includes('--local')) throw new Error('refusing: wrangler without --local');
  return execFileSync(join(ROOT, 'node_modules/.bin/wrangler'), ['d1', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], cwd: ROOT });
}

if (import.meta.url === `file://${process.argv[1]}`) run(process.argv.slice(2)).then(code => process.exit(code), e => { console.error('Snapshot import failed:', e.message); process.exit(1); });
