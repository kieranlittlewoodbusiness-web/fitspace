#!/usr/bin/env node
// Cutover import GATE (PM ruling 17 Nov 2026). Runs against a LOCAL scratch D1 that holds
// the source data at schema 0001 (no partial unique index yet):
//   node scripts/cutover-import.mjs --persist-to <scratch-dir> [--report-dir cutover-reports]
// If duplicate live bookings exist: writes <report-dir>/duplicates-<timestamp>.json (booking
// id, customer id, block id, payment status, paid_at, refund_status, created time; no card
// data, no secrets, no emails) and EXITS 2: the import stops. Nothing is changed.
// Opt-in resolution, only with the exact confirm phrase (never automatic):
//   node scripts/cutover-import.mjs --persist-to <dir> --mark-duplicates-for-review --confirm mark-duplicates-for-review
// Loading the checked data into the real D1 is phase 4 and needs Kieran's approval; this
// script has no --remote option.
import { DUPLICATE_REPORT_SQL, MARK_SQL, CONFIRM_PHRASE } from '../src/cutover.mjs';

const arg = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

async function main(argv) {
  const { execFileSync } = await import('node:child_process');
  const { mkdir, writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const persist = arg(argv, '--persist-to');
  if (!persist) throw new Error('--persist-to <scratch dir> is required (local scratch D1 only).');
  const reportDir = arg(argv, '--report-dir') || 'cutover-reports';
  const d1 = (...extra) => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', persist, '--json', ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  const query = sql => d1('--command', sql.replace(/\s+/g, ' '))[0].results;

  if (argv.includes('--mark-duplicates-for-review')) {
    if (arg(argv, '--confirm') !== CONFIRM_PHRASE) throw new Error(`Refusing to change bookings: pass --confirm ${CONFIRM_PHRASE}`);
    const dir = await mkdtemp(join(tmpdir(), 'rc4-cutover-'));
    try {
      const file = join(dir, 'mark.sql');
      await writeFile(file, MARK_SQL(Date.now(), null).join(';\n') + ';\n', { mode: 0o600 });
      d1('--file', file);
    } finally { await rm(dir, { recursive: true, force: true }); }
    console.log('Opt-in step done: extra live bookings set to status=review and listed in audit_log (cutover_duplicate_review).');
  }
  const report = query(DUPLICATE_REPORT_SQL);
  if (report.length) {
    await mkdir(reportDir, { recursive: true });
    const path = join(reportDir, `duplicates-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(path, JSON.stringify({ halted: true, reason: 'duplicate live bookings (bookings_one_live_per_customer would fail)', rows: report }, null, 2) + '\n', { mode: 0o600 });
    console.error(`IMPORT HALTED: ${report.length} live bookings in duplicate groups. Report: ${path}`);
    process.exit(2);
  }
  console.log('Gate passed: no duplicate live bookings.');
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).catch(e => { console.error('Cutover gate failed:', e.message); process.exit(1); });
