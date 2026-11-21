#!/usr/bin/env node
// Local-only operator helper: mint a one-time preview password-reset token.
// Does not print secrets, tokens, or hashes. Does not connect to D1 or deploy.
//
// Once this branch is on the preview Worker, an operator runs (from the repo root):
//   node docs/rc-4/preview/mint-reset-token.mjs \
//     --database-id 81379d2e-c718-48b7-870d-1d189feea966 \
//     --user-id preview-pt-user \
//     --secrets .secrets/preview.json \
//     --out /tmp/preview-reset-link.txt \
//     --sql /tmp/preview-reset.sql
// then applies ONLY the written SQL to the preview D1 database (never production).
// The link file is mode 0600 and is the ?token= URL to send. TTL is 30 minutes.
//
// --secrets must be a JSON file with PT_INVITE_SECRET, or AUTH_RESET_SECRET if that
// is set on the Worker. The script never logs those values.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import crypto from 'node:crypto';
import { isProduction, safeDatabaseId } from '../d1-rehearsal/guard.mjs';

const here = new URL('../../../', import.meta.url);
const { resetToken, resetSigningSecret, RESET_TTL_MS, PREVIEW_APP_URL, PREVIEW_DB, previewOutOfBandAllowed } = await import(new URL('src/ops/password-reset.mjs', here).href);
const { digest } = await import(new URL('src/util.mjs', here).href);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const rawId = arg('--database-id');
if (!rawId) {
  console.error('usage: mint-reset-token.mjs --database-id <preview-d1-uuid> --user-id <id> --secrets <json> --out <link-file> --sql <sql-file>');
  process.exit(2);
}
if (isProduction(rawId)) {
  console.error('refusing: that is the production database');
  process.exit(2);
}
const databaseId = safeDatabaseId(rawId);
if (databaseId !== PREVIEW_DB) {
  console.error('refusing: not the preview database');
  process.exit(2);
}

const userId = arg('--user-id', 'preview-pt-user');
if (!/^[A-Za-z0-9_-]{1,80}$/.test(userId)) {
  console.error('refusing: invalid --user-id');
  process.exit(2);
}
const secretsPath = arg('--secrets');
const outPath = arg('--out');
const sqlPath = arg('--sql');
if (!secretsPath || !outPath || !sqlPath) {
  console.error('usage: mint-reset-token.mjs --database-id <preview-d1-uuid> --user-id <id> --secrets <json> --out <link-file> --sql <sql-file>');
  process.exit(2);
}

const secrets = JSON.parse(readFileSync(resolve(secretsPath), 'utf8'));
const env = {
  EMAIL_MODE: 'preview',
  APP_URL: PREVIEW_APP_URL,
  D1_DATABASE_ID: databaseId,
  AUTH_RESET_SECRET: secrets.AUTH_RESET_SECRET || '',
  PT_INVITE_SECRET: secrets.PT_INVITE_SECRET || ''
};
if (!previewOutOfBandAllowed(env) || !resetSigningSecret(env)) {
  console.error('refusing: preview signing secret is not available');
  process.exit(2);
}

const id = crypto.randomUUID();
const token = resetToken(env, id);
const now = Date.now();
const expires = now + RESET_TTL_MS;
const tokenHash = digest(token);
const link = `${PREVIEW_APP_URL}/reset-password?token=${token}`;

// The SQL reads the live password_hash so the link matches the current account password.
const sql = `INSERT INTO password_resets(id,user_id,token_hash,password_hash,expires_at,created_at)
SELECT '${id}', '${userId}', '${tokenHash}', password_hash, ${expires}, ${now}
FROM users WHERE id = '${userId}';
`;

writeFileSync(resolve(outPath), link + '\n', { mode: 0o600 });
writeFileSync(resolve(sqlPath), sql, { mode: 0o600 });

const expiry = new Date(expires).toISOString();
console.log(JSON.stringify({
  ok: true,
  preview_db: databaseId,
  user_id: userId,
  reset_id: id,
  expires_at: expiry,
  ttl_minutes: RESET_TTL_MS / 60000,
  link_file: resolve(outPath),
  sql_file: resolve(sqlPath)
}));
