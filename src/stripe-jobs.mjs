// Stripe job runner (Worker side), ported from app/payments.cjs executeJob() and
// app/server.cjs paymentOperation(). Reads the job, calls Stripe (src/stripe.mjs) with the
// job id as Idempotency-Key, validates the response, then commits through the Writer
// (completeJob/failJob). The Writer is never held during the HTTP call.
import { stripe } from './stripe.mjs';
import { loadCredential } from './pt-credentials.mjs';
import { write } from './writer.mjs';
import { errorExtras, httpError, isStripe, live } from './util.mjs';
import { INTERVAL, invoicePaymentIntent, invoicePeriodStart } from './instalments.mjs';

const validRedirect = (value, hosts) => { try { const u = new URL(value); return u.protocol === 'https:' && hosts.includes(u.hostname); } catch { return false; } };

export async function runJob(env, db, id, { mode, integration }) {
  const row = await db.get('SELECT * FROM stripe_jobs WHERE id=?', id);
  if (!row) throw httpError(404, 'Payment operation not found.');
  const p = JSON.parse(row.payload);
  if ((p.mode || 'stripe_test') !== mode) throw httpError(409, 'Switch to the original payment mode to retry this operation.');
  if (row.status === 'done') return { status: 200, body: JSON.parse(row.result) };
  if (row.status === 'failed') return { status: 409, body: { error: row.last_error || 'This payment operation failed. Start a fresh action.' } };
  // RC-32 m2: a stale pending/retry ACCOUNT job (no payment involved) is retried with the same key
  // instead of blocking Connect for good; payment jobs keep the 23-hour reconcile guard.
  if (row.kind !== 'account' && Date.now() - row.created_at > 23 * 3600000) return { status: 409, body: { error: 'This payment operation is over 23 hours old. Reconcile it in Stripe before starting another request.' } };
  // Legacy pt_direct: the booking's own (decrypted) restricted key, ownership re-checked.
  const credential = p.credential_id ? await loadCredential(db, env, p.credential_id) : null;
  if (integration === 'pt_direct' && !credential) throw httpError(409, 'This historical payment requires its original Connect setup. It cannot use a PT-owned key.');
  if (credential) {
    const bound = await db.get('SELECT b.stripe_credential_id,b.stripe_account_id,c.pt_id FROM bookings b JOIN blocks c ON c.id=b.block_id WHERE b.id=?', row.target_id);
    if (!bound || bound.stripe_credential_id !== credential.id || bound.stripe_account_id !== credential.account_id || bound.pt_id !== credential.pt_id || credential.mode !== p.mode) throw httpError(403, 'Payment credential ownership mismatch.');
  }
  const opts = { mode, integration, ...(credential ? { key: credential.key } : {}) };
  let created = false;
  try {
    let result;
    if (row.kind === 'cancel') {
      const booking = await db.get('SELECT * FROM bookings WHERE id=?', row.target_id);
      if (booking.status !== 'pending') return { status: 200, body: { ok: booking.status === 'cancelled', status: booking.status } };
      // A prior creation call may have reached Stripe before its result was saved: replay it.
      const creation = await db.get('SELECT id FROM stripe_jobs WHERE id=?', 'checkout:' + booking.id);
      if (creation && !booking.checkout_session) { const replay = await runJob(env, db, creation.id, { mode, integration }); if (replay.status >= 400) return replay; }
      const fresh = await db.get('SELECT * FROM bookings WHERE id=?', booking.id);
      const account = fresh.stripe_routing === 'platform' ? undefined : fresh.stripe_account_id;
      if (fresh.checkout_session) {
        const session = await stripe(env, '/v1/checkout/sessions/' + encodeURIComponent(fresh.checkout_session), null, { ...opts, account, method: 'GET' });
        if (session.livemode !== live(mode)) throw httpError(403, 'Session payment mode mismatch.');
        if (session.status === 'complete') throw httpError(409, 'Stripe has completed this checkout. Wait for its signed payment notification; the place has not been released.');
        if (session.status === 'open') await stripe(env, '/v1/checkout/sessions/' + encodeURIComponent(fresh.checkout_session) + '/expire', {}, { ...opts, account, idempotency: id });
      }
      result = {};
    } else if (row.kind === 'plan_schedule' || row.kind === 'plan_stop' || row.kind === 'plan_invoice') {
      result = await planJob(env, db, row, id, opts);
    } else {
      result = await stripe(env, p.path, p.data, { ...opts, account: p.account, idempotency: id, v2: p.v2, method: p.method || 'POST' });
      // RC-32 M1: from here on Stripe has (probably) created the account. Any failure must stay
      // retryable so the next tap replays the SAME Idempotency-Key and gets the same acct_,
      // never a fresh job that would create a second connected account.
      if (row.kind === 'account') created = true;
      if (['link_platform', 'account'].includes(row.kind) && !/^acct_/.test(result.id || '')) throw httpError(409, 'Stripe returned an invalid account.');
      if (row.kind === 'account' && result.livemode !== live(mode)) throw httpError(409, 'Stripe account payment mode mismatch.');
      if (row.kind === 'onboard' && !validRedirect(result.url, ['connect.stripe.com'])) throw httpError(409, 'Stripe did not return a valid onboarding link.');
      if (row.kind === 'checkout' && (result.livemode !== live(mode) || !(live(mode) ? /^cs_live_/ : /^cs_test_/).test(result.id || '') || !validRedirect(result.url, ['checkout.stripe.com']))) throw httpError(409, 'Stripe did not return a matching Checkout Session.');
    }
    return { status: 200, body: await write(env, 'completeJob', { id, result }) };
  } catch (error) {
    // stripeSucceeded: Stripe answered 2xx (so it may have created the object) but the response was rejected.
    if (created || (row.kind === 'account' && error.stripeSucceeded)) error.retryable = true;
    await write(env, 'failJob', { id, retryable: Boolean(error.retryable), message: error.message });
    return { status: error.status || 503, body: { error: error.message || 'Payment operation failed. Please retry.', ...errorExtras(error) } };
  }
}

