// RC-30 block instalment payments (MVP). Stripe is MOCKED (vi.spyOn(globalThis, 'fetch'));
// no test contacts Stripe. Contract: docs/rc-30-api-contract.md (v2, e4754a74).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../worker/index.mjs';
import { drainPlanJobs } from '../src/stripe-jobs.mjs';
import { planAmounts, seqFromPeriod, parsePaymentOptions, addMonths, dueAt } from '../src/instalments.mjs';
import { db, seedBlock, seedUser, insertBooking, jsonRequest, getRequest, signedWebhook, ORIGIN } from './helpers.mjs';
import nodeCrypto from 'node:crypto';

const stripeEnv = (over = {}) => Object.assign(Object.create(null), env, { PAYMENT_MODE: 'stripe_test', STRIPE_INTEGRATION: 'connect' }, over);
const call = (user, method, path, body, e = stripeEnv()) => worker.fetch(jsonRequest(user, method, path, body), e);
const get = (user, path, e = stripeEnv()) => worker.fetch(getRequest(user, path), e);
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const rid = (p = '') => p + nodeCrypto.randomBytes(6).toString('hex');
const WEEK = 7 * 86400;

function mockStripe(routes = []) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    const info = { method, path: url.pathname, idempotency: headers.get('Idempotency-Key'), account: headers.get('Stripe-Account'), body: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {} };
    calls.push(info);
    if (url.origin !== 'https://api.stripe.com') throw new Error('unexpected host in test: ' + url.origin);
    for (const [m, re, fn] of routes) if (m === method && re.test(url.pathname)) return fn(info);
    return json(404, { error: { message: 'no mock' } });
  });
  return calls;
}
afterEach(() => vi.restoreAllMocks());

const scheduleRoutes = (schedId = rid('sub_sched_')) => [
  ['POST', /^\/v1\/subscription_schedules$/, () => json(200, { id: schedId, livemode: false, phases: [{ start_date: 1900000000, items: [{ price: 'price_test1', quantity: 1 }] }] })],
  ['POST', /^\/v1\/subscription_schedules\/sub_sched_/, () => json(200, { id: schedId, livemode: false, end_behavior: 'cancel' })]
];
const cancelRoute = ['DELETE', /^\/v1\/subscriptions\/sub_/, info => json(200, { id: info.path.split('/').pop(), status: 'canceled', livemode: false })];

/** A connected PT, a block with plan rows, and customers. */
async function planBlock({ weekly = { amount: 1250, count: 8 }, monthly = null, upfront = true, price = 10000, customers = 3, lastSession = Date.UTC(2099, 0, 5, 18, 30) } = {}) {
  const s = await seedBlock({ customers, price });
  const account = rid('acct_test_');
  const d = db();
  const stmts = [
    d.stmt("INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready) VALUES(?,?,?,?,1)", s.ptId, 'stripe_test', account, 'connected'),
    d.stmt('UPDATE blocks SET upfront_enabled=? WHERE id=?', upfront ? 1 : 0, s.blockId),
    d.stmt('UPDATE class_sessions SET starts_epoch=?,starts_at=? WHERE block_id=?', lastSession, new Date(lastSession).toISOString().slice(0, 16), s.blockId)
  ];
  for (const [plan, p] of [['weekly', weekly], ['monthly', monthly]]) if (p) stmts.push(d.stmt('INSERT INTO block_payment_plans(block_id,plan,enabled,amount_pence,count,updated_at) VALUES(?,?,1,?,?,?)', s.blockId, plan, p.amount, p.count, Date.now()));
  await d.batch(stmts);
  const pt = await seedUser({ role: 'pt', ptId: s.ptId });
  return { ...s, account, pt };
}

