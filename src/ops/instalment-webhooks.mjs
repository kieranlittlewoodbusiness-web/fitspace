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
import { httpError, uid } from '../util.mjs';
import { seqFromPeriod } from '../instalments.mjs';

const idOf = v => (typeof v === 'object' && v ? v.id : v) || null;
const jobInsert = (db, id, kind, bookingId, payload, now) =>
  db.stmt("INSERT OR IGNORE INTO stripe_jobs(id,kind,target_id,actor_id,payload,created_at) VALUES(?,?,?,'stripe',?,?)", id, kind, bookingId, JSON.stringify(payload), now);

/**
 * CR m3: the system stop job ('end:<booking>', kind plan_stop, actor 'stripe') that cancels the
 * subscription. RC-32 pattern: the latest attempt's id is reused while it is pending, retrying or
 * done, so repeats share one job and one Idempotency-Key; after a failure, or when a pending job
 * is older than the 23-hour reconcile window (the cron drain no longer retries it), a fresh
 * 'end:<booking>:<uid>' id re-arms it. Runs in the Writer, so the read-then-insert is serialised.
 */
export async function endJob(db, bookingId, { mode, reason, invoice, now }) {
  const base = 'end:' + bookingId;
  const latest = await db.get("SELECT id,status,created_at FROM stripe_jobs WHERE kind='plan_stop' AND target_id=? AND (id=? OR substr(id,1,?)=?) ORDER BY created_at DESC, rowid DESC LIMIT 1", bookingId, base, base.length + 1, base + ':');
  const stale = latest && ['pending', 'retry'].includes(latest.status) && now - latest.created_at > 23 * 3600000;
  const id = !latest ? base : latest.status === 'failed' || stale ? base + ':' + uid() : latest.id;
  return { id, stmt: jobInsert(db, id, 'plan_stop', bookingId, { mode, system: true, reason, invoice }, now), rearmed: Boolean(latest) && id !== latest.id };
}

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

/** Payment 1 confirmed: booking paid, plan active, schedule job. CR m2 (PM ruling, "cancel stops
 *  future payments"): if the hold had lapsed (booking -> review, no place), the plan is stopped at
 *  once: future payments void and the end job cancels the subscription on the connected account.
 *  Payment 1 stays recorded for the trainer to refund; the PT list flags it (needs_attention). */
async function confirmFirst(db, row, { sub, customer, invoice, pi, anchor, eventTime, mode, emailMode, now }) {
  const late = row.paid_at ? row.status === 'review' : !(row.status === 'pending' && row.expires_at > now);
  const writes = [
    db.stmt("UPDATE bookings SET status=CASE WHEN status='pending' AND expires_at>? THEN 'paid' ELSE 'review' END WHERE id=? AND paid_at IS NULL", now, row.id),
    db.stmt(
      `UPDATE bookings SET paid_at=coalesce(paid_at,?),payment_error=NULL,plan_status=CASE WHEN ?=1 THEN 'stopped' ELSE coalesce(plan_status,'active') END,
         stripe_subscription_id=coalesce(stripe_subscription_id,?),stripe_customer_id=coalesce(stripe_customer_id,?),
         plan_anchor=coalesce(plan_anchor,?),payment_intent=coalesce(payment_intent,?)
       WHERE id=?`, now, late ? 1 : 0, sub, customer, anchor ?? null, pi ?? null, row.id),
    db.stmt(
      `UPDATE booking_instalments SET status='paid',paid_at=coalesce(paid_at,?),stripe_invoice_id=coalesce(stripe_invoice_id,?),
         stripe_payment_intent=coalesce(stripe_payment_intent,?),next_retry_at=NULL,failure=NULL,event_time=max(event_time,?)
       WHERE booking_id=? AND seq=1`, now, invoice ?? null, pi ?? null, eventTime, row.id)
  ];
  if (late) {
    writes.push(db.stmt("UPDATE booking_instalments SET status='void',next_retry_at=NULL WHERE booking_id=? AND status IN ('upcoming','failed')", row.id));
    const end = await endJob(db, row.id, { mode, reason: 'late_payment', now });
    if (!row.paid_at) writes.push(db.stmt('INSERT OR IGNORE INTO audit_log VALUES(?,?,?,?,?)', 'late:' + row.id, null, 'instalment_late_payment_stopped', row.id, now));
    writes.push(end.stmt);
    return { writes, jobs: [end.id] };
  }
  writes.push(jobInsert(db, 'schedule:' + row.id, 'plan_schedule', row.id, { mode, system: true }, now));
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
  const stopBilling = async (invoice, reason = 'end_guard') => {
    const end = await endJob(db, row.id, { mode, reason, invoice, now });
    if (end.rearmed) console.error('RC-30 ALERT: re-armed the stop job for booking', row.id);
    writes.push(end.stmt); jobs.push(end.id);
  };

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

  // Billing must end after the final payment: an invoice beyond N, or any billing invoice after a
  // stop or a late payment 1 (booking in review), (re-)arms the stop job (CR m3).
  const billing = ['invoice.created', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed'].includes(event.type);
  const halted = row.plan_status === 'stopped' || row.status === 'review';
  if (!inst) {
    if (billing) await stopBilling(obj.status === 'draft' ? obj.id : undefined);
    console.error('RC-30 ALERT: billing past plan_count for booking', row.id, 'payment', seq, 'of', row.plan_count, event.type);
    writes.push(db.stmt('INSERT INTO audit_log VALUES(?,?,?,?,?)', 'overrun:' + event.id, null, 'instalment_overrun:seq=' + seq, row.id, now));
    return { writes, jobs };
  }
  // (payment 1's own invoice.paid is handled by confirmFirst, which stops a late plan itself)
  if (halted && billing && !(event.type === 'invoice.paid' && seq === 1)) await stopBilling(obj.status === 'draft' ? obj.id : undefined, 'halted');
  if (halted && ['invoice.created', 'invoice.finalized'].includes(event.type)) return { writes, jobs };
  if (event.type === 'invoice.paid') {
    // Nit: a mismatched amount is recorded for the trainer (audit) and acknowledged, never lost to retries.
    if (obj.amount_paid !== inst.amount_pence) {
      console.error('RC-30 ALERT: instalment amount mismatch for booking', row.id, 'payment', seq);
      writes.push(db.stmt('INSERT INTO audit_log VALUES(?,?,?,?,?)', 'mismatch:' + event.id, null, 'instalment_amount_mismatch:seq=' + seq + ':paid=' + Number(obj.amount_paid) + ':due=' + inst.amount_pence, row.id, now));
      return { writes, jobs };
    }
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
    if (seq === row.plan_count && !row.stripe_schedule_id) await stopBilling();
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
