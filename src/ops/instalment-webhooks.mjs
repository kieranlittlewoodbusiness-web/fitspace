// RC-30 instalment plan events, applied inside handleWebhook's ONE batch (webhook_events key
// first, so a duplicate delivery of the same event.id is a no-op). Order-independent:
//   - a payment row only moves upcoming/failed -> failed when the event is not older than the
//     last applied one (event_time), and `paid` is never overwritten by a failure or void;
//   - plan_status is recomputed in SQL from the rows at commit time (planStatusStmt);
//   - an invoice for payment N+1 or later (or after a stop) enqueues a system end job;
//   - an invoice that arrives before payment 1 fixed the plan anchor is answered 409 WITHOUT
//     recording the event, so Stripe redelivers it later.
// Failed payments keep the booking (PM default): only the payment row and plan_status change.
import { confirmationInsert } from '../emails.mjs';
import { httpError } from '../util.mjs';
import { seqFromPeriod } from '../instalments.mjs';

const idOf = v => (typeof v === 'object' && v ? v.id : v) || null;
const jobInsert = (db, id, kind, bookingId, payload, now) =>
  db.stmt("INSERT OR IGNORE INTO stripe_jobs(id,kind,target_id,actor_id,payload,created_at) VALUES(?,?,?,'stripe',?,?)", id, kind, bookingId, JSON.stringify(payload), now);

/** Payment 1's billing period start (unix s), set once. */
const anchorStmt = (db, bookingId, periodStart) => db.stmt('UPDATE bookings SET plan_anchor=coalesce(plan_anchor,?) WHERE id=?', periodStart, bookingId);

/** plan_status from the rows: stopped stays stopped; all paid -> completed; any failed -> past_due. */
export const planStatusStmt = (db, bookingId) => db.stmt(
  `UPDATE bookings SET plan_status=CASE
     WHEN plan_status='stopped' THEN 'stopped'
     WHEN (SELECT count(*) FROM booking_instalments WHERE booking_id=bookings.id AND status='paid')>=plan_count THEN 'completed'
     WHEN EXISTS(SELECT 1 FROM booking_instalments WHERE booking_id=bookings.id AND status='failed') THEN 'past_due'
     ELSE 'active' END
   WHERE id=? AND plan<>'upfront' AND plan_status IS NOT NULL`, bookingId);

/** Payment 1 confirmed: booking paid (or review after a lapsed hold), plan active, schedule job. */
async function confirmFirst(db, row, { sub, customer, invoice, pi, anchor, eventTime, mode, emailMode, now }) {
  const writes = [
    db.stmt("UPDATE bookings SET status=CASE WHEN status='pending' AND expires_at>? THEN 'paid' ELSE 'review' END WHERE id=? AND paid_at IS NULL", now, row.id),
    db.stmt(
      `UPDATE bookings SET paid_at=coalesce(paid_at,?),payment_error=NULL,plan_status=coalesce(plan_status,'active'),
         stripe_subscription_id=coalesce(stripe_subscription_id,?),stripe_customer_id=coalesce(stripe_customer_id,?),
         plan_anchor=coalesce(plan_anchor,?),payment_intent=coalesce(payment_intent,?)
       WHERE id=?`, now, sub, customer, anchor ?? null, pi ?? null, row.id),
    db.stmt(
      `UPDATE booking_instalments SET status='paid',paid_at=coalesce(paid_at,?),stripe_invoice_id=coalesce(stripe_invoice_id,?),
         stripe_payment_intent=coalesce(stripe_payment_intent,?),next_retry_at=NULL,failure=NULL,event_time=max(event_time,?)
       WHERE booking_id=? AND seq=1`, now, invoice ?? null, pi ?? null, eventTime, row.id),
    jobInsert(db, 'schedule:' + row.id, 'plan_schedule', row.id, { mode, system: true }, now)
  ];
  if (!row.paid_at) writes.push(await confirmationInsert(db, row.id, { emailMode, now }));
  writes.push(planStatusStmt(db, row.id));
  return { writes, jobs: ['schedule:' + row.id] };
}

/** checkout.session.completed / async_payment_succeeded for a plan (mode=subscription). */
export async function planCheckoutPaid(db, row, obj, { mode, emailMode, eventTime, now }) {
  const sub = idOf(obj.subscription), customer = idOf(obj.customer), invoice = idOf(obj.invoice);
  if (!/^sub_/.test(sub || '') || !/^cus_/.test(customer || '')) throw httpError(400, 'Missing subscription reference.');
  if (row.stripe_subscription_id && row.stripe_subscription_id !== sub) throw httpError(400, 'Subscription reference mismatch.');
  return confirmFirst(db, row, { sub, customer, invoice, eventTime, mode, emailMode, now });
}

