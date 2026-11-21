#!/usr/bin/env node
// RC-14: local-only seed of ONE published PT for `wrangler dev --local`.
//   SEED_PT_EMAIL=coach@example.com node scripts/seed-dev-pt.mjs --local
// Password: SEED_PT_PASSWORD env, or piped on stdin; never printed, never stored in plain text.
//
// Idempotent: inserts only if no PT exists yet. Does not create or change an admin
// (Kieran stays admin via scripts/bootstrap-admin.mjs).
//
// Never targets a remote D1 database: --remote is refused even with --confirm-remote.
import { email as validEmail, password as validPassword, text, branding } from '../src/validate.mjs';
import { hashPassword, uid } from '../src/util.mjs';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const quote = value => "'" + String(value).replaceAll("'", "''") + "'";

const DEFAULTS = {
  slug: 'local-coach',
  brand_name: 'Local Coach',
  tagline: 'Show up. Keep going.',
  description: 'Local development seed. Not a real coach profile.',
  about: 'This is synthetic local data for wrangler dev, not a production trainer.',
  accent: '#ffd43b',
  background: '#111111',
  foreground: '#ffffff',
  features: ['Local development seed'],
  published: true,
  owner_name: 'Local Coach'
};

/** SQL for wrangler d1 execute --file. Contains only the scrypt hash, never the password. */
export function seedDevPtSql({
  email,
  password,
  ownerName = DEFAULTS.owner_name,
  brand = {},
  now = Date.now(),
  ptId = uid(),
  userId = uid()
} = {}) {
  const address = validEmail(email);
  const pass = validPassword(password);
  const name = text(ownerName, 'PT name', 80, 2);
  const b = branding({ ...DEFAULTS, ...brand, published: true });
  const features = JSON.stringify(b.features);
  return `INSERT INTO pts(id,slug,brand_name,tagline,description,about,accent,background,foreground,features,published,created_at) SELECT ${quote(ptId)},${quote(b.slug)},${quote(b.name)},${quote(b.tagline)},${quote(b.description)},${quote(b.about)},${quote(b.accent)},${quote(b.background)},${quote(b.foreground)},${quote(features)},1,${Number(now)} WHERE NOT EXISTS(SELECT 1 FROM pts);
INSERT INTO users(id,name,email,password_hash,role,pt_id,must_change_password,created_at) SELECT ${quote(userId)},${quote(name)},${quote(address)},${quote(hashPassword(pass))},'pt',(SELECT id FROM pts WHERE slug=${quote(b.slug)}),0,${Number(now)} WHERE NOT EXISTS(SELECT 1 FROM users WHERE role='pt') AND EXISTS(SELECT 1 FROM pts WHERE slug=${quote(b.slug)});
`;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

export const HELP = `Usage: SEED_PT_EMAIL=... node scripts/seed-dev-pt.mjs --local [--persist-to <dir>]
Password: SEED_PT_PASSWORD env or stdin (never printed). Idempotent: inserts only if no PT exists.
Does not create an admin. Optional: SEED_PT_NAME, SEED_PT_SLUG, SEED_PT_BRAND.

  --local                 local D1 (wrangler dev / Miniflare state). Required.
  --persist-to <dir>      local state directory.
  --remote                refused. This seed is local-only and never targets a remote D1.`;

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h') || !argv.length) { console.log(HELP); return; }
  if (argv.includes('--remote')) throw new Error('seed-dev-pt is local-only: --remote is refused, even with --confirm-remote.');
  if (!argv.includes('--local')) throw new Error('Pass --local (this seed never runs against a remote D1). See --help.');
  const password = process.env.SEED_PT_PASSWORD || (await readStdin());
  const brand = {};
  if (process.env.SEED_PT_SLUG) brand.slug = process.env.SEED_PT_SLUG;
  if (process.env.SEED_PT_BRAND) brand.brand_name = process.env.SEED_PT_BRAND;
  const sql = seedDevPtSql({
    email: process.env.SEED_PT_EMAIL,
    password,
    ownerName: process.env.SEED_PT_NAME || DEFAULTS.owner_name,
    brand
  });
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'rc14-seed-'));
  const file = join(dir, 'seed-dev-pt.sql');
  try {
    await writeFile(file, sql, { mode: 0o600 });
    const p = argv.indexOf('--persist-to');
    const extra = p >= 0 && argv[p + 1] ? ['--persist-to', argv[p + 1]] : [];
    const wrangler = join(import.meta.dirname, '..', 'node_modules', '.bin', 'wrangler');
    const cwd = join(import.meta.dirname, '..');
    execFileSync(wrangler, ['d1', 'execute', 'DB', '--local', ...extra, '--file', file], { stdio: ['ignore', 'ignore', 'inherit'], cwd });
    const out = execFileSync(wrangler, ['d1', 'execute', 'DB', '--local', ...extra, '--json', '--command', "SELECT count(*) AS pts FROM pts"], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], cwd });
    console.log(`Dev PT seed (local): pts now = ${JSON.parse(out)[0].results[0].pts}. (Unchanged if one already existed.)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error('Dev PT seed failed:', error.message); process.exit(1); });
}