/** RC-30 plan jobs, on the booking's connected account (Stripe-Account header, direct charges).
 *  plan_schedule: wrap the Checkout subscription in a schedule whose single phase lasts
 *    plan_count intervals from payment 1, end_behavior=cancel, no proration -> billing ends after
 *    the final payment. Two calls, each with its own derived Idempotency-Key.
 *  plan_stop: cancel the subscription now (prorate=false, invoice_now=false); an already
 *    cancelled/missing subscription counts as done. A system end-guard job may also delete a
 *    draft invoice for a payment beyond the plan (best effort). */
async function planJob(env, db, row, id, opts) {
  const b = await db.get('SELECT id,plan,plan_count,plan_status,payment_intent,plan_anchor,stripe_account_id,stripe_subscription_id,stripe_schedule_id FROM bookings WHERE id=?', row.target_id);
  if (!b || !b.plan || b.plan === 'upfront') throw httpError(404, 'Instalment plan not found.', { code: 'NOT_FOUND' });
  const account = b.stripe_account_id || undefined;
  const p = JSON.parse(row.payload);
  if (row.kind === 'plan_invoice') {
    // QA 7116489818: payment 1's PaymentIntent + period start from the first invoice (read only).
    if (b.payment_intent && b.plan_anchor) return { payment_intent: b.payment_intent, period_start: b.plan_anchor };
    if (!/^in_/.test(p.invoice || '')) throw httpError(409, 'No first invoice recorded for this plan.');
    const inv = await stripe(env, '/v1/invoices/' + encodeURIComponent(p.invoice) + '?expand%5B%5D=payments', null, { ...opts, account, method: 'GET' });
    const pi = invoicePaymentIntent(inv);
    if (inv.id !== p.invoice || inv.currency !== 'gbp') throw httpError(409, 'Stripe returned a different invoice.', { retryable: true, stripeSucceeded: true });
    if (!pi) throw httpError(409, 'Stripe has not recorded the first payment on the invoice yet.', { retryable: true, stripeSucceeded: true });
    return { invoice: inv.id, payment_intent: pi, period_start: invoicePeriodStart(inv) };
  }
  if (row.kind === 'plan_schedule') {
    if (b.stripe_schedule_id) return { id: b.stripe_schedule_id };
    if (['stopped', 'completed'].includes(b.plan_status)) return {};
    if (!/^sub_/.test(b.stripe_subscription_id || '')) throw httpError(409, 'The subscription is not recorded yet.', { retryable: true });
    const created = await stripe(env, '/v1/subscription_schedules', { from_subscription: b.stripe_subscription_id }, { ...opts, account, idempotency: id + ':create' });
    const phase = created.phases?.[0], item = phase?.items?.[0];
    const price = typeof item?.price === 'object' ? item.price?.id : item?.price;
    if (!/^sub_sched_/.test(created.id || '') || !Number.isInteger(phase?.start_date) || !/^price_/.test(price || '')) throw httpError(409, 'Stripe did not return a usable subscription schedule.', { retryable: true, stripeSucceeded: true });
    const updated = await stripe(env, '/v1/subscription_schedules/' + encodeURIComponent(created.id), {
      end_behavior: 'cancel', proration_behavior: 'none',
      'phases[0][start_date]': String(phase.start_date),
      'phases[0][items][0][price]': price, 'phases[0][items][0][quantity]': String(item.quantity || 1),
      'phases[0][duration][interval]': INTERVAL[b.plan], 'phases[0][duration][interval_count]': String(b.plan_count),
      'metadata[booking_id]': b.id
    }, { ...opts, account, idempotency: id + ':update' });
    if (updated.id !== created.id || updated.end_behavior !== 'cancel') throw httpError(409, 'Stripe did not confirm the schedule end.', { retryable: true, stripeSucceeded: true });
    return { id: updated.id };
  }
  if (!b.stripe_subscription_id) return {};
  let result;
  try {
    result = await stripe(env, '/v1/subscriptions/' + encodeURIComponent(b.stripe_subscription_id), { prorate: 'false', invoice_now: 'false' }, { ...opts, account, idempotency: id, method: 'DELETE' });
  } catch (error) {
    if (error.stripeStatus !== 404) throw error;
    result = { id: b.stripe_subscription_id, status: 'canceled' };
  }
  if (result.status !== 'canceled') throw httpError(409, 'Stripe did not cancel the subscription.', { retryable: true, stripeSucceeded: true });
  if (/^in_/.test(p.invoice || '')) await stripe(env, '/v1/invoices/' + encodeURIComponent(p.invoice), {}, { ...opts, account, idempotency: id + ':invoice', method: 'DELETE' }).catch(() => null);
  return result;
}

