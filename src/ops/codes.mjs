// RC-8 discount code use counter: ONE guarded statement, safe under any concurrency
// because D1 executes statements one at a time. No read-then-write.
import { httpError } from '../util.mjs';

export async function claimCode(db, { codeId, now = Date.now() }) {
  const row = await db.get(
    `UPDATE discount_codes SET uses=uses+1
     WHERE id=? AND active=1 AND (max_uses IS NULL OR uses<max_uses) AND (expires_at IS NULL OR expires_at>?)
     RETURNING uses,max_uses`,
    codeId, now
  );
  if (!row) throw httpError(409, 'This discount code has expired or reached its limit.');
  return row;
}
