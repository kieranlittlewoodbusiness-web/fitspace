// RC-4 Worker entry (Cloudflare D1). Static ESM imports only: no createRequire, no
// runtime require(`${runtimeRoot}/...`), no import.meta.url and no LAMBDA_TASK_ROOT.
// Bindings are read per request from `env`; nothing is cached across requests.
//
// Phase 3: every app/server.cjs route is ported. This file holds NO SQL: reads go through
// scopeFor()/src/views.mjs/src/public.mjs, multi-step writes through write() (Writer DO),
// Stripe calls through src/stripe-jobs.mjs (outside the Writer). scheduled() is the Cron
// Trigger for email delivery and housekeeping. netlify/functions/platform.mjs stays the
// live path until cutover.
import crypto from 'node:crypto';
import { createDb, withoutDb } from '../src/db.mjs';
import { write } from '../src/writer.mjs';
import { currentUser, requireUser, checkMutation } from '../src/auth.mjs';
import { verifyWebhook } from '../src/stripe-webhook.mjs';
import { viewBooking, scopeFor } from '../src/scope.mjs';
import { paymentOperation } from '../src/stripe-jobs.mjs';
import { stripe, validatePlatformKey } from '../src/stripe.mjs';
import { credentialStatus, open as openCredential, loadCredential, encryptionConfigured } from '../src/pt-credentials.mjs';
import { dashboard } from '../src/views.mjs';
import { login, signup, logout, safeUser, sessionCookie, clearCookie } from '../src/sessions.mjs';
import { defaultSlug, publishedPts, publishedPtPage, expireHolds, adminSetupStatus, credentialById, markWebhookSeen } from '../src/public.mjs';
import { configured as resetConfigured, MESSAGE as RESET_MESSAGE } from '../src/ops/password-reset.mjs';
import { runScheduled } from '../src/mail.mjs';
import { stripeConnection } from '../src/ops/bookings.mjs';
import { password as validPassword } from '../src/validate.mjs';
import { rateLimit } from '../src/ratelimit.mjs';
import { errorExtras, hashPassword, httpError, isStripe, live, verifyPassword } from '../src/util.mjs';

export { Writer } from '../src/writer.mjs';

export const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};
const json = (status, data, extraHeaders = {}) => new Response(JSON.stringify(data), { status, headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders } });

