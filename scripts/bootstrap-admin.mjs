#!/usr/bin/env node
// One-off admin bootstrap for the D1 database: replaces app/public-mode.cjs initialise(),
// which checked ADMIN_EMAIL/ADMIN_PASSWORD on EVERY request. The Worker never reads these.
//
//   ADMIN_EMAIL=you@example.com ADMIN_NAME="Site Admin" node scripts/bootstrap-admin.mjs --local
//   (local option: --persist-to <dir>; password: ADMIN_PASSWORD env, or piped on stdin; never printed, never stored in plain text)
//
// Inserts the admin only if NO admin exists yet (idempotent; safe to re-run).
// --remote targets the real D1 database and additionally needs --confirm-remote; it must
// only be run with Kieran's approval once the real database exists.
import { email as validEmail, password as validPassword, text } from '../src/validate.mjs';
import { hashPassword, uid } from '../src/util.mjs';

const quote = value => "'" + String(value).replaceAll("'", "''") + "'";

/** SQL for wrangler d1 execute --file. Contains only the scrypt hash, never the password. */
export function bootstrapAdminSql({ email, name = 'Site Admin', password, now = Date.now(), id = uid() }) {
  const address = validEmail(email);
  const pass = validPassword(password);
  if (pass === 'TrainTogether123!') throw new Error('Choose your own admin password rather than the old demo password.');
  const display = text(name, 'Admin name', 80, 2);
  return `INSERT INTO users(id,name,email,password_hash,role,created_at) SELECT ${quote(id)},${quote(display)},${quote(address)},${quote(hashPassword(pass))},'admin',${Number(now)} WHERE NOT EXISTS(SELECT 1 FROM users WHERE role='admin');\n`;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

async function main(argv) {
  const remote = argv.includes('--remote');
  if (remote && !argv.includes('--confirm-remote')) throw new Error('--remote needs --confirm-remote (and Kieran\'s approval).');
  const password = process.env.ADMIN_PASSWORD || (await readStdin());
  const sql = bootstrapAdminSql({ email: process.env.ADMIN_EMAIL, name: process.env.ADMIN_NAME || 'Site Admin', password });
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'rc4-admin-'));
  const file = join(dir, 'bootstrap.sql');
  try {
    await writeFile(file, sql, { mode: 0o600 });
    const target = remote ? '--remote' : '--local';
    const p = argv.indexOf('--persist-to');
    const extra = !remote && p >= 0 && argv[p + 1] ? ['--persist-to', argv[p + 1]] : [];
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', target, ...extra, '--file', file], { stdio: ['ignore', 'ignore', 'inherit'] });
    const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', target, ...extra, '--json', '--command', "SELECT count(*) AS admins FROM users WHERE role='admin'"], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    console.log(`Admin bootstrap (${target}): admin accounts now = ${JSON.parse(out)[0].results[0].admins}. (Unchanged if one already existed.)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(error => { console.error('Admin bootstrap failed:', error.message); process.exit(1); });
}
