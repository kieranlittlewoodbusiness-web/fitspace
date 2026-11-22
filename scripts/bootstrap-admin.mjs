#!/usr/bin/env node
// One-off admin bootstrap for the D1 database: replaces app/public-mode.cjs initialise(),
// which checked ADMIN_EMAIL/ADMIN_PASSWORD on EVERY request. The Worker never reads these.
//
//   ADMIN_EMAIL=you@example.com ADMIN_NAME="Site Admin" node scripts/bootstrap-admin.mjs --local
//   (local option: --persist-to <dir>; password: ADMIN_PASSWORD env, or piped on stdin; never printed, never stored in plain text)
//
// Production (owner-only, after Kieran's yes for that run):
//   printf %s "$ADMIN_PW" | ADMIN_EMAIL=... ADMIN_NAME="Kieran" node scripts/bootstrap-admin.mjs \
//     --remote --confirm-remote --env production --confirm-production
//
// Inserts the admin only if NO admin exists yet (idempotent; safe to re-run).
//
// OWNER-ONLY: `--remote --confirm-remote --env production --confirm-production` targets the
// real production D1 database. It is run only by the owner, and only after Kieran's explicit
// yes for that run (CR 5940418854 condition 4). Agents and CI never run --remote; they use
// --local (optionally --persist-to <dir>) only. Emails and secrets are never printed.
import { email as validEmail, password as validPassword, text } from '../src/validate.mjs';
import { hashPassword, uid } from '../src/util.mjs';
import { requireProductionEnv } from '../docs/rc-4/d1-rehearsal/guard.mjs';

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

export const HELP = `Usage: ADMIN_EMAIL=... [ADMIN_NAME=...] node scripts/bootstrap-admin.mjs --local [--persist-to <dir>]
Password: ADMIN_PASSWORD env or stdin (never printed). Idempotent: inserts only if no admin exists.
Emails and secrets are never written to stdout or stderr.

  --local                 local D1 (wrangler dev / Miniflare state). Default for agents and CI.
  --persist-to <dir>      local state directory.
  --env production        required for any production-database target, including --remote.
  --confirm-production    required with --env production.
  --remote --confirm-remote --env production --confirm-production
                          OWNER-ONLY. Real production D1. Run only by the owner, and only with
                          Kieran's explicit yes for this run. Never by agents or CI.`;

function flagValue(argv, name) {
  const eq = argv.find(a => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  return undefined;
}

/** Parse CLI flags. Throws before any password or email is read. Does not log secrets. */
export function parseBootstrapArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h') || !argv.length) return { help: true };
  const remote = argv.includes('--remote');
  const confirmRemote = argv.includes('--confirm-remote');
  const confirmProduction = argv.includes('--confirm-production');
  const envName = flagValue(argv, '--env');
  const persistTo = flagValue(argv, '--persist-to');
  if (remote && !confirmRemote) {
    throw new Error('--remote is OWNER-ONLY: it needs --confirm-remote, --env production, --confirm-production, and Kieran\'s explicit yes for this run. See --help.');
  }
  if (envName !== undefined) requireProductionEnv(envName);
  if (envName === 'production' && !confirmProduction) {
    throw new Error('--env production needs --confirm-production. See --help.');
  }
  if (remote) requireProductionEnv(envName);
  return { help: false, remote, envName, persistTo };
}

/** wrangler argv for `npx`. Never includes emails, passwords, or other secrets. */
export function wranglerD1ExecuteArgs({ remote, envName, persistTo, file, command, json = false }) {
  const args = ['wrangler', 'd1', 'execute', 'DB', remote ? '--remote' : '--local'];
  if (envName) args.push('--env', envName);
  if (!remote && persistTo) args.push('--persist-to', persistTo);
  if (json) args.push('--json');
  if (file) args.push('--file', file);
  if (command) args.push('--command', command);
  return args;
}

async function main(argv) {
  const opts = parseBootstrapArgs(argv);
  if (opts.help) { console.log(HELP); return; }
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
    const base = { remote: opts.remote, envName: opts.envName, persistTo: opts.persistTo };
    execFileSync('npx', wranglerD1ExecuteArgs({ ...base, file }), { stdio: ['ignore', 'ignore', 'inherit'] });
    const out = execFileSync('npx', wranglerD1ExecuteArgs({ ...base, json: true, command: "SELECT count(*) AS admins FROM users WHERE role='admin'" }), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    const target = opts.remote ? '--remote' : '--local';
    const envLabel = opts.envName ? `, --env ${opts.envName}` : '';
    console.log(`Admin bootstrap (${target}${envLabel}): admin accounts now = ${JSON.parse(out)[0].results[0].admins}. (Unchanged if one already existed.)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch(error => { console.error('Admin bootstrap failed:', error.message); process.exit(1); });
}