/** A paid plan booking inserted directly (for stop/view/list tests). */
async function planBooking(s, customerId, { plan = 'weekly', count = 4, amount = 1000, paid = 1, failed = [], planStatus = 'active', sub = rid('sub_test_'), schedule = null } = {}) {
  const id = await insertBooking({ blockId: s.blockId, customerId, status: 'paid', mode: 'stripe_test', extra: {
    stripe_account_id: s.account, stripe_routing: 'connected', payment_intent: rid('pi_test_'), amount_pence: amount, plan, plan_count: count,
    total_pence: amount * count, list_price_pence: amount * count, discount_pence: 0, plan_status: planStatus, stripe_subscription_id: sub, stripe_customer_id: rid('cus_test_'), stripe_schedule_id: schedule, plan_anchor: 1900000000 } });
  const now = Date.now();
  const stmts = [];
  for (let seq = 1; seq <= count; seq++) {
    const status = seq <= paid ? 'paid' : failed.includes(seq) ? 'failed' : 'upcoming';
    stmts.push(db().stmt('INSERT INTO booking_instalments(id,booking_id,seq,amount_pence,due_at,status,attempts,paid_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id + ':' + seq, id, seq, amount, dueAt(plan, now, seq), status, status === 'failed' ? 1 : 0, status === 'paid' ? now : null, now));
  }
  await db().batch(stmts);
  return { id, sub };
}

const book = (user, blockId, extra = {}) => call(user, 'POST', '/api/bookings', { block_id: blockId, checkout_token: crypto.randomUUID(), ...extra });
const hook = async payload => { const r = await worker.fetch(signedWebhook(payload)(), stripeEnv()); return { status: r.status, body: await r.json() }; };
const evt = (type, object, { account, created = Math.floor(Date.now() / 1000), id = rid('evt_') } = {}) => ({ id, type, livemode: false, account, created, data: { object: { livemode: false, ...object } } });
const invoice = (s, bk, { id = rid('in_'), sub, seq, anchor = 1900000000, amount = 1000, reason = 'subscription_cycle', attempt = 1 }) => ({
  id, object: 'invoice', currency: 'gbp', customer: 'cus_x', amount_paid: amount, billing_reason: reason, attempt_count: attempt, status: 'open',
  parent: { subscription_details: { subscription: sub, metadata: { booking_id: bk } } },
  lines: { data: [{ period: { start: anchor + (seq - 1) * WEEK, end: anchor + seq * WEEK } }] }
});
const instRows = id => db().all('SELECT seq,status,amount_pence FROM booking_instalments WHERE booking_id=? ORDER BY seq', id);
const bookingRow = id => db().get('SELECT status,plan_status,plan_anchor,stripe_subscription_id,stripe_schedule_id FROM bookings WHERE id=?', id);

describe('rounding and plan validation (pure)', () => {
  it('splits a total into whole-pence payments with the remainder on payment 1', () => {
    expect(planAmounts({ amount_pence: 1250, count: 8 })).toEqual({ list_total_pence: 10000, discount_pence: 0, total_pence: 10000, amounts: Array(8).fill(1250) });
    expect(planAmounts({ amount_pence: 1250, count: 8, discount: { kind: 'percent', amount: 10 } }).amounts).toEqual(Array(8).fill(1125));
    // 10% of 1005 = 100.5 -> rounds half up to 101; 904 / 3 = 301 r 1 -> [302, 301, 301].
    const r = planAmounts({ amount_pence: 335, count: 3, discount: { kind: 'percent', amount: 10 } });
    expect(r).toEqual({ list_total_pence: 1005, discount_pence: 101, total_pence: 904, amounts: [302, 301, 301] });
    expect(planAmounts({ amount_pence: 1000, count: 3, discount: { kind: 'fixed', amount: 1 } }).amounts).toEqual([1001, 999, 999]);
    for (const [a, c, off] of [[333, 7, 13], [30, 52, 7], [999999, 12, 5]]) {
      const x = planAmounts({ amount_pence: a, count: c, discount: { kind: 'fixed', amount: off } });
      expect(x.amounts.reduce((n, v) => n + v, 0)).toBe(x.total_pence);
    }
    // A discount never takes the total below 0.
    expect(planAmounts({ amount_pence: 100, count: 2, discount: { kind: 'fixed', amount: 99999 } })).toMatchObject({ discount_pence: 200, total_pence: 0, amounts: [0, 0] });
  });

  it('maps billing periods to payment numbers (weekly and month-end monthly)', () => {
    const a = 1900000000;
    expect(seqFromPeriod('weekly', a, a)).toBe(1);
    expect(seqFromPeriod('weekly', a, a + WEEK)).toBe(2);
    expect(seqFromPeriod('weekly', a, a + 2 * WEEK + 86400)).toBe(3);
    expect(seqFromPeriod('weekly', a, a + Math.round(3.5 * 86400))).toBeNull();
    expect(seqFromPeriod('weekly', a, a - WEEK)).toBeNull();
    const jan31 = Date.UTC(2027, 0, 31, 10) / 1000;
    expect(new Date(addMonths(jan31 * 1000, 1)).toISOString()).toBe('2027-02-28T10:00:00.000Z');
    expect(seqFromPeriod('monthly', jan31, addMonths(jan31 * 1000, 1) / 1000)).toBe(2);
    expect(seqFromPeriod('monthly', jan31, addMonths(jan31 * 1000, 11) / 1000)).toBe(12);
  });

  it('validates payment_options: PLAN_INVALID, NO_PAYMENT_OPTION, FIELDS_INVALID', () => {
    const code = fn => { try { fn(); return null; } catch (e) { return e.code; } };
    expect(parsePaymentOptions(undefined)).toBeNull();
    expect(code(() => parsePaymentOptions({ weekly: { enabled: true, amount_pence: 1000, count: 1 } }))).toBe('PLAN_INVALID');
    expect(code(() => parsePaymentOptions({ weekly: { enabled: true, amount_pence: 1000, count: 53 } }))).toBe('PLAN_INVALID');
    expect(code(() => parsePaymentOptions({ monthly: { enabled: true, amount_pence: 1000, count: 13 } }))).toBe('PLAN_INVALID');
    expect(code(() => parsePaymentOptions({ weekly: { enabled: true, amount_pence: 29, count: 4 } }))).toBe('PLAN_INVALID');
    expect(code(() => parsePaymentOptions({ weekly: { enabled: true, amount_pence: 1000, count: '4' } }))).toBe('FIELDS_INVALID');
    expect(code(() => parsePaymentOptions({ yearly: { enabled: true } }))).toBe('FIELDS_INVALID');
    expect(code(() => parsePaymentOptions({ upfront: { enabled: false }, weekly: { enabled: false } }))).toBe('NO_PAYMENT_OPTION');
    expect(parsePaymentOptions({ weekly: { enabled: true, amount_pence: 1250, count: 8 } })).toMatchObject({ upfront: { enabled: true }, weekly: { amount_pence: 1250, count: 8 } });
  });
});

describe('block plan config (API)', () => {
  const blockBody = (over = {}) => ({ create_key: crypto.randomUUID(), title: 'Strength block', description: 'Eight weeks', venue: 'Studio', capacity: 5, sessions: [{ starts_at: '2099-01-05T18:30', duration_minutes: 60 }], ...over });

  it('C1: upfront off -> price_pence optional and stored as the lowest plan total; errors carry codes', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const r = await call(pt, 'POST', '/api/blocks', blockBody({ payment_options: { upfront: { enabled: false }, weekly: { enabled: true, amount_pence: 1250, count: 8 }, monthly: { enabled: true, amount_pence: 4000, count: 2 } } }));
    const body = await r.json();
    expect(r.status).toBe(201);
    const id = body.block?.id ?? body.id;
    expect(await db().get('SELECT price_pence,upfront_enabled FROM blocks WHERE id=?', id)).toEqual({ price_pence: 8000, upfront_enabled: 0 });
    expect(await db().all('SELECT plan,enabled,amount_pence,count FROM block_payment_plans WHERE block_id=? ORDER BY plan', id)).toEqual([
      { plan: 'monthly', enabled: 1, amount_pence: 4000, count: 2 }, { plan: 'weekly', enabled: 1, amount_pence: 1250, count: 8 }]);
    // Upfront on: upfront.price_pence is the block price and keeps the 100..1,000,000 range.
    const up = await call(pt, 'POST', '/api/blocks', blockBody({ payment_options: { upfront: { enabled: true, price_pence: 10000 }, weekly: { enabled: true, amount_pence: 1250, count: 8 } } }));
    const upBody = await up.json();
    expect(up.status).toBe(201);
    expect((await db().get('SELECT price_pence,upfront_enabled FROM blocks WHERE id=?', upBody.block?.id ?? upBody.id))).toEqual({ price_pence: 10000, upfront_enabled: 1 });
    expect((await call(pt, 'POST', '/api/blocks', blockBody({ payment_options: { upfront: { enabled: true, price_pence: 50 }, weekly: { enabled: true, amount_pence: 1250, count: 8 } } }))).status).toBe(400);
    const codes = async opts => (await (await call(pt, 'POST', '/api/blocks', blockBody({ payment_options: opts }))).json()).code;
    expect(await codes({ upfront: { enabled: false }, weekly: { enabled: false } })).toBe('NO_PAYMENT_OPTION');
    expect(await codes({ weekly: { enabled: true, amount_pence: 1250, count: 1 } })).toBe('PLAN_INVALID');
    expect(await codes({ weekly: { enabled: true, amount_pence: '12', count: 4 } })).toBe('FIELDS_INVALID');
    // The final session is ~10 days out: an 8-week plan would run past it.
    const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 16);
    const ex = await call(pt, 'POST', '/api/blocks', blockBody({ sessions: [{ starts_at: soon, duration_minutes: 60 }], payment_options: { upfront: { enabled: true, price_pence: 10000 }, weekly: { enabled: true, amount_pence: 1250, count: 8 } } }));
    expect(ex.status).toBe(400);
    expect((await ex.json()).code).toBe('PLAN_EXCEEDS_BLOCK');
  });

  it('without payment_options the old validator is unchanged (price required, 100..1,000,000)', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    expect((await call(pt, 'POST', '/api/blocks', blockBody())).status).toBe(400);
    expect((await call(pt, 'POST', '/api/blocks', blockBody({ price_pence: 50 }))).status).toBe(400);
    const ok = await call(pt, 'POST', '/api/blocks', blockBody({ price_pence: 1500 }));
    const b = await ok.json();
    expect(ok.status).toBe(201);
    const id = b.block?.id ?? b.id;
    expect(await db().get('SELECT price_pence,upfront_enabled FROM blocks WHERE id=?', id)).toEqual({ price_pence: 1500, upfront_enabled: 1 });
    expect(await db().all('SELECT plan FROM block_payment_plans WHERE block_id=?', id)).toEqual([]);
  });

  it('public block read lists enabled, still-fitting plans only', async () => {
    const s = await planBlock({ monthly: { amount: 5000, count: 2 } });
    await db().run("UPDATE block_payment_plans SET enabled=0 WHERE block_id=? AND plan='monthly'", s.blockId);
    const slug = (await db().get('SELECT slug FROM pts WHERE id=?', s.ptId)).slug;
    const r = await worker.fetch(new Request(ORIGIN + '/api/public/pts/' + slug), stripeEnv());
    const body = await r.json();
    const blk = body.blocks.find(b => b.id === s.blockId);
    expect(blk.payment_options.map(o => o.plan)).toEqual(['upfront', 'weekly']);
    expect(blk.payment_options[1]).toMatchObject({ plan: 'weekly', count: 8, today_pence: 1250, total_pence: 10000 });
    expect(blk.payment_options[1].payments).toHaveLength(8);
  });
});