/** Expired/failed plan checkout: its upcoming payments become void once the booking is released. */
export const planCheckoutReleased = (db, row) => db.stmt(
  "UPDATE booking_instalments SET status='void' WHERE booking_id=? AND status='upcoming' AND EXISTS(SELECT 1 FROM bookings WHERE id=? AND status IN ('expired','failed'))", row.id, row.id);

/** invoice.* and customer.subscription.* on the PT's connected account. */
export async function planEvent(db, { event, mode, matches, emailMode, now }) {
  const obj = event.data.object;
  const isSub = event.type.startsWith('customer.subscription.');
  const details = obj.parent?.subscription_details || {};
  const sub = isSub ? obj.id : idOf(details.subscription ?? obj.subscription);
  const meta = (isSub ? obj.metadata : details.metadata) || {};
  if (!sub && !meta.booking_id) return { writes: [], jobs: [] };
  const row = await db.get('SELECT * FROM bookings WHERE (stripe_subscription_id IS NOT NULL AND stripe_subscription_id=?) OR id=? LIMIT 1', sub || '', meta.booking_id || '');
  // Not one of ours (e.g. the PT's own other subscriptions): record the event, change nothing.
  if (!row || !row.plan || row.plan === 'upfront') return { writes: [], jobs: [] };
  if (row.mode !== mode || !matches(row) || (row.stripe_subscription_id && sub && row.stripe_subscription_id !== sub) || (meta.booking_id && meta.booking_id !== row.id)) throw httpError(400, 'Plan event does not match this booking.');
  const eventTime = Number(event.created) || 0;
  const writes = [], jobs = [];
  const endJob = invoice => { const id = 'end:' + row.id; writes.push(jobInsert(db, id, 'plan_stop', row.id, { mode, system: true, reason: 'end_guard', invoice }, now)); jobs.push(id); };

  if (isSub) {
    if (sub && !row.stripe_subscription_id) writes.push(db.stmt('UPDATE bookings SET stripe_subscription_id=coalesce(stripe_subscription_id,?) WHERE id=?', sub, row.id));
    if (event.type === 'customer.subscription.deleted') {
      writes.push(db.stmt("UPDATE booking_instalments SET status='void',next_retry_at=NULL WHERE booking_id=? AND status IN ('upcoming','failed')", row.id));
      writes.push(db.stmt(
        `UPDATE bookings SET plan_status=CASE WHEN (SELECT count(*) FROM booking_instalments WHERE booking_id=bookings.id AND status='paid')>=plan_count THEN 'completed' ELSE 'stopped' END
         WHERE id=? AND plan_status IS NOT NULL`, row.id));
    } else writes.push(planStatusStmt(db, row.id));
    return { writes, jobs };
  }

  // ---- invoices ----
  if (obj.currency && obj.currency !== 'gbp') throw httpError(400, 'Invoice currency mismatch.');
  const line = obj.lines?.data?.find(l => l?.period?.start) || null;
  const periodStart = line?.period?.start ?? obj.period_start;
  const bound = obj.id ? await db.get('SELECT * FROM booking_instalments WHERE stripe_invoice_id=?', obj.id) : null;
  if (bound && bound.booking_id !== row.id) throw httpError(400, 'Invoice belongs to another booking.');
  let seq;
  if (bound) seq = bound.seq;
  else if (obj.billing_reason === 'subscription_create') seq = 1;
  else {
    // Anchor: payment 1's billing period start; else (checkout-only so far) payment 1's paid time.
    const first = row.plan_anchor ? null : await db.get("SELECT paid_at FROM booking_instalments WHERE booking_id=? AND seq=1 AND status='paid'", row.id);
    const anchor = row.plan_anchor || (first?.paid_at ? Math.floor(first.paid_at / 1000) : null);
    if (!anchor) throw httpError(409, 'The first payment of this plan is not recorded yet; retry later.', { code: 'PLAN_ANCHOR_PENDING', retryable: true });
    seq = seqFromPeriod(row.plan, anchor, periodStart);
    if (!seq) throw httpError(400, 'Invoice period does not match this plan.');
  }
  const inst = seq <= row.plan_count ? await db.get('SELECT * FROM booking_instalments WHERE booking_id=? AND seq=?', row.id, seq) : null;
  const pi = idOf(obj.payments?.data?.find(p => p?.payment?.payment_intent)?.payment?.payment_intent) || idOf(obj.payment_intent);
  const dueMs = Number.isFinite(periodStart) ? periodStart * 1000 : null;

  // Billing must end after the final payment: anything beyond it (or after a stop) is ended.
  if (!inst || (['stopped'].includes(row.plan_status) && ['invoice.created', 'invoice.finalized'].includes(event.type))) {
    if (['invoice.created', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed'].includes(event.type)) endJob(obj.status === 'draft' ? obj.id : undefined);
    if (!inst) writes.push(db.stmt('INSERT INTO audit_log VALUES(?,?,?,?,?)', 'overrun:' + event.id, null, 'instalment_overrun:seq=' + seq, row.id, now));
    return { writes, jobs };
  }
  if (event.type === 'invoice.paid') {
    if (obj.amount_paid !== inst.amount_pence) throw httpError(400, 'Instalment amount mismatch.');
    if (seq === 1) {
      const first = await confirmFirst(db, row, { sub, customer: idOf(obj.customer), invoice: obj.id, pi, anchor: periodStart, eventTime, mode, emailMode, now });
      return first;
    }
    const paidAt = (Number(obj.status_transitions?.paid_at) || 0) * 1000 || now;
    writes.push(db.stmt(
      `UPDATE booking_instalments SET status='paid',paid_at=coalesce(paid_at,?),stripe_invoice_id=coalesce(stripe_invoice_id,?),stripe_payment_intent=coalesce(stripe_payment_intent,?),
         next_retry_at=NULL,failure=NULL,due_at=coalesce(?,due_at),event_time=max(event_time,?)
       WHERE booking_id=? AND seq=? AND (stripe_invoice_id IS NULL OR stripe_invoice_id=?)`, paidAt, obj.id, pi ?? null, dueMs, eventTime, row.id, seq, obj.id));
    // Final payment collected: if the end-after-N schedule never attached, end billing now.
    if (seq === row.plan_count && !row.stripe_schedule_id) endJob();
  } else if (event.type === 'invoice.payment_failed') {
    if (seq === 1 && periodStart) writes.push(anchorStmt(db, row.id, periodStart));
    writes.push(db.stmt(
      `UPDATE booking_instalments SET status='failed',attempts=max(attempts,?),next_retry_at=?,failure=?,stripe_invoice_id=coalesce(stripe_invoice_id,?),due_at=coalesce(?,due_at),event_time=?
       WHERE booking_id=? AND seq=? AND status IN ('upcoming','failed') AND event_time<=? AND (stripe_invoice_id IS NULL OR stripe_invoice_id=?)`,
      Number(obj.attempt_count) || 1, obj.next_payment_attempt ? obj.next_payment_attempt * 1000 : null, 'The card payment failed.', obj.id, dueMs, eventTime, row.id, seq, eventTime, obj.id));
  } else if (event.type === 'invoice.voided') {
    writes.push(db.stmt(`UPDATE booking_instalments SET status='void',next_retry_at=NULL,stripe_invoice_id=coalesce(stripe_invoice_id,?),event_time=max(event_time,?) WHERE booking_id=? AND seq=? AND status<>'paid' AND (stripe_invoice_id IS NULL OR stripe_invoice_id=?)`, obj.id, eventTime, row.id, seq, obj.id));
  } else if (event.type === 'invoice.marked_uncollectible') {
    writes.push(db.stmt(`UPDATE booking_instalments SET status='failed',next_retry_at=NULL,stripe_invoice_id=coalesce(stripe_invoice_id,?),event_time=max(event_time,?) WHERE booking_id=? AND seq=? AND status IN ('upcoming','failed') AND (stripe_invoice_id IS NULL OR stripe_invoice_id=?)`, obj.id, eventTime, row.id, seq, obj.id));
  } else if (event.type === 'invoice.created' || event.type === 'invoice.finalized') {
    if (seq === 1 && periodStart) writes.push(anchorStmt(db, row.id, periodStart));
    writes.push(db.stmt(`UPDATE booking_instalments SET stripe_invoice_id=coalesce(stripe_invoice_id,?),due_at=coalesce(?,due_at) WHERE booking_id=? AND seq=? AND status='upcoming' AND (stripe_invoice_id IS NULL OR stripe_invoice_id=?)`, obj.id, dueMs, row.id, seq, obj.id));
  }
  writes.push(planStatusStmt(db, row.id));
  return { writes, jobs };
}
