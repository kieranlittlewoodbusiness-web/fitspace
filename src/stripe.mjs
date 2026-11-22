// Stripe REST client, ported from app/payments.cjs stripe() (lines 13-24). Uses the
// global fetch, so tests mock it (vi.spyOn(globalThis, 'fetch')); no test contacts Stripe.
// Called ONLY from the Worker (src/stripe-jobs.mjs, webhook endpoint), never inside the
// Writer, so a slow Stripe call (12 s timeout) never holds a Writer queue slot.
import { httpError, isStripe, live } from './util.mjs';

export const STRIPE_API = 'https://api.stripe.com';
export const keyMatches = (key, mode) => typeof key === 'string' && new RegExp('^rk_' + (mode === 'stripe_live' ? 'live' : 'test') + '_[A-Za-z0-9_]{8,240}$').test(key);

/** Platform key check (app/stripe-mode.cjs validate()). */
export function validatePlatformKey(env, mode) {
  const key = env.STRIPE_SECRET_KEY || '';
  if (mode === 'demo') { if (/^(sk|rk)_live_/.test(key)) throw httpError(503, 'A live key cannot be used in demo mode.'); return; }
  if (!new RegExp('^(sk|rk)_' + (live(mode) ? 'live' : 'test') + '_').test(key)) throw httpError(503, 'The Stripe secret key does not match the selected payment mode.');
}

/** RC-32: secrets and PII never reach the logs. acct_ ids keep their first 4 characters, emails
 *  and Stripe keys/secrets are replaced. */
export function redactStripeText(value) {
  return String(value ?? '')
    .replace(/\b((?:sk|rk|pk)_(?:live|test)_|whsec_)[A-Za-z0-9_]+/g, '$1[redacted]')
    .replace(/\b((?:pi|seti|cs|src)_)[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, '$1[redacted]_secret_[redacted]')
    .replace(/\bacct_([A-Za-z0-9]{0,4})[A-Za-z0-9]*/g, 'acct_$1…')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .slice(0, 300);
}

/** Fields logged for a failed Stripe call: status, type, code, redacted message, request id. */
export function stripeErrorLog(response, result, path = '') {
  const error = (result && typeof result === 'object' && result.error) || {};
  const headers = response?.headers;
  const header = name => (headers && typeof headers.get === 'function' ? headers.get(name) : null);
  return {
    status: response?.status ?? null,
    path: redactStripeText(String(path).split('?')[0]),
    type: error.type ? redactStripeText(error.type) : null,
    code: error.code ? redactStripeText(error.code) : null,
    message: error.message ? redactStripeText(error.message) : null,
    request_id: redactStripeText(header('request-id') || header('stripe-request-id') || '') || null
  };
}

/** RC-32: the platform itself (not the PT) has not finished Stripe Connect setup. The PT sees a
 *  fixed message; Stripe's own text is never shown (it can contain account details). */
export const PLATFORM_NOT_READY = "Stripe Connect isn't set up on the platform yet. Ask the site owner to finish Stripe setup.";
const PLATFORM_SETUP_TEXT = /signed up for Connect|platform[- ]profile|managing losses|responsibilities of managing|activate your (?:Stripe )?account|account (?:is not|isn't) activated|Connect (?:is not|isn't) (?:enabled|activated|set up)/i;
export function platformNotReady(status, result, path = '') {
  // Scoped to account creation: a checkout/refund 400 with similar wording keeps the generic text.
  if (status !== 400 || String(path).split('?')[0] !== '/v2/core/accounts') return false;
  const error = (result && typeof result === 'object' && result.error) || {};
  return error.type === 'invalid_request_error' && PLATFORM_SETUP_TEXT.test(String(error.message || ''));
}

export async function stripe(env, path, data, { account, idempotency, method = 'POST', v2 = false, key: ownKey, mode, integration = 'connect' } = {}) {
  if (!isStripe(mode)) throw httpError(503, 'Select sandbox or live Stripe mode.');
  let key;
  if (ownKey) {
    if (!keyMatches(ownKey, mode)) throw httpError(503, 'Stored Stripe key does not match the payment mode.', { retryable: true });
    if (account) throw httpError(403, 'PT-owned credentials cannot route to another account.');
    key = ownKey;
  } else {
    if (integration === 'pt_direct') throw httpError(503, 'This PT must configure their own Stripe account.');
    // Owner configuration errors are retryable: the job is kept ('retry') and the hold is not
    // failed, so the same Idempotency-Key is reused once the owner fixes the key.
    try { validatePlatformKey(env, mode); } catch (error) { throw Object.assign(error, { retryable: true }); }
    key = env.STRIPE_SECRET_KEY;
  }
  const headers = { Authorization: `Bearer ${key}`, 'Stripe-Version': env.STRIPE_API_VERSION || '2026-09-30.endive' };
  if (account) headers['Stripe-Account'] = account;
  if (idempotency) headers['Idempotency-Key'] = idempotency;
  let body;
  if (method !== 'GET') {
    headers['Content-Type'] = v2 ? 'application/json' : 'application/x-www-form-urlencoded';
    body = v2 ? JSON.stringify(data) : new URLSearchParams(data).toString();
  }
  let response, result;
  try {
    response = await fetch(STRIPE_API + path, { method, headers, body, signal: AbortSignal.timeout(12000) });
    result = await response.json();
  } catch {
    throw httpError(503, 'Stripe did not respond. Retry this action; its payment-operation key is preserved.', { retryable: true });
  }
  if (!response.ok) {
    console.error('Stripe API error', JSON.stringify(stripeErrorLog(response, result, path)));
    const retryable = response.status >= 500 || [409, 429].includes(response.status);
    if (platformNotReady(response.status, result, path)) throw httpError(409, PLATFORM_NOT_READY, { code: 'STRIPE_PLATFORM_NOT_READY', retryable: false });
    throw httpError(retryable ? 503 : 409, 'Stripe could not complete this action. ' + (response.status === 401 ? 'Check this account’s key.' : response.status === 403 ? 'Check this key’s permissions.' : 'Check the Stripe account setup and retry.'), { retryable });
  }
  if (typeof result.livemode === 'boolean' && result.livemode !== live(mode)) throw httpError(403, 'Stripe response payment mode mismatch.', { stripeSucceeded: true });
  return result;
}
