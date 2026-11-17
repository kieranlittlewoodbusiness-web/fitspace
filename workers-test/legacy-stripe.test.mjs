// Port of the tests/stripe-netlify.test.mjs behaviours not already covered by the phase 1-3
// Workers tests (mapping table: docs §11). Stripe is mocked (vi.spyOn fetch); no network.
// Keys are dummies generated per run; nothing reaches Stripe.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import nodeCrypto from 'node:crypto';
import worker from '../worker/index.mjs';
import { db, seedBlock, seedUser, jsonRequest, getRequest, signedWebhook, insertBooking } from './helpers.mjs';

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const stripeEnv = (over = {}) => Object.assign(Object.create(null), env, { PAYMENT_MODE: 'stripe_test', STRIPE_INTEGRATION: 'connect' }, over);
const liveKey = 'sk_live_' + nodeCrypto.randomBytes(12).toString('hex'); // dummy; fetch is mocked
afterEach(() => vi.restoreAllMocks());

function mockStripe() {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== 'https://api.stripe.com') throw new Error('unexpected host ' + url.origin);
    const h = new Headers(init.headers);
    calls.push({ path: url.pathname, account: h.get('Stripe-Account'), auth: h.get('Authorization'), body: new URLSearchParams(init.body || '') });
    if (url.pathname === '/v1/checkout/sessions') { const live = h.get('Authorization').includes('_live_'); return json(200, { id: (live ? 'cs_live_' : 'cs_test_') + nodeCrypto.randomBytes(6).toString('hex'), url: 'https://checkout.stripe.com/c/pay/x', livemode: live }); }
    return json(404, { error: { message: 'no mock' } });
  });
  return calls;
}
async function pt(routing = 'connected', mode = 'stripe_test') {
  const s = await seedBlock({ customers: 3, capacity: 2 });
  const account = routing === 'platform' ? 'acct_platform_' + nodeCrypto.randomBytes(4).toString('hex') : 'acct_' + nodeCrypto.randomBytes(6).toString('hex');
  await db().run('INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready) VALUES(?,?,?,?,1)', s.ptId, mode, account, routing);
  await db().run('UPDATE blocks SET published=1 WHERE id=?', s.blockId);
  await db().run('UPDATE pts SET published=1 WHERE id=?', s.ptId);
  return { ...s, account };
}
async function checkout(s, user, e = stripeEnv(), extra = {}) {
  const r = await worker.fetch(jsonRequest(user, 'POST', '/api/bookings', { block_id: s.blockId, checkout_token: crypto.randomUUID(), ...extra }), e);
  return { status: r.status, body: await r.json() };
}
const available = async s => (await (await worker.fetch(new Request('http://example.test/api/public/pts/' + s.ptId), stripeEnv())).json()).blocks.find(b => b.id === s.blockId).available;
const sessionEvent = (s, bookingId, cs, type, over = {}, account = s.account, live = false) => ({ id: 'evt_' + nodeCrypto.randomBytes(8).toString('hex'), type, livemode: live, ...(account ? { account } : {}), data: { object: { id: cs, object: 'checkout.session', mode: 'payment', livemode: live, amount_total: 1500, currency: 'gbp', payment_status: 'paid', payment_intent: 'pi_' + nodeCrypto.randomBytes(6).toString('hex'), metadata: { booking_id: bookingId, pt_id: s.ptId }, ...over } } });
const deliver = (event, e = stripeEnv(), secret) => worker.fetch(signedWebhook(event, secret)(), e);

