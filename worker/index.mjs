// RC-4 Worker entry (Cloudflare D1). Static ESM imports only: no createRequire, no
// runtime require(`${runtimeRoot}/...`), no import.meta.url and no LAMBDA_TASK_ROOT, so
// the RC-1 `define` workaround and CommonJS upload rules are no longer needed (esbuild
// bundles exactly what is imported; the nested v4 fitspace/ tree is never reached).
// Bindings are read per request from `env`; nothing is cached across requests.
//
// Routes so far: GET /health; POST /api/bookings (capacity hold, demo mode);
// GET /api/bookings/:id and POST /api/bookings/:id/pay (demo); POST /api/stripe/webhook
// (platform/Connect endpoint, all event types); POST /api/auth/forgot-password and
// /api/auth/reset-password (D1 rate limited); POST /api/admin/pts; POST /api/blocks;
// PUT /api/blocks/:id; POST /api/attendance. Every other /api/* route answers
// 501 until its phase lands; netlify/functions/platform.mjs stays the live path until cutover.
import { createDb } from '../src/db.mjs';
import { write } from '../src/writer.mjs';
import { currentUser, requireUser, checkMutation } from '../src/auth.mjs';
import { verifyWebhook } from '../src/stripe-webhook.mjs';
import { viewBooking } from '../src/scope.mjs';
import { rateLimit } from '../src/ratelimit.mjs';
import { MESSAGE as RESET_MESSAGE } from '../src/ops/password-reset.mjs';
import { httpError, isStripe } from '../src/util.mjs';

export { Writer } from '../src/writer.mjs';

export const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' } });

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

export async function handle(request, env) {
  const url = new URL(request.url);
  const route = url.pathname;
  const paymentMode = env.PAYMENT_MODE || 'demo';
  const integration = env.STRIPE_INTEGRATION || 'pt_direct';
  if (!['demo', 'stripe_test', 'stripe_live'].includes(paymentMode)) throw httpError(503, 'Use PAYMENT_MODE=demo, stripe_test or stripe_live.');
  const db = createDb(env.DB);

  if (route === '/health') return json(200, { ok: true });

  if (route === '/api/stripe/webhook' && request.method === 'POST') {
    if (integration === 'pt_direct') throw httpError(409, 'Use the PT-specific webhook endpoint.');
    if (!isStripe(paymentMode)) throw httpError(503, 'Stripe sandbox mode is not enabled.');
    const raw = await boundedText(request, 1048576);
    const event = verifyWebhook(raw, request.headers.get('stripe-signature'), [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET], paymentMode);
    return json(200, await write(env, 'handleWebhook', { event, mode: paymentMode, emailMode: env.EMAIL_MODE || 'preview' }));
  }

  const demo = env.DEMO_MODE === 'true';
  const client = request.headers.get('CF-Connecting-IP') || 'unknown';
  const PUBLIC_POSTS = ['/api/auth/login', '/api/auth/signup', '/api/auth/forgot-password', '/api/auth/reset-password'];
  const mutation = async () => {
    const user = await currentUser(db, request, { demo });
    checkMutation(request, user, { origin: url.origin, route, unauthenticatedRoutes: PUBLIC_POSTS });
    return { user, body: await jsonBody(request) };
  };
  const emailMode = env.EMAIL_MODE || 'preview';

  if (route === '/api/auth/forgot-password' && request.method === 'POST') {
    const { body } = await mutation();
    await rateLimit(db, 'forgot', client, { max: 10 });
    // Writes the reset + auth_mail_jobs row; delivery (Resend) is the phase 3 mail worker.
    await write(env, 'requestReset', { email: body.email });
    return json(200, { message: RESET_MESSAGE });
  }
  if (route === '/api/auth/reset-password' && request.method === 'POST') {
    const { body } = await mutation();
    await rateLimit(db, 'reset', client, { max: 15 });
    await write(env, 'resetPassword', { token: body.token, newPassword: body.new_password });
    const secure = url.protocol === 'https:';
    return new Response(JSON.stringify({ ok: true, message: 'Your password has been reset. Sign in with your new password.' }), {
      status: 200,
      headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': `fit_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}` }
    });
  }
  const payRoute = route.match(/^\/api\/bookings\/([^/]+)\/pay$/);
  if (payRoute && request.method === 'POST') {
    const { user, body } = await mutation();
    requireUser(user, ['customer']);
    const booking = await write(env, 'completeDemo', { bookingId: decodeURIComponent(payRoute[1]), userId: user.id, result: body.result, emailMode });
    return json(200, { booking: await viewBooking(db, user, booking.id) });
  }
  if (route === '/api/admin/pts' && request.method === 'POST') {
    const { user, body } = await mutation();
    requireUser(user, ['admin']);
    return json(201, await write(env, 'createPt', { userId: user.id, body }));
  }
  if (route === '/api/blocks' && request.method === 'POST') {
    const { user, body } = await mutation();
    requireUser(user, ['pt', 'admin']);
    return json(201, { block: await write(env, 'createBlock', { userId: user.id, body }) });
  }
  const blockRoute = route.match(/^\/api\/blocks\/([^/]+)$/);
  if (blockRoute && request.method === 'PUT') {
    const { user, body } = await mutation();
    requireUser(user, ['pt', 'admin']);
    return json(200, await write(env, 'updateBlock', { userId: user.id, blockId: decodeURIComponent(blockRoute[1]), body }));
  }
  if (route === '/api/attendance' && request.method === 'POST') {
    const { user, body } = await mutation();
    requireUser(user, ['pt', 'admin']);
    return json(200, await write(env, 'markAttendance', { userId: user.id, bookingId: body.booking_id, sessionId: body.session_id, status: body.status, emailMode }));
  }

  if (route === '/api/bookings' && request.method === 'POST') {
    const { user, body } = await mutation();
    requireUser(user, ['customer']);
    // Stripe Checkout creation (prepareCheckout + stripe_jobs) lands in phase 3; refuse
    // before taking a hold so no orphan pending bookings are created meanwhile.
    if (isStripe(paymentMode)) throw httpError(501, 'Stripe checkout is not ported to Workers yet (RC-4 phase 3).');
    const booking = await write(env, 'reserve', { userId: user.id, blockId: body.block_id, token: body.checkout_token, mode: paymentMode, integration });
    return json(201, { booking: await viewBooking(db, user, booking.id), url: (booking.status === 'paid' ? '/booking/' : '/checkout/') + booking.id });
  }

  const bookingRoute = route.match(/^\/api\/bookings\/([^/]+)$/);
  if (bookingRoute && request.method === 'GET') {
    const user = requireUser(await currentUser(db, request, { demo }));
    // app/server.cjs:55 expires stale holds first; a single guarded statement, no Writer needed.
    await db.run("UPDATE bookings SET status='expired' WHERE status='pending' AND expires_at<=?", Date.now());
    return json(200, { booking: await viewBooking(db, user, decodeURIComponent(bookingRoute[1])) });
  }

  if (route.startsWith('/api/')) return json(501, { error: 'This route is not ported to Workers yet (RC-4).' });
  return null;
}

export default {
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
      if (error.status) return json(error.status, { error: error.message });
      console.error('RC-4 request failed:', error.code || error.name || 'Error');
      return json(503, { error: 'The service could not complete this request. Please try again.' });
    }
  }
};