async function boundedText(request, max) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > max) throw httpError(413, 'Request too large.');
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > max) throw httpError(413, 'Request too large.');
  return new TextDecoder().decode(buffer);
}
async function jsonBody(request) {
  const raw = await boundedText(request, 65536);
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { throw httpError(400, 'Invalid request data.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Invalid request.');
  return body;
}

/** A path or body id: a non-empty string; malformed %-escapes and non-strings are 400s. */
function idParam(value, label = 'id', { encoded = false } = {}) {
  let id = value;
  if (encoded) { try { id = decodeURIComponent(value); } catch { throw httpError(400, `Invalid ${label}.`); } }
  if (typeof id !== 'string' || !id || id.length > 200) throw httpError(400, `Invalid ${label}.`);
  return id;
}

export async function handle(request, env) {
  // CR 5941600057 M4 (structural): the wrapper is the only D1 handle; everything below sees an
  // env without the raw binding.
  const db = createDb(env.DB);
  env = withoutDb(env);
  const url = new URL(request.url);
  const route = url.pathname;
  const method = request.method;
  const paymentMode = env.PAYMENT_MODE || 'demo';
  // Same default and validation as app/pt-stripe.cjs; wrangler.jsonc sets 'connect' explicitly.
  const integration = env.STRIPE_INTEGRATION || 'pt_direct';
  if (!['pt_direct', 'connect'].includes(integration)) throw httpError(503, 'Set STRIPE_INTEGRATION=pt_direct or connect.');
  if (!['demo', 'stripe_test', 'stripe_live'].includes(paymentMode)) throw httpError(503, 'Use PAYMENT_MODE=demo, stripe_test or stripe_live.');
  // netlify/functions/platform.mjs:47: with the owner (Connect) integration a configured key that
  // does not match the payment mode fails closed for every API route except sign-in, before any write.
  if (integration !== 'pt_direct' && env.STRIPE_SECRET_KEY && route.startsWith('/api/') && !route.startsWith('/api/auth/')) validatePlatformKey(env, paymentMode);
  // CR 5941600057 M6: netlify/functions/platform.mjs:48-49. Every non-diagnostic API route in
  // Stripe mode needs a matching key (or, pt_direct, the credential encryption key), the
  // platform webhook secret and an https APP_URL, checked before rate limits, Stripe calls or
  // any write (so no stripe_jobs row is created on a misconfigured deploy).
  if (route.startsWith('/api/')) paymentReadiness(env, route, paymentMode, integration);
  const stripeOpts = { mode: paymentMode, integration };
  const paymentOrigin = env.APP_URL ? new URL(env.APP_URL).origin : url.origin;
  const secure = url.protocol === 'https:';
  const emailMode = env.EMAIL_MODE || 'preview';
  const requireStripeMode = () => { if (!isStripe(paymentMode)) throw httpError(409, 'Stripe sandbox mode is not enabled.'); };
  const operation = async jobId => { const o = await paymentOperation(env, db, jobId, stripeOpts); return json(o.status, o.body); };

  if (route === '/health') return json(200, { ok: true });

  // ---- Stripe webhooks (signature first, before any write) ----
  if (route === '/api/stripe/webhook' && method === 'POST') {
    if (integration === 'pt_direct') throw httpError(409, 'Use the PT-specific webhook endpoint.');
    if (!isStripe(paymentMode)) throw httpError(503, 'Stripe sandbox mode is not enabled.');
    const raw = await boundedText(request, 1048576);
    const event = verifyWebhook(raw, request.headers.get('stripe-signature'), [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET], paymentMode);
    return json(200, await write(env, 'handleWebhook', { event, mode: paymentMode, emailMode }));
  }
  // Legacy pt_direct per-PT endpoint (app/server.cjs:32): the PT's own webhook secret, then
  // the event is re-fetched from Stripe with the PT's key (authoritative copy) before applying.
  const ptWebhook = route.match(/^\/api\/stripe\/pt\/([a-f0-9-]{36})\/webhook$/);
  if (ptWebhook && method === 'POST') {
    const c = await credentialById(db, ptWebhook[1]);
    if (!c || !c.webhook_cipher) throw httpError(c ? 503 : 404, c ? 'Webhook setup is incomplete.' : 'Webhook endpoint not found.');
    const raw = await boundedText(request, 1048576);
    const event = verifyWebhook(raw, request.headers.get('stripe-signature'), openCredential(env, c.webhook_cipher, c, 'webhook'), c.mode);
    if (event.account) throw httpError(400, 'Use Your account events for this PT.');
    const { key } = await loadCredential(db, env, c.id);
    const authoritative = await stripe(env, '/v1/events/' + encodeURIComponent(event.id), null, { key, mode: c.mode, method: 'GET', integration });
    if (authoritative.id !== event.id || authoritative.type !== event.type || authoritative.data?.object?.id !== event.data?.object?.id) throw httpError(400, 'Webhook event does not belong to this account.');
    const outcome = await write(env, 'handleWebhook', { event: authoritative, credentialId: c.id, mode: c.mode, emailMode });
    await markWebhookSeen(db, c.id);
    return json(200, outcome);
  }

  const demo = env.DEMO_MODE === 'true';
  const client = request.headers.get('CF-Connecting-IP') || 'unknown';
  const PUBLIC_POSTS = ['/api/auth/login', '/api/auth/signup', '/api/auth/forgot-password', '/api/auth/reset-password'];
  const user = route.startsWith('/api/') ? await currentUser(db, request, { demo }) : null;
  let body = {};
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && route.startsWith('/api/')) {
    checkMutation(request, user, { origin: url.origin, route, unauthenticatedRoutes: PUBLIC_POSTS });
    body = await jsonBody(request);
  }

  // ---- account ----
  if (method === 'GET' && route === '/api/me') return json(200, { user: safeUser(user), csrf: user?.csrf || null, demo, payment_mode: paymentMode, stripe_integration: integration, password_reset_available: resetConfigured(env), email_mode: emailMode, default_slug: await defaultSlug(db) });
  if (method === 'POST' && route === '/api/auth/login') {
    await rateLimit(db, 'login', client, { max: 15 });
    const r = await login(db, request, body, { demo });
    return json(200, { user: r.user, csrf: r.csrf }, { 'Set-Cookie': sessionCookie(r.token, secure) });
  }
  if (method === 'POST' && route === '/api/auth/signup') {
    await rateLimit(db, 'signup', client, { max: 10 });
    const r = await signup(db, body);
    return json(201, { user: r.user, csrf: r.csrf }, { 'Set-Cookie': sessionCookie(r.token, secure) });
  }
  if (method === 'POST' && route === '/api/auth/logout') {
    requireUser(user);
    await logout(db, request);
    return json(200, { ok: true }, { 'Set-Cookie': clearCookie(secure) });
  }
  if (method === 'POST' && route === '/api/auth/password') {
    requireUser(user);
    if (!verifyPassword(String(body.current_password || ''), user.password_hash)) throw httpError(400, 'Current password is incorrect.');
    const newHash = hashPassword(validPassword(body.new_password));
    const s = await write(env, 'changePassword', { userId: user.id, expectedHash: user.password_hash, newHash });
    return json(200, { ok: true, csrf: s.csrf }, { 'Set-Cookie': sessionCookie(s.token, secure) });
  }
  if (method === 'POST' && route === '/api/auth/forgot-password') {
    await rateLimit(db, 'forgot', client, { max: 10 });
    // Writes the reset + auth_mail_jobs row; the Cron Trigger delivers it within a minute.
    // Reset off (password_reset_available=false): same generic answer, nothing written or sent
    // (legacy password-reset #6; the Writer would otherwise read its own deployment env).
    if (resetConfigured(env)) await write(env, 'requestReset', { email: body.email });
    return json(200, { message: RESET_MESSAGE });
  }
  if (method === 'POST' && route === '/api/auth/reset-password') {
    await rateLimit(db, 'reset', client, { max: 15 });
    await write(env, 'resetPassword', { token: body.token, newPassword: body.new_password });
    return json(200, { ok: true, message: 'Your password has been reset. Sign in with your new password.' }, { 'Set-Cookie': clearCookie(secure) });
  }

  // ---- public ----
  if (method === 'GET' && route === '/api/public/pts') return json(200, { pts: await publishedPts(db) });
  const ptPublic = route.match(/^\/api\/public\/pts\/([a-z0-9-]+)$/);
  if (method === 'GET' && ptPublic) return json(200, await publishedPtPage(db, ptPublic[1]));

  // ---- dashboard (scoped per role) ----
  if (method === 'GET' && route === '/api/dashboard') {
    requireUser(user);
    await expireHolds(db);
    return json(200, await dashboard(db, user, { paymentMode, integration }));
  }

  // ---- admin ----
  if (method === 'GET' && route === '/api/admin/stripe/setup') {
    requireUser(user, ['admin']);
    let keyReady = true;
    try { validatePlatformKey(env, paymentMode); } catch { keyReady = false; }
    return json(200, await adminSetupStatus(db, env, { paymentMode, integration, keyReady }));
  }
  if (method === 'POST' && route === '/api/admin/stripe/check') {
    requireUser(user, ['admin']);
    const a = await stripe(env, '/v1/account', null, { ...stripeOpts, method: 'GET' });
    if (!/^acct_/.test(a.id || '')) throw httpError(409, 'Stripe returned an invalid account.');
    return json(200, { id: a.id, name: a.business_profile?.name || a.settings?.dashboard?.display_name || null, email: a.email || null, charges_enabled: Boolean(a.charges_enabled), payouts_enabled: Boolean(a.payouts_enabled), details_submitted: Boolean(a.details_submitted), mode: paymentMode });
  }
  if (method === 'POST' && route === '/api/admin/stripe/link') {
    requireUser(user, ['admin']);
    return operation(await write(env, 'prepareLink', { userId: user.id, ptId: body.pt_id, mode: paymentMode, integration }));
  }
  if (method === 'POST' && route === '/api/admin/pts') {
    requireUser(user, ['admin']);
    return json(201, await createPtRoute(env, user, body));
  }
  const adminPt = route.match(/^\/api\/admin\/pts\/([^/]+)$/);
  if (method === 'PUT' && adminPt) {
    requireUser(user, ['admin']);
    return json(200, await write(env, 'updatePtBranding', { userId: user.id, ptId: idParam(adminPt[1], 'trainer', { encoded: true }), body }));
  }

  // ---- classes and attendance ----
  if (method === 'POST' && route === '/api/blocks') {
    requireUser(user, ['pt', 'admin']);
    return json(201, await write(env, 'createBlock', { userId: user.id, body }));
  }
  const blockRoute = route.match(/^\/api\/blocks\/([^/]+)$/);
  if (method === 'PUT' && blockRoute) {
    requireUser(user, ['pt', 'admin']);
    return json(200, await write(env, 'updateBlock', { userId: user.id, blockId: idParam(blockRoute[1], 'class', { encoded: true }), body }));
  }
  if (method === 'POST' && route === '/api/attendance') {
    requireUser(user, ['pt', 'admin']);
    return json(200, await write(env, 'markAttendance', { userId: user.id, bookingId: idParam(body.booking_id, 'booking'), sessionId: idParam(body.session_id, 'session'), status: body.status, emailMode }));
  }

  // ---- bookings ----
  if (method === 'POST' && route === '/api/bookings') {
    requireUser(user, ['customer']);
    const booking = await write(env, 'reserve', { userId: user.id, blockId: idParam(body.block_id, 'class'), token: body.checkout_token, mode: paymentMode, integration });
    if (isStripe(paymentMode) && booking.status === 'pending') return operation(await write(env, 'prepareCheckout', { bookingId: booking.id, userId: user.id, origin: paymentOrigin, mode: paymentMode, integration }));
    return json(201, { booking: await viewBooking(db, user, booking.id), url: (booking.status === 'paid' ? '/booking/' : '/checkout/') + booking.id });
  }
  const sub = route.match(/^\/api\/bookings\/([^/]+)\/(checkout|refund|pay|cancel)$/);
  if (method === 'POST' && sub) {
    const bookingId = idParam(sub[1], 'booking', { encoded: true });
    if (sub[2] === 'pay') {
      requireUser(user, ['customer']);
      const booking = await write(env, 'completeDemo', { bookingId, userId: user.id, result: body.result, emailMode });
      return json(200, { booking: await viewBooking(db, user, booking.id) });
    }
    if (sub[2] === 'checkout') {
      requireUser(user, ['customer']);
      requireStripeMode();
      return operation(await write(env, 'prepareCheckout', { bookingId, userId: user.id, origin: paymentOrigin, mode: paymentMode, integration }));
    }
    if (sub[2] === 'refund') {
      requireUser(user, ['pt', 'admin']);
      requireStripeMode();
      return operation(await write(env, 'prepareRefund', { bookingId, userId: user.id, token: body.request_token, mode: paymentMode }));
    }
    // cancel: owner customer, owning PT or admin (scopeFor inside the ops)
    requireUser(user);
    const booking = await viewBooking(db, user, bookingId);
    if (isStripe(booking.mode)) {
      if (booking.status !== 'pending') throw httpError(409, 'Contact the trainer to refund a completed payment.');
      if (!isStripe(paymentMode)) throw httpError(409, 'Enable Stripe sandbox mode to cancel this checkout.');
      return operation(await write(env, 'prepareCancel', { bookingId, userId: user.id, mode: paymentMode }));
    }
    return json(200, await write(env, 'cancelDemoBooking', { userId: user.id, bookingId }));
  }
  const bookingRoute = route.match(/^\/api\/bookings\/([^/]+)$/);
  if (method === 'GET' && bookingRoute) {
    requireUser(user);
    await expireHolds(db);
    return json(200, { booking: await viewBooking(db, user, idParam(bookingRoute[1], 'booking', { encoded: true })) });
  }

  // ---- PT payments setup (caller's own pt_id only) ----
  if (method === 'GET' && route === '/api/pt/stripe/setup') {
    requireUser(user, ['pt']);
    return json(200, await credentialStatus(db, env, scopeFor(db, user).ptId, integration));
  }
  const ptStripeWrite = route.match(/^\/api\/pt\/stripe\/(credentials|check|enable|disconnect)$/);
  if (method === 'POST' && ptStripeWrite) {
    requireUser(user, ['pt']);
    // Legacy pt_direct WRITE paths are retired on Workers (read path only); Kieran chose Connect.
    throw httpError(410, 'PT-owned Stripe keys can no longer be changed here. Use Stripe Connect, or ask the owner.', { code: 'PT_DIRECT_WRITES_RETIRED' });
  }
  if (method === 'POST' && route === '/api/pt/stripe/connect') {
    requireUser(user, ['pt']);
    if (!isStripe(paymentMode)) throw httpError(503, 'Stripe sandbox mode is not enabled.');
    return operation(await write(env, 'prepareConnect', { userId: user.id, origin: paymentOrigin, mode: paymentMode, integration }));
  }
  if (method === 'POST' && route === '/api/pt/stripe/status') {
    requireUser(user, ['pt']);
    if (!isStripe(paymentMode)) throw httpError(503, 'Stripe sandbox mode is not enabled.');
    const ptId = scopeFor(db, user).ptId;
    if (integration === 'pt_direct') return json(200, await credentialStatus(db, env, ptId, integration));
    const c = await stripeConnection(db, ptId, paymentMode, integration);
    if (!c) return json(200, { ready: false });
    let ready;
    if (c.routing === 'platform') {
      const a = await stripe(env, '/v1/account', null, { ...stripeOpts, method: 'GET' });
      if (a.id !== c.account_id) throw httpError(409, 'The server key belongs to a different Stripe account.');
      ready = Boolean(a.charges_enabled);
    } else {
      const a = await stripe(env, '/v2/core/accounts/' + encodeURIComponent(c.account_id) + '?include[]=configuration.merchant', null, { ...stripeOpts, method: 'GET', v2: true });
      if (a.id !== c.account_id || a.livemode !== live(paymentMode)) throw httpError(409, 'Unexpected Stripe account or payment mode.');
      ready = a.configuration?.merchant?.capabilities?.card_payments?.status === 'active';
    }
    return json(200, await write(env, 'bindConnection', { userId: user.id, mode: paymentMode, accountId: c.account_id, routing: c.routing, ready }));
  }

  if (route.startsWith('/api/')) return json(404, { error: 'This action is not available.' });
  return null;
}