/** RC-30 cron drain: system plan jobs (schedule / end guard) left pending by a failed inline run.
 *  Payment-mode bound; at most `limit` per tick; the 23-hour reconcile guard still applies. */
export async function drainPlanJobs(env, db, { mode = env.PAYMENT_MODE || 'demo', integration = env.STRIPE_INTEGRATION || 'pt_direct', limit = 10, now = Date.now() } = {}) {
  if (!isStripe(mode) || integration !== 'connect') return { ran: 0 };
  const rows = await db.all("SELECT id FROM stripe_jobs WHERE kind IN ('plan_schedule','plan_stop','plan_invoice') AND actor_id='stripe' AND status IN ('pending','retry') AND created_at>? ORDER BY created_at LIMIT ?", now - 23 * 3600000, limit);
  let ran = 0;
  for (const r of rows) { const o = await runJob(env, db, r.id, { mode, integration }); if (o.status === 200) ran++; }
  return { ran, pending: rows.length };
}

/** CR m2: run a booking's pending plan stop jobs now (after a refund). Failures stay for the drain. */
export async function runPlanStops(env, db, bookingId, opts) {
  const rows = await db.all("SELECT id FROM stripe_jobs WHERE kind='plan_stop' AND target_id=? AND status IN ('pending','retry') ORDER BY created_at", bookingId);
  for (const r of rows) {
    try { await runJob(env, db, r.id, opts); } catch (error) { console.error('RC-30 plan stop failed:', error.code || error.name || 'Error'); }
  }
}

/** app/server.cjs paymentOperation(): follow up to 3 chained jobs (account -> onboard). */
export async function paymentOperation(env, db, id, opts) {
  for (let i = 0; i < 3; i++) {
    const outcome = await runJob(env, db, id, opts);
    if (outcome.body.stripe_next) { id = outcome.body.stripe_next; continue; }
    return outcome;
  }
  throw httpError(503, 'Continue Stripe setup to finish this operation.');
}