describe('checkout quote (write-free)', () => {
  it('quotes each plan, writes nothing, and answers stable codes', async () => {
    const s = await planBlock();
    const counts = async () => JSON.stringify(await db().all("SELECT (SELECT count(*) FROM bookings) b,(SELECT count(*) FROM booking_instalments) i,(SELECT count(*) FROM stripe_jobs) j,(SELECT count(*) FROM audit_log) a"));
    const before = await counts();
    const fetchSpy = mockStripe();
    const q = await call(s.users[0], 'POST', '/api/bookings/quote', { block_id: s.blockId, plan: 'weekly' });
    const body = await q.json();
    expect(q.status).toBe(200);
    expect(body.quote).toMatchObject({ plan: 'weekly', count: 8, list_total_pence: 10000, discount: null, total_pence: 10000, today_pence: 1250 });
    expect(body.quote.payments.map(p => p.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Date.parse(body.quote.payments[1].due_at) - Date.parse(body.quote.payments[0].due_at)).toBe(7 * 86400000);
    expect((await (await call(s.users[0], 'POST', '/api/bookings/quote', { block_id: s.blockId })).json()).quote).toMatchObject({ plan: 'upfront', total_pence: 10000, today_pence: 10000 });
    const code = async (user, b) => { const r = await call(user, 'POST', '/api/bookings/quote', b); return [r.status, (await r.json()).code]; };
    expect(await code(s.users[0], { block_id: s.blockId, plan: 'weekly', discount_code: 'NEWYEAR10' })).toEqual([400, 'DISCOUNT_INVALID']);
    expect(await code(s.users[0], { block_id: s.blockId, plan: 'monthly' })).toEqual([409, 'PLAN_NOT_OFFERED']);
    expect(await code(s.users[0], { block_id: 'nope-' + rid(), plan: 'weekly' })).toEqual([404, 'NOT_FOUND']);
    expect(await code(s.pt, { block_id: s.blockId, plan: 'weekly' })).toEqual([403, 'FORBIDDEN']);
    expect(await code(null, { block_id: s.blockId, plan: 'weekly' })).toEqual([401, 'UNAUTHENTICATED']);
    expect(await counts()).toBe(before);
    expect(fetchSpy).toHaveLength(0);
  });

  it('PLAN_EXCEEDS_BLOCK when the plan would now run past the final session', async () => {
    const s = await planBlock({ lastSession: Date.now() + 10 * 86400000 });
    const r = await call(s.users[0], 'POST', '/api/bookings/quote', { block_id: s.blockId, plan: 'weekly' });
    expect([r.status, (await r.json()).code]).toEqual([409, 'PLAN_EXCEEDS_BLOCK']);
  });
});

describe('booking with a plan', () => {
  it('C2: 201 {booking, booking_id, url:/checkout/:id}; idempotent checkout_token; snapshot rows; no Stripe call yet', async () => {
    const s = await planBlock();
    const calls = mockStripe();
    const token = crypto.randomUUID();
    const r = await book(s.users[0], s.blockId, { checkout_token: token, plan: 'weekly' });
    const body = await r.json();
    expect(r.status).toBe(201);
    expect(body.url).toBe('/checkout/' + body.booking_id);
    expect(body.booking).toMatchObject({ id: body.booking_id, status: 'pending' });
    expect(body.booking.instalment_plan).toMatchObject({ plan: 'weekly', count: 8, today_pence: 1250, total_pence: 10000, list_total_pence: 10000, discount_pence: 0 });
    expect(body.booking.instalment_plan).not.toHaveProperty('can_stop');
    expect(calls).toHaveLength(0);
    const again = await book(s.users[0], s.blockId, { checkout_token: token, plan: 'weekly' });
    expect(again.status).toBe(201);
    expect((await again.json()).booking_id).toBe(body.booking_id);
    expect((await instRows(body.booking_id)).map(x => x.status)).toEqual(Array(8).fill('upcoming'));
    expect(await db().get('SELECT amount_pence,total_pence,plan,plan_count FROM bookings WHERE id=?', body.booking_id)).toEqual({ amount_pence: 1250, total_pence: 10000, plan: 'weekly', plan_count: 8 });
    // Same token, different plan -> 409 (not a silent replay).
    expect((await book(s.users[0], s.blockId, { checkout_token: token, plan: 'upfront' })).status).toBe(409);
    // C3: a fresh token while the checkout is open -> PAYMENT_IN_PROGRESS with the caller's own url.
    const c3 = await book(s.users[0], s.blockId, { plan: 'weekly' });
    expect(c3.status).toBe(409);
    expect(await c3.json()).toMatchObject({ code: 'PAYMENT_IN_PROGRESS', url: '/checkout/' + body.booking_id, booking_id: body.booking_id });
    // Another customer's booking is unaffected (their own 201).
    expect((await book(s.users[1], s.blockId, { plan: 'weekly' })).status).toBe(201);
  });

  it('PLAN_NOT_OFFERED for a disabled plan and for upfront on an upfront-off block', async () => {
    const s = await planBlock({ upfront: false });
    const c = async extra => { const r = await book(s.users[0], s.blockId, extra); return [r.status, (await r.json()).code]; };
    expect(await c({ plan: 'upfront' })).toEqual([409, 'PLAN_NOT_OFFERED']);
    expect(await c({})).toEqual([409, 'PLAN_NOT_OFFERED']);
    expect(await c({ plan: 'monthly' })).toEqual([409, 'PLAN_NOT_OFFERED']);
    expect(await c({ plan: 'yearly' })).toEqual([400, 'FIELDS_INVALID']);
  });

  it('upfront on a plan block keeps main\'s flow (200 with the Stripe url, mode=payment)', async () => {
    const s = await planBlock();
    const calls = mockStripe([['POST', /^\/v1\/checkout\/sessions$/, () => json(200, { id: rid('cs_test_'), url: 'https://checkout.stripe.com/c/pay/up', livemode: false })]]);
    const r = await book(s.users[0], s.blockId, {});
    expect(r.status).toBe(200);
    expect((await r.json()).url).toBe('https://checkout.stripe.com/c/pay/up');
    expect(calls[0].body.mode).toBe('payment');
  });

  it('checkout: subscription mode, direct charge on the connected account, no application fee, remainder on payment 1', async () => {
    const s = await planBlock({ weekly: { amount: 335, count: 3 } });
    // Insert a discounted snapshot via the booking route, then shape payment 1 with a remainder.
    const r = await book(s.users[0], s.blockId, { plan: 'weekly' });
    const { booking_id: id } = await r.json();
    await db().batch([db().stmt("UPDATE booking_instalments SET amount_pence=302 WHERE booking_id=? AND seq=1", id), db().stmt('UPDATE booking_instalments SET amount_pence=301 WHERE booking_id=? AND seq>1', id), db().stmt('UPDATE bookings SET amount_pence=302 WHERE id=?', id)]);
    const calls = mockStripe([['POST', /^\/v1\/checkout\/sessions$/, () => json(200, { id: rid('cs_test_'), url: 'https://checkout.stripe.com/c/pay/plan', livemode: false })]]);
    const co = await call(s.users[0], 'POST', `/api/bookings/${id}/checkout`);
    expect(co.status).toBe(200);
    expect((await co.json()).url).toBe('https://checkout.stripe.com/c/pay/plan');
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c).toMatchObject({ method: 'POST', path: '/v1/checkout/sessions', account: s.account, idempotency: 'checkout:' + id });
    expect(c.body).toMatchObject({ mode: 'subscription', 'line_items[0][price_data][unit_amount]': '301', 'line_items[0][price_data][recurring][interval]': 'week', 'line_items[1][price_data][unit_amount]': '1', 'subscription_data[metadata][booking_id]': id });
    expect(Object.keys(c.body).filter(k => /application_fee|transfer_data/.test(k))).toEqual([]);
  });
});