const DIAGNOSTIC = /^\/api\/(me|auth\/.*|dashboard|admin\/.*|public\/.*)$/;
const PT_WEBHOOK = /^\/api\/stripe\/pt\/[a-f0-9-]{36}\/webhook$/;
/** Legacy platform.mjs:47-49 (`diagnostic` routes stay reachable so the owner can see and fix
 *  the configuration). Throws 503 before anything else runs. */
export function paymentReadiness(env, route, paymentMode, integration) {
  if (PT_WEBHOOK.test(route) || route.startsWith('/api/pt/stripe/') || DIAGNOSTIC.test(route)) return;
  if (integration === 'pt_direct') {
    if (isStripe(paymentMode) && !encryptionConfigured(env)) throw httpError(503, 'The owner must configure CREDENTIAL_ENCRYPTION_KEY as 64 random hexadecimal characters.');
  } else validatePlatformKey(env, paymentMode);
  if (paymentMode !== 'demo' && ((integration !== 'pt_direct' && !env.STRIPE_WEBHOOK_SECRET) || !/^https:\/\/[^/]+(?:\/)?$/.test(env.APP_URL || ''))) {
    throw httpError(503, 'Set STRIPE_WEBHOOK_SECRET and an HTTPS APP_URL before accepting Stripe payments.');
  }
}

