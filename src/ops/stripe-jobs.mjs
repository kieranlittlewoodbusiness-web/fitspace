// Stripe payment operations, ported from app/payments.cjs prepare*() and executeJob().
// Split in two so a Stripe call never runs inside the Writer:
//   prepare* (Writer ops, here): validate under scopeFor() and persist a stripe_jobs row
//     with INSERT OR IGNORE on a deterministic id, which is also the Stripe Idempotency-Key.
//   runJob (Worker, src/stripe-jobs.mjs): calls Stripe, then commits the result here with
//     completeJob/failJob: one guarded batch, `WHERE status<>'done'`, so concurrent or
//     retried runs of one job apply its effects once.
import { scopeFor } from '../scope.mjs';
import { isGuardFailure } from '../db.mjs';
import { httpError, isStripe, live, uid } from '../util.mjs';
import { platformLinkDisabledError, singleConnectExistsError } from '../multi-pt.mjs';
import { resolveConnectPtId } from '../connect-status.mjs';
import { stripeConnection } from './bookings.mjs';
import { refundWrites } from './webhooks.mjs';

async function actor(db, userId) {
  const user = await db.get('SELECT id,role,pt_id,email,name,must_change_password FROM users WHERE id=? AND active=1', userId);
  if (!user) throw httpError(401, 'Please sign in to continue.', { code: 'UNAUTHENTICATED' });
  return user;
}
const jobStmt = (db, id, kind, target, actorId, payload, now) =>
  db.stmt('INSERT OR IGNORE INTO stripe_jobs(id,kind,target_id,actor_id,payload,created_at) VALUES(?,?,?,?,?,?)', id, kind, target, actorId, JSON.stringify(payload), now);
async function job(db, id, kind, target, actorId, payload, now) {
  await db.batch([jobStmt(db, id, kind, target, actorId, payload, now)]);
  return id;
}
const expireStmt = (db, now) => db.stmt("UPDATE bookings SET status='expired' WHERE status='pending' AND expires_at<=?", now);

/** POST /api/bookings (Stripe) and /api/bookings/:id/checkout. Customer-own booking only. */
export async function prepareCheckout(db, { bookingId, userId, origin, mode, integration = 'connect', now = Date.now() }) {
  const user = await actor(db, userId);
  await db.batch([expireStmt(db, now)]);
  const booking = await scopeFor(db, user).booking(bookingId);
  if (!booking || !isStripe(booking.mode) || booking.mode !== mode || booking.customer_id !== user.id) throw httpError(404, 'Checkout not found.');
  if (booking.status !== 'pending') throw httpError(409, 'This checkout is no longer active.');
  const id = 'checkout:' + booking.id;
  if (await db.get('SELECT id FROM stripe_jobs WHERE id=?', id)) return id;
  const c = await stripeConnection(db, booking.pt_id, mode, integration);
  if (!c?.ready || booking.stripe_account_id !== c.account_id || booking.stripe_routing !== c.routing || booking.stripe_credential_id !== (c.credential_id || null)) throw httpError(409, 'This trainer is not ready for payments in this mode.');
  const data = {
    mode: 'payment', 'payment_method_types[0]': 'card', 'line_items[0][price_data][currency]': 'gbp', 'line_items[0][price_data][unit_amount]': String(booking.amount_pence),
    'line_items[0][price_data][product_data][name]': booking.title, 'line_items[0][quantity]': '1', customer_email: user.email, client_reference_id: booking.id,
    'metadata[booking_id]': booking.id, 'metadata[pt_id]': booking.pt_id, 'payment_intent_data[metadata][booking_id]': booking.id, 'payment_intent_data[metadata][pt_id]': booking.pt_id,
    success_url: origin + '/booking/' + booking.id + '?stripe=return', cancel_url: origin + '/checkout/' + booking.id + '?stripe=cancel', expires_at: String(Math.floor(booking.expires_at / 1000))
  };
  return job(db, id, 'checkout', booking.id, user.id, { mode, credential_id: booking.stripe_credential_id || undefined, path: '/v1/checkout/sessions', account: booking.stripe_routing === 'platform' ? undefined : booking.stripe_account_id, data }, now);
}

