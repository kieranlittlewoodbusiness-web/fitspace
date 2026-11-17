// Stripe webhook application, ported from app/payments.cjs:137-183 handleWebhook()
// (one BEGIN IMMEDIATE transaction). Runs inside the Writer queue. All writes for an
// event commit in ONE batch whose first statement inserts the webhook_events key: a
// duplicate delivery (even one that bypassed the queue) hits the PRIMARY KEY, the whole
// batch rolls back, and the event is reported as a duplicate. Applied exactly once.
//
// All event types of the original are ported: checkout.session.*, payment_intent.payment_failed,
// refund.created|updated|failed, charge.refunded (applyRefund without SAVEPOINT) and
// account.updated. A failed precondition or effect aborts the batch, so nothing (not even
// the event key) is recorded and Stripe's retry re-applies the event.
import { confirmationInsert } from '../emails.mjs';
import { isGuardFailure, isUniqueViolation } from '../db.mjs';
import { httpError, live } from '../util.mjs';

const accountMatches = (booking, eventAccount) => (booking.stripe_routing === 'platform' ? !eventAccount : eventAccount === booking.stripe_account_id);

export async function handleWebhook(db, { event, credentialId = null, mode = 'stripe_test', emailMode = 'preview', now = Date.now() }) {
  const eventKey = credentialId ? credentialId + ':' + event?.id : event?.id;
  const matches = row => (credentialId ? row.stripe_credential_id === credentialId && !event.account : !row.stripe_credential_id && accountMatches(row, event.account));
  if (event?.livemode !== live(mode) || (typeof event?.data?.object?.livemode === 'boolean' && event.data.object.livemode !== live(mode))) throw httpError(403, 'Webhook payment mode mismatch.');
  if (await db.get('SELECT id FROM webhook_events WHERE id=?', eventKey)) return { duplicate: true };
  const obj = event.data?.object;
  if (typeof event.id !== 'string' || typeof event.type !== 'string' || !obj) throw httpError(400, 'Invalid Stripe event.');
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
  } else if (['refund.created', 'refund.updated', 'refund.failed', 'charge.refunded'].includes(event.type)) {
    const pi = typeof obj.payment_intent === 'object' ? obj.payment_intent?.id : obj.payment_intent;
    const row = await db.get('SELECT * FROM bookings WHERE payment_intent=? AND mode=?', pi || '', mode);
    if (row && !matches(row)) throw httpError(400, 'Refund account mismatch.');
    if (!row) {
      // CR 5940418854 finding 1: a refund can arrive BEFORE the payment-success event that
      // records payment_intent. If the event names one of our bookings (refund/charge
      // metadata, or an expanded PaymentIntent's metadata) that has no recorded payment yet,
      // answer 409 WITHOUT recording the event key, so Stripe retries it after the payment
      // event. Events with no such reference are recorded as before (legacy behaviour).
      const ref = obj.metadata?.booking_id || (typeof obj.payment_intent === 'object' ? obj.payment_intent?.metadata?.booking_id : null);
      const early = ref ? await db.get('SELECT id,payment_intent,paid_at FROM bookings WHERE id=? AND mode=?', ref, mode) : null;
      if (early && !early.payment_intent) throw httpError(409, 'Payment not recorded yet for this refund; retry later.', { code: 'REFUND_BEFORE_PAYMENT', retryable: true });
    }
    if (row) {
      if (event.type === 'charge.refunded') {
        if (obj.currency !== 'gbp' || obj.amount !== row.amount_pence || !Number.isInteger(obj.amount_refunded) || obj.amount_refunded < 0 || obj.amount_refunded > row.amount_pence) throw httpError(400, 'Refund amount mismatch.');
        // Monotonic: max() in SQL so an older charge.refunded never lowers the total.
        writes.push(db.stmt(
          `UPDATE bookings SET charge_refunded_pence=max(charge_refunded_pence,?),refunded_pence=max(refunded_pence,?),
             refund_status=CASE WHEN max(refunded_pence,?)>=amount_pence THEN 'succeeded' WHEN max(refunded_pence,?)>0 THEN 'partial' ELSE 'none' END,
             status=CASE WHEN max(refunded_pence,?)>=amount_pence THEN 'cancelled' ELSE status END
           WHERE id=?`,
          obj.amount_refunded, obj.amount_refunded, obj.amount_refunded, obj.amount_refunded, obj.amount_refunded, row.id));
      } else {
        writes.push(...(await refundWrites(db, row, obj, Number(event.created) || 0)));
      }
    }
  } else if (event.type === 'account.updated') {
    const updatedAt = (Number(event.created) || 0) * 1000;
    if (credentialId) {
      const c = await db.get('SELECT id,account_id FROM pt_stripe_credentials WHERE id=?', credentialId);
      if (!c) throw httpError(409, 'This payment account is disconnected. Reconnect the same Stripe account or manage the payment directly in Stripe.');
      if (obj.id !== c.account_id || event.account) throw httpError(400, 'Account update mismatch.');
      writes.push(db.stmt('UPDATE pt_stripe_credentials SET charges_ready=?,payouts_ready=?,enabled=CASE WHEN ?=0 THEN 0 ELSE enabled END WHERE id=?', obj.charges_enabled ? 1 : 0, obj.payouts_enabled ? 1 : 0, obj.charges_enabled ? 1 : 0, c.id));
    } else {
      if (event.account && event.account !== obj.id) throw httpError(400, 'Account update mismatch.');
      // RC-5 status mirror; `updated_at<=?` ignores events older than the stored state.
      writes.push(db.stmt(
        `UPDATE stripe_connections SET ready=?,charges_enabled=?,payouts_enabled=?,details_submitted=?,requirements=?,updated_at=?
         WHERE account_id=? AND mode=? AND routing=? AND updated_at<=?`,
        obj.charges_enabled ? 1 : 0, obj.charges_enabled ? 1 : 0, obj.payouts_enabled ? 1 : 0, obj.details_submitted ? 1 : 0,
        JSON.stringify(obj.requirements || {}), updatedAt, obj.id, mode, event.account ? 'connected' : 'platform', updatedAt));
      if (mode === 'stripe_test' && event.account) writes.push(db.stmt('UPDATE pts SET stripe_ready=? WHERE stripe_account=?', obj.charges_enabled ? 1 : 0, obj.id));
    }
  }
  try {
    await db.batch([db.stmt('INSERT INTO webhook_events(id,created_at,type,account) VALUES(?,?,?,?)', eventKey, now, event.type, event.account ?? null), ...writes]);
  } catch (error) {
    if (isUniqueViolation(error, 'webhook_events.id')) return { duplicate: true };
    if (isGuardFailure(error)) throw httpError(400, 'Refund total exceeds the booking payment.');
    throw error;
  }
  return { received: true };
}