/** POST /api/admin/pts: retry-safe via body.create_key; the temporary password is derived
 *  from the key (HMAC, server secret) so a retry after a lost response returns the same one
 *  while it is still unused. scrypt runs here, not in the Writer. */
async function createPtRoute(env, user, body) {
  const temporary = temporaryPassword(env, body.create_key);
  return write(env, 'createPt', { userId: user.id, body, temporaryHash: hashPassword(temporary), temporary });
}
function temporaryPassword(env, key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{12,80}$/.test(key)) throw httpError(400, 'Refresh the page and try again.', { code: 'CREATE_KEY_REQUIRED' });
  const secret = env.PT_INVITE_SECRET || '';
  if (secret.length < 32) throw httpError(503, 'The owner must set PT_INVITE_SECRET (32+ random characters) before creating trainers.');
  return crypto.createHmac('sha256', secret).update('fitspace-pt-temporary:' + key).digest('base64url').slice(0, 16) + '!';
}

/** CR 5941600057: the Cron Trigger is OFF unless CRON_ENABLED is exactly "true". Only
 *  env.preview sets it; production sets it at the approved go-live step. So an accidental
 *  deploy of the default env (bound to the real D1 database) runs nothing on a schedule. */
export async function cronTick(env) {
  if (env.CRON_ENABLED !== 'true') return { skipped: 'CRON_ENABLED is not "true"' };
  return runScheduled(withoutDb(env), createDb(env.DB));
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(cronTick(env).then(r => console.log('RC-4 cron:', JSON.stringify(r)), e => console.error('RC-4 cron failed:', e.code || e.name || 'Error')));
  },
  async fetch(request, env) {
    try {
      const response = await handle(request, env);
      if (response) return response;
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed.', { status: 405, headers: securityHeaders });
      const asset = await env.ASSETS.fetch(request);
      const out = new Response(asset.body, asset);
      for (const [name, value] of Object.entries(securityHeaders)) out.headers.set(name, value);
      return out;
    } catch (error) {
      if (error.status) return json(error.status, { error: error.message, ...errorExtras(error) });
      console.error('RC-4 request failed:', error.code || error.name || 'Error');
      return json(503, { error: 'The service could not complete this request. Please try again.' });
    }
  }
};