/** Book + checkout session bound, ready for webhooks. */
async function openPlanCheckout(opts = {}) {
  const s = await planBlock({ weekly: { amount: 1000, count: 3 }, ...opts });
  const { booking_id: id } = await (await book(s.users[0], s.blockId, { plan: 'weekly' })).json();
  const cs = rid('cs_test_');
  mockStripe([['POST', /^\/v1\/checkout\/sessions$/, () => json(200, { id: cs, url: 'https://checkout.stripe.com/c/pay/z', livemode: false })]]);
  expect((await call(s.users[0], 'POST', `/api/bookings/${id}/checkout`)).status).toBe(200);
  vi.restoreAllMocks();
  const sub = rid('sub_test_');
  const completed = (o = {}) => evt('checkout.session.completed', { id: cs, object: 'checkout.session', mode: 'subscription', payment_status: 'paid', amount_total: 1000, currency: 'gbp', metadata: { booking_id: id, pt_id: s.ptId }, subscription: sub, customer: 'cus_test_1', invoice: rid('in_'), ...o }, { account: s.account });
  return { s, id, cs, sub, completed };
}

describe('webhooks', () => {
  it('payment 1 confirms the booking, attaches the end-after-N schedule, and dedupes by event.id', async () => {
    const { id, sub, completed } = await openPlanCheckout();
    const calls = mockStripe(scheduleRoutes('sub_sched_A1'));
    const e = completed();
    const first = await hook(e);
    expect(first.status).toBe(200);
    expect(first.body).not.toHaveProperty('jobs');
    expect(await bookingRow(id)).toMatchObject({ status: 'paid', plan_status: 'active', stripe_subscription_id: sub, stripe_schedule_id: 'sub_sched_A1' });
    expect((await instRows(id)).map(r => r.status)).toEqual(['paid', 'upcoming', 'upcoming']);
    const update = calls.find(c => /^\/v1\/subscription_schedules\/sub_sched_A1$/.test(c.path));
    expect(calls[0]).toMatchObject({ path: '/v1/subscription_schedules', account: (await db().get('SELECT stripe_account_id a FROM bookings WHERE id=?', id)).a, body: { from_subscription: sub } });
    expect(update.body).toMatchObject({ end_behavior: 'cancel', proration_behavior: 'none', 'phases[0][duration][interval]': 'week', 'phases[0][duration][interval_count]': '3' });
    const dup = await hook(e);
    expect(dup).toMatchObject({ status: 200, body: { duplicate: true } });
    expect(calls).toHaveLength(2);
    expect((await db().get("SELECT count(*) n FROM email_outbox WHERE kind='confirmation' AND dedupe_key LIKE ?", '%' + id + '%')).n).toBe(1);
  });

  it('out of order: a renewal before payment 1 is retried (409, not recorded), stale failures never undo paid', async () => {
    const { s, id, sub, completed } = await openPlanCheckout();
    const anchor = 1900000000;
    const early = evt('invoice.paid', invoice(s, id, { sub, seq: 2, anchor }), { account: s.account });
    const r0 = await hook(early);
    expect(r0.status).toBe(409);
    expect(await db().get('SELECT id FROM webhook_events WHERE id=?', early.id)).toBeNull();
    mockStripe(scheduleRoutes());
    // Payment 1's invoice (subscription_create) fixes the anchor; then checkout completes.
    expect((await hook(evt('invoice.paid', invoice(s, id, { sub, seq: 1, anchor, reason: 'subscription_create' }), { account: s.account }))).status).toBe(200);
    expect((await hook(completed())).status).toBe(200);
    expect((await bookingRow(id)).plan_anchor).toBe(anchor);
    // Stripe redelivers the early renewal: now applied.
    expect((await hook(early)).status).toBe(200);
    // A failure for payment 2 that is OLDER than its paid event (and a later one) never undoes paid.
    const inv2 = (await db().get('SELECT stripe_invoice_id i FROM booking_instalments WHERE booking_id=? AND seq=2', id)).i;
    expect((await hook(evt('invoice.payment_failed', { ...invoice(s, id, { sub, seq: 2, anchor }), id: inv2 }, { account: s.account, created: early.created - 100 }))).status).toBe(200);
    expect((await hook(evt('invoice.payment_failed', { ...invoice(s, id, { sub, seq: 2, anchor }), id: inv2 }, { account: s.account, created: early.created + 100 }))).status).toBe(200);
    expect((await instRows(id)).map(r => r.status)).toEqual(['paid', 'paid', 'upcoming']);
    expect((await bookingRow(id)).plan_status).toBe('active');
  });

  it('invoice.payment_failed keeps the booking (past_due + dashboard reminder); a later success clears it', async () => {
    const { s, id, sub, completed } = await openPlanCheckout();
    mockStripe(scheduleRoutes());
    await hook(evt('invoice.paid', invoice(s, id, { sub, seq: 1, reason: 'subscription_create' }), { account: s.account }));
    await hook(completed());
    const inv = rid('in_');
    const failed = await hook(evt('invoice.payment_failed', { ...invoice(s, id, { sub, seq: 2 }), id: inv, attempt_count: 2, next_payment_attempt: 1900900000 }, { account: s.account }));
    expect(failed.status).toBe(200);
    expect(await bookingRow(id)).toMatchObject({ status: 'paid', plan_status: 'past_due' });
    expect(await db().get('SELECT status,attempts,next_retry_at FROM booking_instalments WHERE booking_id=? AND seq=2', id)).toEqual({ status: 'failed', attempts: 2, next_retry_at: 1900900000000 });
    const list = await (await get(s.pt, '/api/pt/instalment-plans')).json();
    expect(list.past_due_reminder).toMatchObject({ show: true, count: 1 });
    expect(list.past_due_reminder.message).toMatch(/Stripe Billing settings/);
    const mine = list.plans.find(p => p.booking_id === id);
    expect(mine).toMatchObject({ status: 'past_due', can_stop: true, paid_pence: 1000, remaining_pence: 2000 });
    expect(mine.payments[1]).toMatchObject({ seq: 2, status: 'failed', attempts: 2, next_retry_at: new Date(1900900000000).toISOString() });
    expect((await (await get(s.pt, '/api/pt/instalment-plans?status=past_due')).json()).plans.map(p => p.booking_id)).toEqual([id]);
    const dash = await (await get(s.pt, '/api/dashboard')).json();
    expect(dash.instalments).toMatchObject({ past_due_count: 1 });
    expect((await hook(evt('invoice.paid', { ...invoice(s, id, { sub, seq: 2 }), id: inv }, { account: s.account }))).status).toBe(200);
    expect((await bookingRow(id)).plan_status).toBe('active');
    expect((await (await get(s.pt, '/api/pt/instalment-plans')).json()).past_due_reminder).toMatchObject({ show: false, count: 0, message: null });
  });

  it('the last instalment ends billing: completed; with no schedule the end job cancels the subscription; overruns end it too', async () => {
    const { s, id, sub, completed } = await openPlanCheckout();
    // The schedule attach fails (Stripe 500): the job waits for the cron drain.
    let calls = mockStripe([['POST', /^\/v1\/subscription_schedules$/, () => json(500, { error: { message: 'fixture outage' } })], cancelRoute]);
    await hook(evt('invoice.paid', invoice(s, id, { sub, seq: 1, reason: 'subscription_create' }), { account: s.account }));
    expect((await hook(completed())).status).toBe(200);
    expect((await bookingRow(id)).stripe_schedule_id).toBeNull();
    expect((await hook(evt('invoice.paid', invoice(s, id, { sub, seq: 2 }), { account: s.account }))).status).toBe(200);
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0);
    expect((await hook(evt('invoice.paid', invoice(s, id, { sub, seq: 3 }), { account: s.account }))).status).toBe(200);
    const del = calls.filter(c => c.method === 'DELETE');
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({ path: '/v1/subscriptions/' + sub, account: s.account, idempotency: 'end:' + id });
    expect(await bookingRow(id)).toMatchObject({ status: 'paid', plan_status: 'completed' });
    expect((await instRows(id)).map(r => r.status)).toEqual(['paid', 'paid', 'paid']);
    // An invoice for payment 4 (beyond N) is recorded as an overrun and never marks anything paid.
    vi.restoreAllMocks();
    calls = mockStripe([cancelRoute]);
    expect((await hook(evt('invoice.created', { ...invoice(s, id, { sub, seq: 4 }), status: 'draft' }, { account: s.account }))).status).toBe(200);
    expect(await db().get("SELECT action FROM audit_log WHERE target_id=? AND action LIKE 'instalment_overrun:%'", id)).toEqual({ action: 'instalment_overrun:seq=4' });
    expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(0); // end job id 'end:<booking>' already done: no second cancel
    expect(await bookingRow(id)).toMatchObject({ plan_status: 'completed' });
  });

  it('cron drain retries a pending schedule job', async () => {
    const { s, id, sub, completed } = await openPlanCheckout();
    mockStripe([['POST', /^\/v1\/subscription_schedules$/, () => json(500, { error: { message: 'fixture outage' } })]]);
    await hook(evt('invoice.paid', invoice(s, id, { sub, seq: 1, reason: 'subscription_create' }), { account: s.account }));
    await hook(completed());
    expect((await db().get('SELECT status FROM stripe_jobs WHERE id=?', 'schedule:' + id)).status).toBe('retry');
    vi.restoreAllMocks();
    mockStripe(scheduleRoutes('sub_sched_DRAIN'));
    const out = await drainPlanJobs(stripeEnv(), db(), { limit: 100 });
    expect(out.ran).toBeGreaterThanOrEqual(1);
    expect((await bookingRow(id)).stripe_schedule_id).toBe('sub_sched_DRAIN');
    expect((await drainPlanJobs(stripeEnv({ PAYMENT_MODE: 'demo' }), db()))).toEqual({ ran: 0 });
  });
});