describe('ported tests/stripe-netlify.test.mjs (gaps)', () => {
  it('checkout uses the server price and stays pending until a valid, matching, signed success', async () => {
    const s = await pt();
    const calls = mockStripe();
    const c = await checkout(s, s.users[0], stripeEnv(), { amount_pence: 1, price_pence: 1 });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(calls[0].body.get('line_items[0][price_data][unit_amount]')).toBe('1500');
    expect(calls[0].account).toBe(s.account);
    const row = await db().get('SELECT status,amount_pence,checkout_session FROM bookings WHERE id=?', c.body.booking_id);
    expect(row).toMatchObject({ status: 'pending', amount_pence: 1500 });
    const unsigned = await worker.fetch(new Request('http://example.test/api/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sessionEvent(s, c.body.booking_id, row.checkout_session, 'checkout.session.completed')) }), stripeEnv());
    expect(unsigned.status).toBe(400);
    expect((await deliver(sessionEvent(s, c.body.booking_id, row.checkout_session, 'checkout.session.completed', { amount_total: 1 }))).status).toBe(400);
    expect((await deliver(sessionEvent(s, c.body.booking_id, row.checkout_session, 'checkout.session.completed', {}, 'acct_someone_else'))).status).toBe(400);
    expect((await deliver(sessionEvent(s, c.body.booking_id, row.checkout_session, 'checkout.session.completed', { payment_status: 'unpaid' }))).status).toBe(200);
    expect((await db().get('SELECT status FROM bookings WHERE id=?', c.body.booking_id)).status).toBe('pending');
    expect((await deliver(sessionEvent(s, c.body.booking_id, row.checkout_session, 'checkout.session.completed'))).status).toBe(200);
    expect((await db().get('SELECT status FROM bookings WHERE id=?', c.body.booking_id)).status).toBe('paid');
  });

  it('expired and terminally failed checkouts release capacity; a retryable card decline neither confirms nor releases', async () => {
    const s = await pt();
    mockStripe();
    const a = await checkout(s, s.users[0]), b = await checkout(s, s.users[1]);
    expect(await available(s)).toBe(0);
    const csA = (await db().get('SELECT checkout_session FROM bookings WHERE id=?', a.body.booking_id)).checkout_session;
    const csB = (await db().get('SELECT checkout_session FROM bookings WHERE id=?', b.body.booking_id)).checkout_session;
    // payment_intent.payment_failed (card declined, retryable in Checkout): still pending, place kept.
    const declined = { id: 'evt_' + nodeCrypto.randomBytes(8).toString('hex'), type: 'payment_intent.payment_failed', livemode: false, account: s.account, data: { object: { id: 'pi_' + nodeCrypto.randomBytes(6).toString('hex'), amount: 1500, currency: 'gbp', livemode: false, metadata: { booking_id: a.body.booking_id } } } };
    expect((await deliver(declined)).status).toBe(200);
    expect(await db().get('SELECT status,paid_at FROM bookings WHERE id=?', a.body.booking_id)).toEqual({ status: 'pending', paid_at: null });
    // CR 5941600057: stripe-netlify #4 asserts the decline is recorded for the customer.
    expect((await db().get('SELECT payment_error FROM bookings WHERE id=?', a.body.booking_id)).payment_error).toMatch(/card payment failed/i);
    expect(await available(s)).toBe(0);
    expect((await deliver(sessionEvent(s, a.body.booking_id, csA, 'checkout.session.expired', { payment_status: 'unpaid' }))).status).toBe(200);
    expect((await db().get('SELECT status FROM bookings WHERE id=?', a.body.booking_id)).status).toBe('expired');
    expect(await available(s)).toBe(1);
    expect((await deliver(sessionEvent(s, b.body.booking_id, csB, 'checkout.session.async_payment_failed', { payment_status: 'unpaid' }))).status).toBe(200);
    expect((await db().get('SELECT status FROM bookings WHERE id=?', b.body.booking_id)).status).toBe('failed');
    expect(await available(s)).toBe(2);
  });

  it('refunds: pending and failed refunds keep the place; success releases it and lowers net revenue', async () => {
    const s = await pt();
    const owner = await seedUser({ role: 'pt', ptId: s.ptId });
    const pi = 'pi_' + nodeCrypto.randomBytes(6).toString('hex');
    const bk = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'paid', mode: 'stripe_test', extra: { stripe_account_id: s.account, stripe_routing: 'connected', payment_intent: pi, paid_at: Date.now() } });
    const revenue = async () => (await (await worker.fetch(getRequest(owner, '/api/dashboard'), stripeEnv())).json()).stats.revenue_pence;
    expect(await revenue()).toBe(1500);
    expect(await available(s)).toBe(1);
    const refund = (status, created, id = 're_' + nodeCrypto.randomBytes(5).toString('hex')) => ({ id: 'evt_' + nodeCrypto.randomBytes(8).toString('hex'), type: status === 'failed' ? 'refund.failed' : 'refund.updated', created, livemode: false, account: s.account, data: { object: { id, status, amount: 1500, currency: 'gbp', payment_intent: pi } } });
    const pending = refund('pending', 1);
    expect((await deliver(pending)).status).toBe(200);
    expect(await db().get('SELECT status,refund_status FROM bookings WHERE id=?', bk)).toEqual({ status: 'paid', refund_status: 'pending' });
    expect(await available(s)).toBe(1);
    expect((await deliver(refund('failed', 2, pending.data.object.id))).status).toBe(200);
    expect(await db().get('SELECT status,refund_status FROM bookings WHERE id=?', bk)).toEqual({ status: 'paid', refund_status: 'failed' });
    expect(await available(s)).toBe(1);
    expect((await deliver(refund('succeeded', 3))).status).toBe(200);
    expect(await db().get('SELECT status,refund_status,refunded_pence FROM bookings WHERE id=?', bk)).toEqual({ status: 'cancelled', refund_status: 'succeeded', refunded_pence: 1500 });
    expect(await available(s)).toBe(2);
    expect(await revenue()).toBe(0);
  });

  // CR 5941600057 M6: platform.mjs:48-49 readiness, before any Stripe call or write.
  it('Stripe mode without a webhook secret, with an http APP_URL, or without/with an empty key: 503 before Stripe and before any row', async () => {
    const s = await pt();
    const admin = await seedUser({ role: 'admin' });
    const calls = mockStripe();
    const cases = {
      no_webhook_secret: stripeEnv({ STRIPE_WEBHOOK_SECRET: undefined }),
      empty_webhook_secret: stripeEnv({ STRIPE_WEBHOOK_SECRET: '' }),
      http_app_url: stripeEnv({ APP_URL: 'http://example.test' }),
      app_url_with_path: stripeEnv({ APP_URL: 'https://example.test/app' }),
      no_app_url: stripeEnv({ APP_URL: undefined }),
      no_key: stripeEnv({ STRIPE_SECRET_KEY: undefined }),
      empty_key: stripeEnv({ STRIPE_SECRET_KEY: '' })
    };
    for (const [name, e] of Object.entries(cases)) {
      const r = await checkout(s, s.users[0], e);
      expect(r.status, name).toBe(503);
      expect(JSON.stringify(r.body), name).not.toMatch(/sk_|whsec_/);
      // diagnostic routes stay reachable so the owner can see what is missing
      expect((await worker.fetch(getRequest(admin, '/api/me'), e)).status, name).toBe(200);
      expect((await worker.fetch(getRequest(admin, '/api/dashboard'), e)).status, name).toBe(200);
    }
    expect(calls).toHaveLength(0);
    expect(await db().get('SELECT count(*) n FROM bookings WHERE block_id=?', s.blockId)).toEqual({ n: 0 });
    expect(await db().get('SELECT count(*) n FROM stripe_jobs j JOIN bookings b ON b.id=j.target_id WHERE b.block_id=?', s.blockId)).toEqual({ n: 0 });
    // the PT webhook route is diagnostic; the platform webhook is not
    expect((await worker.fetch(new Request('http://example.test/api/stripe/webhook', { method: 'POST', body: '{}' }), cases.no_webhook_secret)).status).toBe(503);
    // control: the same checkout with a ready configuration reaches Stripe
    expect((await checkout(s, s.users[1])).status).toBe(200);
    expect(calls).toHaveLength(1);
    // pt_direct in Stripe mode needs the credential encryption key instead of a platform key/secret
    const direct = await checkout(s, s.users[2], stripeEnv({ STRIPE_INTEGRATION: 'pt_direct', CREDENTIAL_ENCRYPTION_KEY: 'short' }));
    expect(direct.status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('invalid modes and mismatched keys are rejected; setup stays readable without webhook secrets', async () => {
    const s = await pt();
    const admin = await seedUser({ role: 'admin' });
    expect((await worker.fetch(getRequest(admin, '/api/me'), stripeEnv({ PAYMENT_MODE: 'stripe_sandbox_typo' }))).status).toBe(503);
    const calls = mockStripe();
    // Like the Netlify wrapper: a key for the wrong mode fails closed before any write.
    expect((await worker.fetch(getRequest(admin, '/api/me'), stripeEnv({ STRIPE_SECRET_KEY: liveKey }))).status).toBe(503);
    const wrong = await checkout(s, s.users[0], stripeEnv({ STRIPE_SECRET_KEY: liveKey }));
    expect(wrong.status).toBe(503);
    expect(calls).toHaveLength(0);
    expect(await db().get('SELECT count(*) n FROM bookings WHERE block_id=?', s.blockId)).toEqual({ n: 0 });
    expect(await db().get('SELECT count(*) n FROM stripe_jobs j JOIN bookings b ON b.id=j.target_id WHERE b.block_id=?', s.blockId)).toEqual({ n: 0 });
    const setup = await worker.fetch(getRequest(admin, '/api/admin/stripe/setup'), stripeEnv({ STRIPE_WEBHOOK_SECRET: undefined, STRIPE_CONNECT_WEBHOOK_SECRET: undefined }));
    expect(setup.status).toBe(200);
    expect((await setup.json()).webhook_ready).toBe(false);
    expect((await worker.fetch(getRequest(admin, '/api/me'), stripeEnv({ STRIPE_WEBHOOK_SECRET: undefined }))).status).toBe(200);
  });

  it('live connected payments use the PT price and live account, keep test records, and need a matching signed live success', async () => {
    const s = await pt('connected', 'stripe_live');
    const testBooking = await insertBooking({ blockId: s.blockId, customerId: s.users[2].id, status: 'paid', mode: 'stripe_test', extra: { payment_intent: 'pi_test_old', paid_at: Date.now() } });
    const calls = mockStripe();
    const liveEnv = stripeEnv({ PAYMENT_MODE: 'stripe_live', STRIPE_SECRET_KEY: liveKey, STRIPE_WEBHOOK_SECRET: 'whsec_' + nodeCrypto.randomBytes(16).toString('hex') });
    const c = await checkout(s, s.users[0], liveEnv);
    expect(c.status).toBe(200);
    expect(calls[0]).toMatchObject({ account: s.account, auth: 'Bearer ' + liveKey });
    expect(calls[0].body.get('line_items[0][price_data][unit_amount]')).toBe('1500');
    const row = await db().get('SELECT mode,checkout_session FROM bookings WHERE id=?', c.body.booking_id);
    expect(row.mode).toBe('stripe_live');
    // A test-mode event cannot confirm a live booking; a signed live event can.
    expect((await deliver(sessionEvent(s, c.body.booking_id, row.checkout_session, 'checkout.session.completed', {}, s.account, false), liveEnv, liveEnv.STRIPE_WEBHOOK_SECRET)).status).toBe(403);
    expect((await deliver(sessionEvent(s, c.body.booking_id, row.checkout_session, 'checkout.session.completed', {}, s.account, true), liveEnv, env.STRIPE_WEBHOOK_SECRET)).status).toBe(400);
    expect((await deliver(sessionEvent(s, c.body.booking_id, row.checkout_session, 'checkout.session.completed', {}, s.account, true), liveEnv, liveEnv.STRIPE_WEBHOOK_SECRET)).status).toBe(200);
    expect((await db().get('SELECT status FROM bookings WHERE id=?', c.body.booking_id)).status).toBe('paid');
    expect(await db().get('SELECT status,mode FROM bookings WHERE id=?', testBooking)).toEqual({ status: 'paid', mode: 'stripe_test' });
  });

  it('platform routing: charges omit the connected-account header; the webhook must match the routing', async () => {
    const s = await pt('platform');
    const calls = mockStripe();
    const c = await checkout(s, s.users[0]);
    expect(c.status).toBe(200);
    expect(calls[0].account).toBeNull();
    const cs = (await db().get('SELECT checkout_session FROM bookings WHERE id=?', c.body.booking_id)).checkout_session;
    expect((await deliver(sessionEvent(s, c.body.booking_id, cs, 'checkout.session.completed', {}, 'acct_connected_x'))).status).toBe(400);
    expect((await deliver(sessionEvent(s, c.body.booking_id, cs, 'checkout.session.completed', {}, null))).status).toBe(200);
    expect((await db().get('SELECT status FROM bookings WHERE id=?', c.body.booking_id)).status).toBe('paid');
  });
});