/** POST /api/bookings/:id/cancel for an unpaid Stripe checkout (scoped by the route). */
export async function prepareCancel(db, { bookingId, userId, mode, now = Date.now() }) {
  const user = await actor(db, userId);
  const booking = await scopeFor(db, user).booking(bookingId);
  if (!booking) throw httpError(404, 'Booking not found.');
  if (!isStripe(booking.mode) || booking.mode !== mode || booking.status !== 'pending') throw httpError(409, 'Only an active unpaid Stripe checkout can be cancelled.');
  return job(db, 'cancel:' + booking.id, 'cancel', booking.id, user.id, { mode, credential_id: booking.stripe_credential_id || undefined }, now);
}

/** POST /api/bookings/:id/refund (PT on own bookings, admin). One active refund per booking. */
export async function prepareRefund(db, { bookingId, userId, token, mode, now = Date.now() }) {
  const user = await actor(db, userId);
  if (!['pt', 'admin'].includes(user.role)) throw httpError(403, 'Only the trainer or admin can refund a payment.');
  if (!/^[a-zA-Z0-9-]{12,80}$/.test(token || '')) throw httpError(400, 'Refresh the page before requesting a refund.');
  const booking = await scopeFor(db, user).booking(bookingId);
  if (!booking) throw httpError(404, 'Booking not found.');
  if (!isStripe(booking.mode) || booking.mode !== mode || !booking.payment_intent || !['paid', 'review'].includes(booking.status) || booking.refunded_pence >= booking.amount_pence) throw httpError(409, 'There is no refundable Stripe payment in the current mode on this booking.');
  const activeSql = "SELECT id FROM stripe_jobs WHERE target_id=? AND kind='refund' AND status IN ('pending','retry') ORDER BY created_at DESC LIMIT 1";
  const active = await db.get(activeSql, booking.id);
  if (active) return active.id;
  if (booking.refund_status === 'pending') throw httpError(409, 'Stripe is still processing a refund. Wait for its notification before retrying.');
  const id = 'refund:' + booking.id + ':' + token;
  if (await db.get('SELECT id FROM stripe_jobs WHERE id=?', id)) return id;
  try {
    await db.batch([
      // Commit-time: no other refund job became active, and the amount is still refundable.
      db.guard('one_active_refund', "NOT EXISTS(SELECT 1 FROM stripe_jobs WHERE target_id=? AND kind='refund' AND status IN ('pending','retry')) AND EXISTS(SELECT 1 FROM bookings WHERE id=? AND refunded_pence<amount_pence AND refund_status<>'pending')", booking.id, booking.id),
      db.stmt("UPDATE bookings SET refund_status='requested',refund_error=NULL WHERE id=?", booking.id),
      jobStmt(db, id, 'refund', booking.id, user.id, { mode, credential_id: booking.stripe_credential_id || undefined, path: '/v1/refunds', account: booking.stripe_routing === 'platform' ? undefined : booking.stripe_account_id, data: { payment_intent: booking.payment_intent, amount: String(booking.amount_pence - booking.refunded_pence), 'metadata[booking_id]': booking.id } }, now)
    ]);
  } catch (error) {
    if (!isGuardFailure(error)) throw error;
    const other = await db.get(activeSql, booking.id);
    if (other) return other.id;
    throw httpError(409, 'Stripe is still processing a refund. Wait for its notification before retrying.');
  }
  return id;
}

const onboardPayload = (mode, account, origin) => ({ mode, path: '/v2/core/account_links', v2: true, data: { account, use_case: { type: 'account_onboarding', account_onboarding: { configurations: ['merchant'], refresh_url: origin + '/dashboard?tab=payments&connect=refresh', return_url: origin + '/dashboard?tab=payments&connect=return', collection_options: { fields: 'eventually_due' } } } } });

