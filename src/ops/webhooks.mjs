// Stripe webhook application, ported from app/payments.cjs:137-183 handleWebhook()
// (one BEGIN IMMEDIATE transaction). Runs inside the Writer queue. All writes for an
// event commit in ONE batch whose first statement inserts the webhook_events key: a
// duplicate delivery (even one that bypassed the queue) hits the PRIMARY KEY, the whole
// batch rolls back, and the event is reported as a duplicate. Applied exactly once.
//
// Ported in phase 1: checkout.session.* and payment_intent.payment_failed.
// Phase 2: refund.*, charge.refunded (applyRefund without SAVEPOINT) and account.updated.
import { confirmationInsert } from '../emails.mjs';
import { isUniqueViolation } from '../db.mjs';
import { httpError, live } from '../util.mjs';

const accountMatches = (booking, eventAccount) => (booking.stripe_routing === 'platform' ? !eventAccount : eventAccount === booking.stripe_account_id);
const PORTED = /^(checkout\.session\.|payment_intent\.payment_failed$)/;

export async function handleWebhook(db, { event, credentialId = null, mode = 'stripe_test', emailMode = 'preview', now = Date.now() }) {
  const eventKey = credentialId ? credentialId + ':' + event?.id : event?.id;
  const matches = row => (credentialId ? row.stripe_credential_id === credentialId && !event.account : !row.stripe_credential_id && accountMatches(row, event.account));
  if (event?.livemode !== live(mode) || (typeof event?.data?.object?.livemode === 'boolean' && event.data.object.livemode !== live(mode))) throw httpError(403, 'Webhook payment mode mismatch.');
  if (await db.get('SELECT id FROM webhook_events WHERE id=?', eventKey)) return { duplicate: true };
  const obj = event.data?.object;
  if (typeof event.id !== 'string' || typeof event.type !== 'string' || !obj) throw httpError(400, 'Invalid Stripe event.');
  if (!PORTED.test(event.type) && /^(refund\.|charge\.refunded$|account\.updated$)/.test(event.type)) throw httpError(501, 'This Stripe event type is not ported to Workers yet (RC-4 phase 2).');
  const writes = [];
  if (event.type.startsWith('checkout.session.')) {
    const row = await db.get('SELECT b.*,c.pt_id FROM bookings b JOIN blocks c ON c.id=b.block_id WHERE b.checkout_session=? OR b.id=?', obj.id, obj.metadata?.booking_id || '');
    if (row) {
      if (!row.checkout_session && !(await db.get('SELECT id FROM stripe_jobs WHERE id=?', 'checkout:' + row.id))) throw httpError(400, 'No persisted checkout operation matches this event.');
      const bound = row.stripe_account_id || (await db.get('SELECT stripe_account FROM pts WHERE id=?', row.pt_id))?.stripe_account;
      if (row.mode !== mode || !matches({ ...row, stripe_account_id: bound }) || obj.metadata?.booking_id !== row.id || obj.metadata?.pt_id !== row.pt_id || obj.mode !== 'payment' || (row.checkout_session && row.checkout_session !== obj.id)) throw httpError(400, 'Payment account or booking mismatch.');
      if (obj.amount_total !== row.amount_pence || obj.currency !== 'gbp') throw httpError(400, 'Payment amount mismatch.');
      writes.push(db.stmt('UPDATE bookings SET checkout_session=coalesce(checkout_session,?),stripe_account_id=coalesce(stripe_account_id,?) WHERE id=?', obj.id, bound ?? null, row.id));
      if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) && obj.payment_status === 'paid') {
        const pi = typeof obj.payment_intent === 'object' ? obj.payment_intent?.id : obj.payment_intent;
        if (!/^pi_/.test(pi || '')) throw httpError(400, 'Missing payment reference.');
        if (row.payment_intent && row.payment_intent !== pi) throw httpError(400, 'Payment reference mismatch.');
        // Status first, guarded on paid_at IS NULL (the original's `if(!row.paid_at)`), using
        // commit-time status/expiry: a delayed success after the hold lapsed goes to review.
        writes.push(db.stmt("UPDATE bookings SET status=CASE WHEN status='pending' AND expires_at>? THEN 'paid' ELSE 'review' END WHERE id=? AND paid_at IS NULL", now, row.id));
        writes.push(db.stmt('UPDATE bookings SET payment_intent=?,paid_at=coalesce(paid_at,?),payment_error=NULL WHERE id=? AND (payment_intent IS NULL OR payment_intent=?)', pi, now, row.id, pi));
        if (!row.paid_at) writes.push(await confirmationInsert(db, row.id, { emailMode, now }));
      } else if (['checkout.session.expired', 'checkout.session.async_payment_failed'].includes(event.type) && !row.paid_at && row.status === 'pending') {
        const expired = event.type.endsWith('expired');
        writes.push(db.stmt("UPDATE bookings SET status=?,payment_error=? WHERE id=? AND paid_at IS NULL AND status='pending'", expired ? 'expired' : 'failed', expired ? 'Checkout expired. Please choose a new place.' : 'Stripe reported a failed payment. No booking was confirmed.', row.id));
      }
    }
  } else if (event.type === 'payment_intent.payment_failed') {
    const row = await db.get('SELECT b.* FROM bookings b WHERE b.id=?', obj.metadata?.booking_id || '');
    if (row) {
      if (row.mode !== mode || !matches(row) || obj.amount !== row.amount_pence || obj.currency !== 'gbp' || (row.payment_intent && row.payment_intent !== obj.id)) throw httpError(400, 'Payment failure does not match this booking.');
      if (!row.paid_at) writes.push(db.stmt('UPDATE bookings SET payment_error=? WHERE id=? AND paid_at IS NULL', 'The card payment failed. Retry in Stripe Checkout or cancel the checkout.', row.id));
    }
  }
  try {
    await db.batch([db.stmt('INSERT INTO webhook_events(id,created_at,type,account) VALUES(?,?,?,?)', eventKey, now, event.type, event.account ?? null), ...writes]);
  } catch (error) {
    if (isUniqueViolation(error, 'webhook_events.id')) return { duplicate: true };
    throw error;
  }
  return { received: true };
}
