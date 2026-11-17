// Phase 3 Stripe paths with fetch MOCKED (vi.spyOn(globalThis, 'fetch')): no test contacts
// Stripe. Stripe mode is set per request via a copy of env (PAYMENT_MODE=stripe_test).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../worker/index.mjs';
import { runJob } from '../src/stripe-jobs.mjs';
import { seal } from '../src/pt-credentials.mjs';
import { db, seedBlock, seedUser, insertBooking, jsonRequest, ORIGIN, tally } from './helpers.mjs';
import nodeCrypto from 'node:crypto';

const stripeEnv = (over = {}) => Object.assign(Object.create(null), env, { PAYMENT_MODE: 'stripe_test', STRIPE_INTEGRATION: 'connect' }, over);
const call = (user, method, path, body, e = stripeEnv()) => worker.fetch(jsonRequest(user, method, path, body), e);
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** Route table for the mock: [method, path regex, handler(req info) -> Response]. */
function mockStripe(routes) {
  const calls = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    const info = { method, path: url.pathname, idempotency: headers.get('Idempotency-Key'), account: headers.get('Stripe-Account'), auth: headers.get('Authorization'), body: init.body };
    calls.push(info);
    if (url.origin !== 'https://api.stripe.com') throw new Error('unexpected host in test: ' + url.origin);
    for (const [m, re, fn] of routes) if (m === method && re.test(url.pathname)) return fn(info);
    return json(404, { error: { message: 'no mock' } });
  });
  return { calls, spy };
}
afterEach(() => vi.restoreAllMocks());

async function connectedPt({ customers = 2 } = {}) {
  const s = await seedBlock({ customers });
  const account = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
  await db().run("INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready) VALUES(?,?,?,?,1)", s.ptId, 'stripe_test', account, 'connected');
  return { ...s, account };
}
const paidStripeBooking = (s, customerId, extra = {}) => insertBooking({ blockId: s.blockId, customerId, status: 'paid', mode: 'stripe_test', extra: { stripe_account_id: s.account, stripe_routing: 'connected', payment_intent: 'pi_test_' + nodeCrypto.randomBytes(6).toString('hex'), ...extra } });

