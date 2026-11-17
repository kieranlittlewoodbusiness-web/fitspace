// D1 rate limiting (replaces the per-isolate Map in app/auth.cjs and the Postgres
// checkLimit in lib/storage.mjs). ONE upsert statement with RETURNING: D1 executes it
// atomically, so concurrent attempts are counted exactly. Keys carry a hashed IP only.
import { digest, httpError } from './util.mjs';

export async function rateLimit(db, scope, client, { max = 15, windowMs = 15 * 60000, now = Date.now() } = {}) {
  const key = scope + ':' + digest(String(client || 'unknown'));
  const row = await db.get(
    `INSERT INTO rate_limits(key,count,window_ends) VALUES(?,1,?)
     ON CONFLICT(key) DO UPDATE SET
       count=CASE WHEN rate_limits.window_ends<=? THEN 1 ELSE rate_limits.count+1 END,
       window_ends=CASE WHEN rate_limits.window_ends<=? THEN excluded.window_ends ELSE rate_limits.window_ends END
     RETURNING count`,
    key, now + windowMs, now, now
  );
  if (row.count > max) throw httpError(429, 'Too many attempts. Please try again in a few minutes.');
  return row.count;
}

/** Housekeeping (a Cron Trigger in phase 3): drop windows that ended over a day ago. */
export const pruneRateLimits = (db, now = Date.now()) => db.run('DELETE FROM rate_limits WHERE window_ends<?', now - 86400000);
