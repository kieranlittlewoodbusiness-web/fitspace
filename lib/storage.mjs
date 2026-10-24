import pg from 'pg';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_BYTES = 8 * 1024 * 1024;
export function databasePool(connectionString) {
  if (!connectionString || !/^postgres(?:ql)?:\/\//.test(connectionString)) {
    throw new Error('Set DATABASE_URL to a PostgreSQL connection URL.');
  }
  // TLS follows the provider URL (normally sslmode=require). Never disable
  // certificate checks globally or log connection URLs.
  return new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 1000, allowExitOnIdle: true, statement_timeout: 20000 });
}

export async function ensureSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS fitspace_preview_state (
    namespace text PRIMARY KEY,
    snapshot bytea,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fitspace_preview_limits (
    key text PRIMARY KEY,
    attempts integer NOT NULL,
    resets_at timestamptz NOT NULL
  )`);
}

export async function checkLimit(pool, key, max = 15) {
  await pool.query('DELETE FROM fitspace_preview_limits WHERE resets_at < now()');
  const { rows } = await pool.query(`INSERT INTO fitspace_preview_limits(key, attempts, resets_at)
    VALUES($1, 1, now() + interval '15 minutes')
    ON CONFLICT(key) DO UPDATE SET attempts = fitspace_preview_limits.attempts + 1
    RETURNING attempts`, [key]);
  if (rows[0].attempts > max) {
    const error = new Error('Too many attempts. Try again in 15 minutes.');
    error.status = 429;
    throw error;
  }
}

// Preserve the tested SQLite booking engine while making its complete state
// durable across serverless instances. PostgreSQL owns the transaction and
// exclusive row lock; /tmp is only a disposable working copy. No response is
// returned until COMMIT succeeds. This intentionally serialises a small preview
// app; migrate to normal relational tables before production or high traffic.
export async function withSnapshot(pool, namespace, work, { commitErrors = false } = {}) {
  const client = await pool.connect();
  let folder;
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    await client.query("SET LOCAL lock_timeout = '8s'");
    await client.query(`INSERT INTO fitspace_preview_state(namespace) VALUES($1)
      ON CONFLICT(namespace) DO NOTHING`, [namespace]);
    const result = await client.query('SELECT snapshot FROM fitspace_preview_state WHERE namespace=$1 FOR UPDATE', [namespace]);
    folder = await mkdtemp(join(tmpdir(), 'fitspace-preview-'));
    const filename = join(folder, 'working.sqlite');
    const snapshot = result.rows[0].snapshot;
    if (snapshot) {
      if (snapshot.length > MAX_BYTES) throw new Error('Preview storage limit reached.');
      await writeFile(filename, snapshot, { mode: 0o600 });
    }
    // work must close/checkpoint SQLite before resolving.
    const response = await work(filename);
    if (response.status >= 500 && !commitErrors) {
      await client.query('ROLLBACK');
      began = false;
      return response;
    }
    const updated = await readFile(filename);
    if (updated.length > MAX_BYTES) throw new Error('Preview storage limit reached.');
    await client.query(`UPDATE fitspace_preview_state SET snapshot=$2, updated_at=now()
      WHERE namespace=$1`, [namespace, updated]);
    await client.query('COMMIT');
    began = false;
    return response;
  } catch (error) {
    if (began) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (folder) await rm(folder, { recursive: true, force: true });
  }
}
