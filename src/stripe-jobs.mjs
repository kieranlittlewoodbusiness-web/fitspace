// Stripe job runner (Worker side), ported from app/payments.cjs executeJob() and
// app/server.cjs paymentOperation(). Reads the job, calls Stripe (src/stripe.mjs) with the
// job id as Idempotency-Key, validates the response, then commits through the Writer
// (completeJob/failJob). The Writer is never held during the HTTP call.
import { stripe } from './stripe.mjs';
import { loadCredential } from './pt-credentials.mjs';
import { write } from './writer.mjs';
import { errorExtras, httpError, live } from './util.mjs';

const validRedirect = (value, hosts) => { try { const u = new URL(value); return u.protocol === 'https:' && hosts.includes(u.hostname); } catch { return false; } };

export async function runJob(env, db, id, { mode, integration }) {
  const row = await db.get('SELECT * FROM stripe_jobs WHERE id=?', id);
  if (!row) throw httpError(404, 'Payment operation not found.');
  const p = JSON.parse(row.payload);
  if ((p.mode || 'stripe_test') !== mode) throw httpError(409, 'Switch to the original payment mode to retry this operation.');
  if (row.status === 'done') return { status: 200, body: JSON.parse(row.result) };
  if (row.status === 'failed') return { status: 409, body: { error: row.last_error || 'This payment operation failed. Start a fresh action.' } };
  if (Date.now() - row.created_at > 23 * 3600000) return { status: 409, body: { error: 'This payment operation is over 23 hours old. Reconcile it in Stripe before starting another request.' } };
  // Legacy pt_direct: the booking's own (decrypted) restricted key, ownership re-checked.
  const credential = p.credential_id ? await loadCredential(db, env, p.credential_id) : null;
  if (integration === 'pt_direct' && !credential) throw httpError(409, 'This historical payment requires its original Connect setup. It cannot use a PT-owned key.');
  if (credential) {
    const bound = await db.get('SELECT b.stripe_credential_id,b.stripe_account_id,c.pt_id FROM bookings b JOIN blocks c ON c.id=b.block_id WHERE b.id=?', row.target_id);
    if (!bound || bound.stripe_credential_id !== credential.id || bound.stripe_account_id !== credential.account_id || bound.pt_id !== credential.pt_id || credential.mode !== p.mode) throw httpError(403, 'Payment credential ownership mismatch.');
  }
  const opts = { mode, integration, ...(credential ? { key: credential.key } : {}) };
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
    } else {
      result = await stripe(env, p.path, p.data, { ...opts, account: p.account, idempotency: id, v2: p.v2, method: p.method || 'POST' });
      if (['link_platform', 'account'].includes(row.kind) && !/^acct_/.test(result.id || '')) throw httpError(409, 'Stripe returned an invalid account.');
      if (row.kind === 'account' && result.livemode !== live(mode)) throw httpError(409, 'Stripe account payment mode mismatch.');
      if (row.kind === 'onboard' && !validRedirect(result.url, ['connect.stripe.com'])) throw httpError(409, 'Stripe did not return a valid onboarding link.');
      if (row.kind === 'checkout' && (result.livemode !== live(mode) || !(live(mode) ? /^cs_live_/ : /^cs_test_/).test(result.id || '') || !validRedirect(result.url, ['checkout.stripe.com']))) throw httpError(409, 'Stripe did not return a matching Checkout Session.');
    }
    return { status: 200, body: await write(env, 'completeJob', { id, result }) };
  } catch (error) {
    await write(env, 'failJob', { id, retryable: Boolean(error.retryable), message: error.message });
    return { status: error.status || 503, body: { error: error.message || 'Payment operation failed. Please retry.', ...errorExtras(error) } };
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