describe('stop (trainer only) and authz', () => {
  it('owning PT 200; same token idempotent; future payments void; nothing refunded; then PLAN_NOT_ACTIVE', async () => {
    const s = await planBlock();
    const { id, sub } = await planBooking(s, s.users[0].id, { count: 4, paid: 2, failed: [3], planStatus: 'past_due' });
    const calls = mockStripe([cancelRoute]);
    const token = crypto.randomUUID();
    const r = await call(s.pt, 'POST', `/api/pt/instalment-plans/${id}/stop`, { request_token: token });
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body).toMatchObject({ booking_id: id, status: 'stopped', voided_payments: 2, refunded_pence: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/v1/subscriptions/' + sub, account: s.account, idempotency: `stop:${id}:${token}` });
    expect(Object.keys(calls[0].body).some(k => /refund/.test(k))).toBe(false);
    const again = await call(s.pt, 'POST', `/api/pt/instalment-plans/${id}/stop`, { request_token: token });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ booking_id: id, status: 'stopped' });
    expect(calls).toHaveLength(1);
    expect((await instRows(id)).map(x => x.status)).toEqual(['paid', 'paid', 'void', 'void']);
    expect(await db().get('SELECT status,plan_status,refunded_pence FROM bookings WHERE id=?', id)).toEqual({ status: 'paid', plan_status: 'stopped', refunded_pence: 0 });
    const late = await call(s.pt, 'POST', `/api/pt/instalment-plans/${id}/stop`, { request_token: crypto.randomUUID() });
    expect([late.status, (await late.json()).code]).toEqual([409, 'PLAN_NOT_ACTIVE']);
    // A Stripe 404 (already cancelled) still stops the plan.
    const b2 = await planBooking(s, s.users[1].id, { count: 3 });
    vi.restoreAllMocks();
    mockStripe([['DELETE', /^\/v1\/subscriptions\//, () => json(404, { error: { message: 'No such subscription' } })]]);
    const r2 = await call(s.pt, 'POST', `/api/pt/instalment-plans/${b2.id}/stop`, { request_token: crypto.randomUUID() });
    expect(r2.status).toBe(200);
    expect((await r2.json()).status).toBe('stopped');
  });

  it('PM ruling: admin 403, customer 403, other PT 404, unauthenticated 401; no Stripe call', async () => {
    const s = await planBlock();
    const other = await planBlock({ customers: 0 });
    const admin = await seedUser({ role: 'admin' });
    const { id } = await planBooking(s, s.users[0].id);
    const calls = mockStripe([cancelRoute]);
    const stop = async user => { const r = await call(user, 'POST', `/api/pt/instalment-plans/${id}/stop`, { request_token: crypto.randomUUID() }); return [r.status, (await r.json()).code]; };
    expect(await stop(admin)).toEqual([403, 'FORBIDDEN']);
    expect(await stop(s.users[0])).toEqual([403, 'FORBIDDEN']);
    expect(await stop(other.pt)).toEqual([404, 'NOT_FOUND']);
    expect(await stop(null)).toEqual([401, 'UNAUTHENTICATED']);
    expect(calls).toHaveLength(0);
    expect((await bookingRow(id)).plan_status).toBe('active');
  });

  it('list and booking read: PT own only with can_stop; admin sees all with can_stop false; customer 403 on list, no can_stop on read', async () => {
    const s = await planBlock();
    const other = await planBlock({ customers: 0 });
    const admin = await seedUser({ role: 'admin' });
    const { id } = await planBooking(s, s.users[0].id, { count: 4, amount: 1000, paid: 1 });
    const ptList = await (await get(s.pt, '/api/pt/instalment-plans')).json();
    expect(ptList.plans.map(p => p.booking_id)).toEqual([id]);
    expect(ptList.plans[0]).toMatchObject({ plan: 'weekly', status: 'active', count: 4, can_stop: true, total_pence: 4000, today_pence: 1000, paid_pence: 1000, remaining_pence: 3000 });
    expect((await (await get(other.pt, '/api/pt/instalment-plans')).json()).plans.map(p => p.booking_id)).not.toContain(id);
    const adminList = await (await get(admin, '/api/pt/instalment-plans')).json();
    expect(adminList.plans.find(p => p.booking_id === id)).toMatchObject({ can_stop: false });
    const cust = await get(s.users[0], '/api/pt/instalment-plans');
    expect([cust.status, (await cust.json()).code]).toEqual([403, 'FORBIDDEN']);
    expect((await get(s.pt, '/api/pt/instalment-plans?status=bogus')).status).toBe(400);
    // C4 booking read.
    const read = async user => (await (await get(user, '/api/bookings/' + id)).json()).booking;
    const c = await read(s.users[0]);
    expect(c.instalment_plan).toMatchObject({ plan: 'weekly', status: 'active', total_pence: 4000, today_pence: 1000, list_total_pence: 4000, discount_pence: 0 });
    expect(c.instalment_plan.payments).toHaveLength(4);
    expect(c.instalment_plan).not.toHaveProperty('can_stop');
    expect((await read(s.pt)).instalment_plan.can_stop).toBe(true);
    expect((await read(admin)).instalment_plan.can_stop).toBe(false);
    expect((await get(s.users[1], '/api/bookings/' + id)).status).toBe(404);
    // An upfront booking has no instalment_plan.
    const up = await insertBooking({ blockId: s.blockId, customerId: s.users[2].id });
    expect((await (await get(s.users[2], '/api/bookings/' + up)).json()).booking).not.toHaveProperty('instalment_plan');
  });
});
