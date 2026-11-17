// RC-8 discount code use counter, idempotent per (code, booking) (CR 5940135102 minor 1).
// ONE batch: the discount_redemptions row FIRST (UNIQUE(code_id,booking_id)), then a
// commit-time guard that the code is still usable, then the counter. A retry for the same
// booking (e.g. after a lost response) hits the unique key, the whole batch rolls back (no
// second count) and the existing redemption is returned. Safe without the Writer queue.
import { isGuardFailure, isUniqueViolation } from '../db.mjs';
import { httpError, uid } from '../util.mjs';

export async function claimCode(db, { codeId, bookingId, customerId = null, now = Date.now() }) {
  if (typeof codeId !== 'string' || !codeId || typeof bookingId !== 'string' || !bookingId) throw httpError(400, 'Choose a discount code and booking.');
  const replay = () => db.get(
    'SELECT r.id redemption_id,c.uses,c.max_uses FROM discount_redemptions r JOIN discount_codes c ON c.id=r.code_id WHERE r.code_id=? AND r.booking_id=?',
    codeId, bookingId);
  const prior = await replay();
  if (prior) return { ...prior, replay: true };
  const redemptionId = uid();
  try {
    const results = await db.batch([
      db.stmt("INSERT INTO discount_redemptions(id,code_id,booking_id,customer_id,status,created_at) VALUES(?,?,?,?,'held',?)", redemptionId, codeId, bookingId, customerId, now),
      db.guard('code_available', 'EXISTS(SELECT 1 FROM discount_codes WHERE id=? AND active=1 AND (max_uses IS NULL OR uses<max_uses) AND (expires_at IS NULL OR expires_at>?))', codeId, now),
      db.stmt('UPDATE discount_codes SET uses=uses+1 WHERE id=? RETURNING uses,max_uses', codeId)
    ]);
    return { redemption_id: redemptionId, ...results[2].rows[0], replay: false };
  } catch (error) {
    if (isUniqueViolation(error, 'discount_redemptions.code_id')) {
      const again = await replay();
      if (again) return { ...again, replay: true };
    }
    if (isGuardFailure(error)) throw httpError(409, 'This discount code has expired or reached its limit.');
    throw error;
  }
}