describe('checkout (mocked Stripe)', () => {
  it('booking -> Checkout Session with the job id as Idempotency-Key; another customer gets 404 on checkout', async () => {
    const s = await connectedPt();
    const { calls } = mockStripe([['POST', /^\/v1\/checkout\/sessions$/, () => json(200, { id: 'cs_test_' + nodeCrypto.randomBytes(6).toString('hex'), url: 'https://checkout.stripe.com/c/pay/x', livemode: false })]]);
    const r = await worker.fetch(new Request(ORIGIN + '/api/bookings', { method: 'POST', headers: { origin: ORIGIN, cookie: 'fit_session=' + s.users[0].token, 'x-csrf-token': s.users[0].csrf, 'content-type': 'application/json' }, body: JSON.stringify({ block_id: s.blockId, checkout_token: crypto.randomUUID() }) }), stripeEnv());
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.url).toBe('https://checkout.stripe.com/c/pay/x');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', idempotency: 'checkout:' + body.booking_id, account: s.account });
    expect(calls[0].auth).toMatch(/^Bearer sk_test_/);
    // Same checkout again: the stored result, no second Stripe call.
    expect((await (await call(s.users[0], 'POST', `/api/bookings/${body.booking_id}/checkout`)).json()).url).toBe(body.url);
    expect(calls).toHaveLength(1);
    expect((await call(s.users[1], 'POST', `/api/bookings/${body.booking_id}/checkout`)).status).toBe(404);
  });

  it('concurrent runJob for one job: same Idempotency-Key, effect applied once', async () => {
    const s = await connectedPt();
    const bk = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'pending', mode: 'stripe_test', extra: { stripe_account_id: s.account, stripe_routing: 'connected' } });
    // A key for the wrong mode fails closed before any write (netlify/functions/platform.mjs:47).
    expect((await call(s.users[0], 'POST', `/api/bookings/${bk}/checkout`, {}, stripeEnv({ STRIPE_SECRET_KEY: 'not-a-key' }))).status).toBe(503);
    expect(await db().get('SELECT status FROM stripe_jobs WHERE id=?', 'checkout:' + bk)).toBeNull();
    // A Stripe 500 keeps the job for retry.
    mockStripe([['POST', /^\/v1\/checkout\/sessions$/, () => json(500, { error: { message: 'fixture outage' } })]]);
    const r0 = await call(s.users[0], 'POST', `/api/bookings/${bk}/checkout`, {});
    expect(r0.status).toBeGreaterThanOrEqual(500);
    vi.restoreAllMocks();
    expect((await db().get('SELECT status FROM stripe_jobs WHERE id=?', 'checkout:' + bk)).status).toBe('retry');
    expect((await db().get('SELECT status FROM bookings WHERE id=?', bk)).status).toBe('pending');
    const sessionId = 'cs_test_' + nodeCrypto.randomBytes(6).toString('hex');
    const { calls } = mockStripe([['POST', /^\/v1\/checkout\/sessions$/, async () => { await new Promise(r => setTimeout(r, 20)); return json(200, { id: sessionId, url: 'https://checkout.stripe.com/c/pay/y', livemode: false }); }]]);
    const outs = await Promise.all(Array.from({ length: 5 }, () => runJob(stripeEnv(), db(), 'checkout:' + bk, { mode: 'stripe_test', integration: 'connect' })));
    const keys = new Set(calls.map(c => c.idempotency));
    console.log('concurrent runJob x5: statuses', JSON.stringify(tally(outs.map(o => o.status))), 'Stripe calls', calls.length, 'distinct Idempotency-Keys', keys.size);
    expect(outs.every(o => o.status === 200 && o.body.url === 'https://checkout.stripe.com/c/pay/y')).toBe(true);
    expect([...keys]).toEqual(['checkout:' + bk]);
    const job = await db().get('SELECT status FROM stripe_jobs WHERE id=?', 'checkout:' + bk);
    expect(job.status).toBe('done');
    expect((await db().get('SELECT checkout_session FROM bookings WHERE id=?', bk)).checkout_session).toBe(sessionId);
  });

  it('Stripe 500 -> job retry (booking kept); Stripe 400 -> job failed and booking failed', async () => {
    const s = await connectedPt();
    const bk = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'pending', mode: 'stripe_test', extra: { stripe_account_id: s.account, stripe_routing: 'connected' } });
    mockStripe([['POST', /^\/v1\/checkout\/sessions$/, () => json(500, { error: {} })]]);
    const r1 = await call(s.users[0], 'POST', `/api/bookings/${bk}/checkout`);
    const b1 = await r1.json();
    expect(r1.status).toBe(503);
    expect(b1.retryable).toBe(true);
    expect((await db().get('SELECT status FROM stripe_jobs WHERE id=?', 'checkout:' + bk)).status).toBe('retry');
    expect((await db().get('SELECT status FROM bookings WHERE id=?', bk)).status).toBe('pending');
    vi.restoreAllMocks();
    mockStripe([['POST', /^\/v1\/checkout\/sessions$/, () => json(400, { error: {} })]]);
    const r2 = await call(s.users[0], 'POST', `/api/bookings/${bk}/checkout`);
    expect(r2.status).toBe(409);
    expect((await db().get('SELECT status FROM stripe_jobs WHERE id=?', 'checkout:' + bk)).status).toBe('failed');
    expect((await db().get('SELECT status FROM bookings WHERE id=?', bk)).status).toBe('failed');
  });

  it('cancel: expires the open session; another customer and another PT get 404', async () => {
    const s = await connectedPt(), other = await connectedPt({ customers: 0 });
    const ptOther = await seedUser({ role: 'pt', ptId: other.ptId });
    const bk = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'pending', mode: 'stripe_test', extra: { stripe_account_id: s.account, stripe_routing: 'connected', checkout_session: 'cs_test_cancelme' } });
    const { calls } = mockStripe([
      ['GET', /^\/v1\/checkout\/sessions\/cs_test_cancelme$/, () => json(200, { id: 'cs_test_cancelme', status: 'open', livemode: false })],
      ['POST', /^\/v1\/checkout\/sessions\/cs_test_cancelme\/expire$/, () => json(200, { id: 'cs_test_cancelme', status: 'expired', livemode: false })]
    ]);
    expect((await call(s.users[1], 'POST', `/api/bookings/${bk}/cancel`)).status).toBe(404);
    expect((await call(ptOther, 'POST', `/api/bookings/${bk}/cancel`)).status).toBe(404);
    expect(calls).toHaveLength(0);
    const r = await call(s.users[0], 'POST', `/api/bookings/${bk}/cancel`);
    expect(r.status).toBe(200);
    expect(calls.map(c => c.method + ' ' + c.path)).toEqual(['GET /v1/checkout/sessions/cs_test_cancelme', 'POST /v1/checkout/sessions/cs_test_cancelme/expire']);
    expect(calls[1].idempotency).toBe('cancel:' + bk);
    expect((await db().get('SELECT status FROM bookings WHERE id=?', bk)).status).toBe('cancelled');
  });
});

