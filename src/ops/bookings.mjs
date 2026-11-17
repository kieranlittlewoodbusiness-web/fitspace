// Capacity-hold reservation, ported from app/payments.cjs:10 reserve() (BEGIN IMMEDIATE).
// Reads give the friendly error messages; the batch is authoritative:
//   1. expire stale holds (app/payments.cjs:8),
//   2. a count-form guarded INSERT ... SELECT that only inserts while
//      count(paid|pending) < capacity and the class is still open, RETURNING the row,
//   3. unique indexes: checkout_token (idempotent retry) and
//      bookings_one_live_per_customer (one live booking per customer per block).
import crypto from 'node:crypto';
import { httpError, isStripe, uid } from '../util.mjs';
import { isUniqueViolation } from '../db.mjs';
import { confirmationInsert } from '../emails.mjs';

export async function stripeConnection(db, ptId, mode, integration = 'connect') {
  if (integration === 'pt_direct') {
    const c = await db.get('SELECT * FROM pt_stripe_credentials WHERE pt_id=? AND mode=?', ptId, mode);
    return c?.api_cipher ? { account_id: c.account_id, routing: 'platform', credential_id: c.id, ready: Boolean(c.enabled && c.charges_ready && c.webhook_cipher) } : null;
  }
  const saved = await db.get('SELECT account_id,routing,ready FROM stripe_connections WHERE pt_id=? AND mode=?', ptId, mode);
  if (saved) return saved;
  if (mode === 'stripe_test') {
    const old = await db.get('SELECT stripe_account,stripe_ready FROM pts WHERE id=?', ptId);
    if (old?.stripe_account) return { account_id: old.stripe_account, routing: 'connected', ready: old.stripe_ready };
  }
  return null;
}

export async function reserve(db, { userId, blockId, token, mode = 'demo', integration = 'connect', now = Date.now() }) {
  if (!/^[a-zA-Z0-9-]{12,80}$/.test(token || '')) throw httpError(400, 'Refresh the booking page and try again.');
  const replay = async () => {
    const prior = await db.get('SELECT * FROM bookings WHERE checkout_token=?', token);
    if (!prior) return null;
    if (prior.customer_id !== userId || prior.block_id !== blockId) throw httpError(409, 'Booking token already used.');
    return prior;
  };
  const prior = await replay();
  if (prior) return prior;
  const block = await db.get('SELECT b.*,p.published pt_published FROM blocks b JOIN pts p ON p.id=b.pt_id WHERE b.id=?', blockId);
  const first = await db.get('SELECT min(starts_epoch) starts FROM class_sessions WHERE block_id=?', blockId);
  if (!block || !block.published || !block.pt_published || block.closed || !first?.starts || first.starts <= now) throw httpError(409, 'This class is no longer open for bookings.');
  const live = await db.get("SELECT id FROM bookings WHERE block_id=? AND customer_id=? AND (status='paid' OR (status='pending' AND expires_at>?))", blockId, userId, now);
  if (live) throw httpError(409, 'You already have a booking or checkout in progress for this block.');
  let connection = null;
  if (isStripe(mode)) {
    connection = await stripeConnection(db, block.pt_id, mode, integration);
    if (!connection?.ready) throw httpError(409, 'This trainer has not finished Stripe setup for this payment mode.');
  }
  const id = uid();
  const reference = 'FIT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const expiresAt = now + (isStripe(mode) ? 35 : 31) * 60000;
  let results;
  try {
    results = await db.batch([
      db.stmt("UPDATE bookings SET status='expired' WHERE status='pending' AND expires_at<=?", now),
      db.stmt(
        `INSERT INTO bookings(id,block_id,customer_id,reference,status,amount_pence,mode,checkout_token,expires_at,created_at,stripe_account_id,stripe_routing,stripe_credential_id)
         SELECT ?,b.id,?,?,'pending',b.price_pence,?,?,?,?,?,?,?
         FROM blocks b JOIN pts p ON p.id=b.pt_id
         WHERE b.id=? AND b.published=1 AND b.closed=0 AND p.published=1
           AND (SELECT count(*) FROM bookings x WHERE x.block_id=b.id AND x.status IN ('paid','pending')) < b.capacity
         RETURNING *`,
        id, userId, reference, mode, token, expiresAt, now,
        connection?.account_id ?? null, connection?.routing ?? 'connected', connection?.credential_id ?? null,
        blockId
      )
    ]);
  } catch (error) {
    if (isUniqueViolation(error, 'checkout_token')) {
      const again = await replay();
      if (again) return again;
    }
    if (isUniqueViolation(error, 'bookings.block_id')) throw httpError(409, 'You already have a booking or checkout in progress for this block.');
    throw error;
  }
  const row = results[1].rows[0];
  if (!row) throw httpError(409, 'This block is full. Please choose another class.');
  return row;
}

/** Places left, for views (app/payments.cjs:9 available()); read-only, expiry-aware. */
export async function available(db, block, now = Date.now()) {
  const used = await db.get("SELECT count(*) n FROM bookings WHERE block_id=? AND (status='paid' OR (status='pending' AND expires_at>?))", block.id, now);
  return Math.max(0, block.capacity - used.n);
}

// Demo-mode "payment", ported from app/payments.cjs:11 completeDemo() (BEGIN IMMEDIATE).
// One batch: expire stale holds, then a guarded transition pending->paid|failed that only
// applies while the hold is live, then the confirmation email guarded on status='paid'
// (dedupe_key keeps it to one). Concurrent or repeated calls converge on one outcome.
export async function completeDemo(db, { bookingId, userId, result, emailMode = 'preview', now = Date.now() }) {
  const load = () => db.get('SELECT * FROM bookings WHERE id=? AND customer_id=?', bookingId, userId);
  const booking = await load();
  if (!booking) throw httpError(404, 'Booking not found.');
  if (booking.mode !== 'demo') throw httpError(403, 'This booking must be confirmed by Stripe.');
  if (booking.status === 'paid') return booking;
  const inactive = () => httpError(409, 'This checkout is no longer active. Book a new place to try again.');
  if (booking.status !== 'pending' || booking.expires_at <= now) {
    if (booking.status === 'pending') await db.run("UPDATE bookings SET status='expired' WHERE id=? AND status='pending' AND expires_at<=?", bookingId, now);
    throw inactive();
  }
  const success = result === 'success';
  const writes = [
    db.stmt("UPDATE bookings SET status='expired' WHERE status='pending' AND expires_at<=?", now),
    db.stmt(
      `UPDATE bookings SET status=?,paid_at=CASE WHEN ?='paid' THEN ? ELSE paid_at END
       WHERE id=? AND customer_id=? AND mode='demo' AND status='pending' AND expires_at>? RETURNING *`,
      success ? 'paid' : 'failed', success ? 'paid' : 'failed', now, bookingId, userId, now
    )
  ];
  if (success) writes.push(await confirmationInsert(db, bookingId, { emailMode, now }));
  const results = await db.batch(writes);
  const updated = results[1].rows[0];
  if (updated) return updated;
  // Lost a race: report the state that won (paid stays paid; anything else is inactive).
  const current = await load();
  if (current?.status === 'paid') return current;
  if (!success && current?.status === 'failed') return current;
  throw inactive();
}