// applyRefund (app/payments.cjs:64-89) without SAVEPOINT. The original wrapped
// applyRefundDetails in a savepoint so a failed refund could roll back alone; here the
// statements join the event's batch, so a failure rolls back the whole event (key
// included) and Stripe retries. Ordering and totals are decided in SQL at commit time:
//   - the upsert only replaces an older, non-succeeded refund state (event_time guard),
//   - a guard aborts if succeeded refunds would exceed the booking amount,
//   - the booking totals are recomputed from stripe_refunds, and only when this event's
//     state is the one stored (a stale event changes nothing).
export async function refundWrites(db, row, refund, eventTime) {
  const paymentId = typeof refund.payment_intent === 'object' ? refund.payment_intent?.id : refund.payment_intent;
  if (paymentId !== row.payment_intent || refund.currency !== 'gbp' || !Number.isInteger(refund.amount) || refund.amount < 1 || refund.amount > row.amount_pence || !/^re_/.test(refund.id || '')) throw httpError(400, 'Refund payment or amount mismatch.');
  const previous = await db.get('SELECT * FROM stripe_refunds WHERE id=?', refund.id);
  if (previous && (previous.booking_id !== row.id || previous.amount_pence !== refund.amount)) throw httpError(400, 'Refund booking mismatch.');
  const status = ['succeeded', 'failed', 'canceled', 'pending', 'requires_action'].includes(refund.status) ? refund.status : 'pending';
  const failed = ['failed', 'canceled'].includes(status);
  const total = "max((SELECT coalesce(sum(amount_pence),0) FROM stripe_refunds WHERE booking_id=bookings.id AND status='succeeded'),charge_refunded_pence)";
  const pending = "(SELECT count(*) FROM stripe_refunds WHERE booking_id=bookings.id AND status IN ('pending','requires_action'))";
  return [
    db.stmt(
      `INSERT INTO stripe_refunds VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,event_time=excluded.event_time
       WHERE stripe_refunds.event_time<=excluded.event_time AND stripe_refunds.status<>'succeeded'
         AND stripe_refunds.booking_id=excluded.booking_id AND stripe_refunds.amount_pence=excluded.amount_pence`,
      refund.id, row.id, refund.amount, status, eventTime),
    db.guard('refund_total_within_payment', "(SELECT coalesce(sum(amount_pence),0) FROM stripe_refunds WHERE booking_id=? AND status='succeeded')<=(SELECT amount_pence FROM bookings WHERE id=?)", row.id, row.id),
    db.stmt(
      `UPDATE bookings SET refunded_pence=${total},
         refund_status=CASE WHEN ${total}>=amount_pence THEN 'succeeded' WHEN ${pending}>0 THEN 'pending' WHEN ? THEN 'failed' WHEN ${total}>0 THEN 'partial' ELSE 'none' END,
         refund_error=?,
         status=CASE WHEN ${total}>=amount_pence THEN 'cancelled' ELSE status END
       WHERE id=? AND EXISTS(SELECT 1 FROM stripe_refunds WHERE id=? AND status=? AND event_time=?)`,
      failed ? 1 : 0, failed ? 'Stripe could not complete the refund. The booking remains active.' : null, row.id, refund.id, status, eventTime)
  ];
}