describe('refund (mocked Stripe)', () => {
  it('another PT gets 404; 5 concurrent refund requests -> 1 job, 1 Idempotency-Key', async () => {
    const s = await connectedPt(), other = await connectedPt({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId }), ptOther = await seedUser({ role: 'pt', ptId: other.ptId });
    const bk = await paidStripeBooking(s, s.users[0].id);
    const { calls } = mockStripe([['POST', /^\/v1\/refunds$/, async info => { await new Promise(r => setTimeout(r, 10)); return json(200, { id: 're_test_1', status: 'pending', amount: 1500, currency: 'gbp', payment_intent: new URLSearchParams(info.body).get('payment_intent'), livemode: false }); }]]);
    expect((await call(ptOther, 'POST', `/api/bookings/${bk}/refund`, { request_token: crypto.randomUUID() })).status).toBe(404);
    expect((await call(s.users[0], 'POST', `/api/bookings/${bk}/refund`, { request_token: crypto.randomUUID() })).status).toBe(403);
    const res = await Promise.all(Array.from({ length: 5 }, () => call(pt, 'POST', `/api/bookings/${bk}/refund`, { request_token: crypto.randomUUID() })));
    const jobs = (await db().get("SELECT count(*) n FROM stripe_jobs WHERE target_id=? AND kind='refund'", bk)).n;
    console.log('5 concurrent refund requests:', JSON.stringify(tally(res.map(r => r.status))), 'refund jobs', jobs, 'Stripe refund calls', calls.length);
    expect(jobs).toBe(1);
    expect(new Set(calls.map(c => c.idempotency)).size).toBe(1);
    expect(res.filter(r => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect((await db().get('SELECT refund_status FROM bookings WHERE id=?', bk)).refund_status).toBe('pending');
  });
});

describe('connect and admin link (mocked Stripe)', () => {
  it('PT connect: account job then onboarding link, chained; admin link binds platform account', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId }), admin = await seedUser({ role: 'admin' });
    const acct = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
    const { calls } = mockStripe([
      ['POST', /^\/v2\/core\/accounts$/, () => json(200, { id: acct, livemode: false })],
      ['POST', /^\/v2\/core\/account_links$/, () => json(200, { url: 'https://connect.stripe.com/setup/x', livemode: false })],
      ['GET', /^\/v1\/account$/, () => json(200, { id: 'acct_platform_' + nodeCrypto.randomBytes(4).toString('hex'), charges_enabled: true, livemode: false })]
    ]);
    const r = await call(pt, 'POST', '/api/pt/stripe/connect');
    expect(r.status).toBe(200);
    expect((await r.json()).url).toBe('https://connect.stripe.com/setup/x');
    expect(calls.map(c => c.path)).toEqual(['/v2/core/accounts', '/v2/core/account_links']);
    expect(calls[0].idempotency).toBe('account:' + s.ptId);
    expect((await db().get("SELECT account_id FROM stripe_connections WHERE pt_id=? AND mode='stripe_test'", s.ptId)).account_id).toBe(acct);
    const other = await seedBlock({ customers: 0 });
    expect((await call(pt, 'POST', '/api/admin/stripe/link', { pt_id: other.ptId })).status).toBe(403);
    const link = await call(admin, 'POST', '/api/admin/stripe/link', { pt_id: other.ptId });
    expect(link.status).toBe(200);
    expect(await link.json()).toMatchObject({ ok: true, ready: true, mode: 'stripe_test' });
  });
});