/** POST /api/pt/stripe/connect: the PT owner or admin. multiPt defaults false (fail-closed). */
export async function prepareConnect(db, { userId, origin, mode, integration = 'connect', multiPt = false, ptId = null, now = Date.now() }) {
  const user = await actor(db, userId);
  if (user.must_change_password) throw httpError(403, 'Change your temporary password first.', { code: 'PASSWORD_CHANGE_REQUIRED' });
  if (integration === 'pt_direct') throw httpError(409, 'Use Payments setup to save your own restricted key and webhook secret.', { code: 'USE_PAYMENTS_SETUP' });
  const targetId = await resolveConnectPtId(db, user, ptId, { multiPt });
  const pt = await db.get('SELECT * FROM pts WHERE id=?', targetId);
  const c = await stripeConnection(db, pt.id, mode, integration);
  if (c) {
    if (c.routing === 'platform') throw httpError(409, 'The admin has linked the platform Stripe account. Check its status instead.', { code: 'PLATFORM_ACCOUNT_LINKED' });
    return job(db, 'onboard:' + uid(), 'onboard', pt.id, user.id, { ...onboardPayload(mode, c.account_id, origin), multiPt }, now);
  }
  if (!multiPt) {
    const other = await db.get('SELECT pt_id FROM stripe_connections WHERE NOT (pt_id=? AND mode=?) LIMIT 1', pt.id, mode);
    if (other) throw singleConnectExistsError();
  }
  return job(db, 'account:' + (live(mode) ? 'live:' : '') + pt.id, 'account', pt.id, user.id, { mode, origin, multiPt, path: '/v2/core/accounts', v2: true, data: { contact_email: user.email, display_name: pt.brand_name, dashboard: 'full', identity: { country: 'gb' }, configuration: { merchant: { capabilities: { card_payments: { requested: true } } } }, defaults: { currency: 'gbp', responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' }, locales: ['en-GB'] }, include: ['configuration.merchant'] } }, now);
}

/** POST /api/admin/stripe/link (admin only). Disabled in single-PT mode. multiPt defaults false (fail-closed). */
export async function prepareLink(db, { userId, ptId, mode, integration = 'connect', multiPt = false, now = Date.now() }) {
  const user = await actor(db, userId);
  if (user.role !== 'admin') throw httpError(403, 'Your account does not have access to this action.', { code: 'FORBIDDEN' });
  if (integration === 'pt_direct') throw httpError(403, 'Owner account linking is disabled. Each PT must configure their own account.', { code: 'USE_PAYMENTS_SETUP' });
  if (!multiPt) throw platformLinkDisabledError();
  if (typeof ptId !== 'string' || !(await db.get('SELECT id FROM pts WHERE id=?', ptId))) throw httpError(404, 'Trainer not found.', { code: 'TRAINER_NOT_FOUND' });
  return job(db, 'link:' + uid(), 'link_platform', ptId, user.id, { mode, multiPt, path: '/v1/account', method: 'GET' }, now);
}

const bindStmts = (db, ptId, mode, account, routing, ready, { multiPt = false } = {}) => [
  db.guard('account_not_other_pt', 'NOT EXISTS(SELECT 1 FROM stripe_connections WHERE mode=? AND account_id=? AND pt_id<>?)', mode, account, ptId),
  // RC-14: at most one Connect account on the site when single-PT mode is on.
  multiPt ? null : db.guard('single_connect', 'NOT EXISTS(SELECT 1 FROM stripe_connections WHERE NOT (pt_id=? AND mode=?))', ptId, mode),
  db.stmt('INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready) VALUES(?,?,?,?,?) ON CONFLICT(pt_id,mode) DO UPDATE SET account_id=excluded.account_id,routing=excluded.routing,ready=excluded.ready', ptId, mode, account, routing, ready ? 1 : 0),
  mode === 'stripe_test' && routing === 'connected' ? db.stmt('UPDATE pts SET stripe_account=?,stripe_ready=? WHERE id=?', account, ready ? 1 : 0, ptId) : null
];

/** Commit a Stripe result. Effects + `status='done'` in ONE batch, applied once. */
export async function completeJob(db, { id, result, now = Date.now() }) {
  const row = await db.get('SELECT * FROM stripe_jobs WHERE id=?', id);
  if (!row) throw httpError(404, 'Payment operation not found.');
  if (row.status === 'done') return JSON.parse(row.result);
  const p = JSON.parse(row.payload);
  const multiPt = p.multiPt === true;
  const writes = [db.guard('job_not_done', "EXISTS(SELECT 1 FROM stripe_jobs WHERE id=? AND status<>'done')", id)];
  let out;
  if (row.kind === 'link_platform') {
    writes.push(...bindStmts(db, row.target_id, p.mode, result.id, 'platform', Boolean(result.charges_enabled), { multiPt }));
    out = { ok: true, account_id: result.id, ready: Boolean(result.charges_enabled), mode: p.mode };
  } else if (row.kind === 'account') {
    const next = 'onboard:' + uid();
    writes.push(...bindStmts(db, row.target_id, p.mode, result.id, 'connected', false, { multiPt }));
    writes.push(jobStmt(db, next, 'onboard', row.target_id, row.actor_id, { ...onboardPayload(p.mode, result.id, p.origin), multiPt }, now));
    out = { stripe_next: next };
  } else if (row.kind === 'onboard') {
    out = { url: result.url };
  } else if (row.kind === 'checkout') {
    writes.push(db.guard('checkout_session_matches', 'EXISTS(SELECT 1 FROM bookings WHERE id=? AND (checkout_session IS NULL OR checkout_session=?))', row.target_id, result.id));
    writes.push(db.stmt('UPDATE bookings SET checkout_session=?,checkout_url=? WHERE id=?', result.id, result.url, row.target_id));
    out = { url: result.url, booking_id: row.target_id };
  } else if (row.kind === 'refund') {
    const booking = await db.get('SELECT * FROM bookings WHERE id=?', row.target_id);
    writes.push(...(await refundWrites(db, booking, result, 0)));
    out = { ok: true, refund_id: result.id, refund_status: result.status };
  } else if (row.kind === 'cancel') {
    writes.push(db.stmt("UPDATE bookings SET status='cancelled' WHERE id=? AND status='pending'", row.target_id));
    out = { ok: true };
  } else throw httpError(400, 'Unknown Stripe operation.');
  writes.push(db.stmt("UPDATE stripe_jobs SET status='done',result=?,last_error=NULL WHERE id=? AND status<>'done'", JSON.stringify(out), id));
  try {
    await db.batch(writes);
  } catch (error) {
    if (!isGuardFailure(error)) throw error;
    const again = await db.get('SELECT status,result FROM stripe_jobs WHERE id=?', id);
    if (again?.status === 'done') return JSON.parse(again.result); // a concurrent run committed first
    if ((row.kind === 'account' || row.kind === 'link_platform') && p.multiPt !== true) throw singleConnectExistsError();
    throw httpError(409, error.message.includes('account_not_other_pt') || row.kind === 'account' || row.kind === 'link_platform' ? 'This Stripe account is already assigned to another trainer in this payment mode.' : 'Checkout Session mismatch.', { code: error.message.includes('account_not_other_pt') || row.kind === 'account' || row.kind === 'link_platform' ? 'ACCOUNT_ASSIGNED' : 'CHECKOUT_SESSION_MISMATCH' });
  }
  return out;
}

/** Record a failed attempt (never overwrites a completed job). */
export async function failJob(db, { id, retryable, message }) {
  const row = await db.get('SELECT * FROM stripe_jobs WHERE id=?', id);
  if (!row || row.status === 'done') return;
  const writes = [db.stmt("UPDATE stripe_jobs SET status=?,last_error=? WHERE id=? AND status<>'done'", retryable ? 'retry' : 'failed', String(message).slice(0, 500), id)];
  if (row.kind === 'checkout' && !retryable) writes.push(db.stmt("UPDATE bookings SET status='failed',payment_error=? WHERE id=? AND status='pending' AND EXISTS(SELECT 1 FROM stripe_jobs WHERE id=? AND status='failed')", 'Stripe could not create this checkout. Please book a fresh place.', row.target_id, id));
  if (row.kind === 'refund' && !retryable) writes.push(db.stmt("UPDATE bookings SET refund_status='failed',refund_error=? WHERE id=? AND EXISTS(SELECT 1 FROM stripe_jobs WHERE id=? AND status='failed')", 'Stripe could not start the refund. Retry with a new refund request.', row.target_id, id));
  await db.batch(writes);
}