describe('legacy pt_direct read path', () => {
  const ptDirectEnv = () => stripeEnv({ STRIPE_INTEGRATION: 'pt_direct' });
  async function credential(s) {
    const row = { id: crypto.randomUUID(), pt_id: s.ptId, mode: 'stripe_test' };
    const key = 'rk_test_' + nodeCrypto.randomBytes(12).toString('hex'), whsec = 'whsec_' + nodeCrypto.randomBytes(16).toString('hex');
    await db().run('INSERT INTO pt_stripe_credentials(id,pt_id,mode,account_id,api_cipher,webhook_cipher,enabled,charges_ready,created_at) VALUES(?,?,?,?,?,?,1,1,?)', row.id, s.ptId, 'stripe_test', 'acct_direct_' + row.id.slice(0, 8), seal(env, key, row, 'api'), seal(env, whsec, row, 'webhook'), Date.now());
    return { ...row, key, whsec, account: 'acct_direct_' + row.id.slice(0, 8) };
  }
  const signed = (c, payload, secret = c.whsec) => {
    const raw = JSON.stringify(payload), t = Math.floor(Date.now() / 1000);
    const v1 = nodeCrypto.createHmac('sha256', secret).update(t + '.' + raw).digest('hex');
    return new Request(`${ORIGIN}/api/stripe/pt/${c.id}/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${v1}`, 'content-type': 'application/json' }, body: raw });
  };

  it('refund uses the decrypted PT key; wrong encryption key -> 503; PT webhook: bad signature, event.account, authoritative mismatch, success once', async () => {
    const s = await seedBlock({ customers: 1 });
    const c = await credential(s);
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const pi = 'pi_test_' + nodeCrypto.randomBytes(6).toString('hex');
    const bk = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'paid', mode: 'stripe_test', extra: { stripe_account_id: c.account, stripe_routing: 'platform', stripe_credential_id: c.id, payment_intent: pi } });
    const event = { id: 'evt_test_' + nodeCrypto.randomBytes(6).toString('hex'), type: 'charge.refunded', livemode: false, data: { object: { id: 'ch_test_1', payment_intent: pi, amount: 1500, amount_refunded: 1500, currency: 'gbp', livemode: false } } };
    const { calls } = mockStripe([
      ['POST', /^\/v1\/refunds$/, info => json(200, { id: 're_test_direct', status: 'pending', amount: 1500, currency: 'gbp', payment_intent: new URLSearchParams(info.body).get('payment_intent'), livemode: false })],
      ['GET', /^\/v1\/events\//, info => json(200, info.path.endsWith(event.id) ? event : { ...event, id: info.path.split('/').pop(), type: 'account.updated' })]
    ]);
    // Refund: the PT's own key, no Stripe-Account header.
    const r = await call(pt, 'POST', `/api/bookings/${bk}/refund`, { request_token: crypto.randomUUID() }, ptDirectEnv());
    expect(r.status).toBe(200);
    expect(calls[0]).toMatchObject({ path: '/v1/refunds', auth: 'Bearer ' + c.key, account: null });
    // Wrong master key: credentials cannot be opened.
    const wrong = stripeEnv({ STRIPE_INTEGRATION: 'pt_direct', CREDENTIAL_ENCRYPTION_KEY: nodeCrypto.randomBytes(32).toString('hex') });
    expect((await worker.fetch(signed(c, event), wrong)).status).toBe(503);
    // Webhook checks.
    expect((await worker.fetch(signed(c, event, 'whsec_wrong'), ptDirectEnv())).status).toBe(400);
    expect((await worker.fetch(signed(c, { ...event, account: 'acct_other' }), ptDirectEnv())).status).toBe(400);
    const mismatch = await worker.fetch(signed(c, { ...event, id: 'evt_test_other' }), ptDirectEnv());
    expect(mismatch.status).toBe(400);
    const ok = await worker.fetch(signed(c, event), ptDirectEnv());
    expect(ok.status).toBe(200);
    const dup = await (await worker.fetch(signed(c, event), ptDirectEnv())).json();
    expect(dup).toEqual({ duplicate: true });
    const after = await db().get('SELECT status,refund_status,refunded_pence FROM bookings WHERE id=?', bk);
    expect(after).toMatchObject({ refund_status: 'succeeded', refunded_pence: 1500, status: 'cancelled' });
    expect((await db().get('SELECT webhook_seen_at FROM pt_stripe_credentials WHERE id=?', c.id)).webhook_seen_at).toBeGreaterThan(0);
    // Ported from tests/pt-direct.test.mjs: operations never store keys (credential id only).
    const payloads = (await db().all('SELECT payload,result FROM stripe_jobs WHERE target_id=?', bk)).map(r => r.payload + (r.result || ''));
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads.some(p => p.includes(c.key) || p.includes(c.whsec) || /\b(sk|rk)_(test|live)_|whsec_/.test(p))).toBe(false);
    expect(JSON.parse((await db().get('SELECT payload FROM stripe_jobs WHERE target_id=?', bk)).payload).credential_id).toBe(c.id);
    const authCalls = calls.filter(x => x.path.startsWith('/v1/events/'));
    expect(authCalls.every(x => x.auth === 'Bearer ' + c.key)).toBe(true);
    console.log('pt_direct: refund via PT key ok; webhook bad-sig 400, event.account 400, authoritative mismatch 400, wrong master key 503, applied once then duplicate');
  });

  it('a credential owned by another PT is rejected (ownership mismatch 403)', async () => {
    const s = await seedBlock({ customers: 1 }), t = await seedBlock({ customers: 0 });
    const cOther = await credential(t);
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const bk = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'paid', mode: 'stripe_test', extra: { stripe_account_id: cOther.account, stripe_routing: 'platform', stripe_credential_id: cOther.id, payment_intent: 'pi_test_x' } });
    const { calls } = mockStripe([]);
    const r = await call(pt, 'POST', `/api/bookings/${bk}/refund`, { request_token: crypto.randomUUID() }, ptDirectEnv());
    expect(r.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('platform webhook: refund before payment success (CR condition 2)', () => {
  it('409 without recording the event; after the payment event, the same refund event applies', async () => {
    const s = await connectedPt();
    const bk = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'pending', mode: 'stripe_test', extra: { stripe_account_id: s.account, stripe_routing: 'connected' } });
    await db().run("INSERT INTO stripe_jobs(id,kind,target_id,actor_id,payload,created_at) VALUES(?,?,?,?,?,?)", 'checkout:' + bk, 'checkout', bk, s.users[0].id, '{"mode":"stripe_test"}', Date.now());
    const pi = 'pi_test_' + nodeCrypto.randomBytes(6).toString('hex');
    const secret = env.STRIPE_WEBHOOK_SECRET;
    const send = payload => { const raw = JSON.stringify(payload), t = Math.floor(Date.now() / 1000); return worker.fetch(new Request(ORIGIN + '/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${nodeCrypto.createHmac('sha256', secret).update(t + '.' + raw).digest('hex')}` }, body: raw }), stripeEnv()); };
    const refund = { id: 'evt_test_ref_' + bk, type: 'charge.refunded', account: s.account, livemode: false, data: { object: { id: 'ch_test', payment_intent: pi, amount: 1500, amount_refunded: 1500, currency: 'gbp', metadata: { booking_id: bk }, livemode: false } } };
    const early = await send(refund);
    const earlyBody = await early.json();
    console.log('refund before payment:', early.status, earlyBody.code);
    expect(early.status).toBe(409);
    expect(earlyBody).toMatchObject({ code: 'REFUND_BEFORE_PAYMENT', retryable: true });
    expect(await db().get('SELECT id FROM webhook_events WHERE id=?', refund.id)).toBeNull();
    const paid = { id: 'evt_test_paid_' + bk, type: 'checkout.session.completed', account: s.account, livemode: false, data: { object: { id: 'cs_test_' + bk.slice(3, 15), mode: 'payment', payment_status: 'paid', payment_intent: pi, amount_total: 1500, currency: 'gbp', metadata: { booking_id: bk, pt_id: s.ptId }, livemode: false } } };
    expect((await send(paid)).status).toBe(200);
    const retry = await send(refund);
    expect(retry.status).toBe(200);
    expect(await db().get('SELECT status,refund_status,refunded_pence FROM bookings WHERE id=?', bk)).toMatchObject({ status: 'cancelled', refund_status: 'succeeded', refunded_pence: 1500 });
  });
});
