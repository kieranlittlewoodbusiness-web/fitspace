// RC-5: Stripe Connect onboarding. fetch is mocked; no test contacts Stripe or Cloudflare.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../worker/index.mjs';
import { accountSnapshot, connectState, connectStatusView, parseRequirements } from '../src/connect-status.mjs';
import { prepareConnect, prepareCheckout, prepareLink, completeJob } from '../src/ops/stripe-jobs.mjs';
import { db, seedBlock, seedUser, insertBooking, jsonRequest, getRequest, signedWebhook, ORIGIN, tally } from './helpers.mjs';
import nodeCrypto from 'node:crypto';

const overlay = (over = {}) => Object.assign(Object.create(null), env, { PAYMENT_MODE: 'stripe_test', STRIPE_INTEGRATION: 'connect' }, over);
const single = (over = {}) => overlay({ MULTI_PT_ENABLED: 'false', ...over });
const multi = (over = {}) => overlay({ MULTI_PT_ENABLED: 'true', ...over });
const call = (user, method, path, body, e = single()) => worker.fetch(jsonRequest(user, method, path, body), e);
const jsonOf = async res => { const text = await res.text(); try { return JSON.parse(text); } catch { return { raw: text }; } };
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function mockStripe(routes) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    const info = { method, path: url.pathname + url.search, idempotency: headers.get('Idempotency-Key'), account: headers.get('Stripe-Account'), auth: headers.get('Authorization'), body: init.body };
    calls.push(info);
    if (url.origin !== 'https://api.stripe.com') throw new Error('unexpected host in test: ' + url.origin);
    for (const [m, re, fn] of routes) if (m === method && re.test(url.pathname)) return fn(info);
    return json(404, { error: { message: 'no mock' } });
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await db().batch([
    db().stmt('DELETE FROM stripe_jobs'),
    db().stmt('DELETE FROM stripe_connections'),
    db().stmt('DELETE FROM webhook_events'),
    db().stmt('UPDATE pts SET stripe_account=NULL, stripe_ready=0')
  ]);
});

describe('connect state machine', () => {
  it('maps stored snapshots to the five dashboard states', () => {
    expect(connectState(null)).toBe('not_connected');
    expect(connectState({})).toBe('not_connected');
    expect(connectState({ account_id: 'acct_1', details_submitted: 0, charges_enabled: 0, requirements: '{}' })).toBe('onboarding_incomplete');
    expect(connectState({ account_id: 'acct_1', details_submitted: 1, charges_enabled: 0, requirements: { currently_due: [], past_due: [] } })).toBe('pending');
    expect(connectState({ account_id: 'acct_1', details_submitted: 1, charges_enabled: 1, requirements: { currently_due: [], past_due: [] } })).toBe('active');
    expect(connectState({ account_id: 'acct_1', details_submitted: 1, charges_enabled: 1, requirements: { disabled_reason: 'rejected.listed' } })).toBe('restricted');
    expect(connectState({ account_id: 'acct_1', details_submitted: 1, charges_enabled: 0, requirements: { past_due: ['external_account'] } })).toBe('restricted');
  });

  it('parses v1 and v2 account shapes into the same snapshot', () => {
    expect(accountSnapshot({
      id: 'acct_v1', charges_enabled: true, payouts_enabled: false, details_submitted: true,
      requirements: { currently_due: [], past_due: ['tax_id'], disabled_reason: null }
    })).toMatchObject({ charges_enabled: true, payouts_enabled: false, details_submitted: true, ready: true, requirements: { past_due: ['tax_id'], disabled_reason: null } });
    expect(accountSnapshot({
      id: 'acct_v2', livemode: false,
      configuration: { merchant: { capabilities: { card_payments: { status: 'active' }, transfers: { status: 'pending' } }, requirements: { currently_due: ['individual.verification'] } } }
    })).toMatchObject({ charges_enabled: true, payouts_enabled: false, ready: true, requirements: { currently_due: ['individual.verification'] } });
  });

  it('exposes currently_due, past_due and disabled_reason on the view', () => {
    const view = connectStatusView({
      account_id: 'acct_x', routing: 'connected', ready: 0, charges_enabled: 0, payouts_enabled: 0, details_submitted: 1,
      requirements: JSON.stringify({ currently_due: ['dob'], past_due: [], disabled_reason: null })
    }, { mode: 'stripe_test' });
    expect(view).toMatchObject({ state: 'pending', mode: 'stripe_test', requirements: { currently_due: ['dob'], past_due: [], disabled_reason: null } });
    expect(parseRequirements('not-json')).toEqual({ currently_due: [], past_due: [], disabled_reason: null });
  });
});

describe('Connect Stripe action (mocked Stripe)', () => {
  it('creates one account, returns a hosted onboarding url, and sets return/refresh dashboard URLs', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const acct = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
    const calls = mockStripe([
      ['POST', /^\/v2\/core\/accounts$/, () => json(200, { id: acct, livemode: false })],
      ['POST', /^\/v2\/core\/account_links$/, info => json(200, { url: 'https://connect.stripe.com/setup/first', livemode: false, echoed: info.body })]
    ]);
    const r = await call(pt, 'POST', '/api/pt/stripe/connect');
    const body = await jsonOf(r);
    expect(r.status).toBe(200);
    expect(body.url).toBe('https://connect.stripe.com/setup/first');
    expect(body.error).toBeUndefined();
    expect((await db().get("SELECT account_id,routing,ready FROM stripe_connections WHERE pt_id=?", s.ptId))).toEqual({ account_id: acct, routing: 'connected', ready: 0 });
    expect(calls[0].idempotency).toBe('account:' + s.ptId);
    const link = JSON.parse(calls[1].body);
    expect(link.use_case.account_onboarding.refresh_url).toBe('https://example.test/dashboard?tab=payments&connect=refresh');
    expect(link.use_case.account_onboarding.return_url).toBe('https://example.test/dashboard?tab=payments&connect=return');
  });

  it('refresh mints a new onboarding link without creating a second account', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const acct = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
    let n = 0;
    mockStripe([
      ['POST', /^\/v2\/core\/accounts$/, () => json(200, { id: acct, livemode: false })],
      ['POST', /^\/v2\/core\/account_links$/, () => json(200, { url: 'https://connect.stripe.com/setup/' + (++n), livemode: false })]
    ]);
    const first = await jsonOf(await call(pt, 'POST', '/api/pt/stripe/connect'));
    const second = await jsonOf(await call(pt, 'POST', '/api/pt/stripe/connect'));
    expect(first.url).toBe('https://connect.stripe.com/setup/1');
    expect(second.url).toBe('https://connect.stripe.com/setup/2');
    expect(first.url).not.toBe(second.url);
    expect((await db().all("SELECT id FROM stripe_jobs WHERE kind='account' AND target_id=?", s.ptId))).toHaveLength(1);
    expect((await db().all("SELECT id FROM stripe_jobs WHERE kind='onboard' AND target_id=?", s.ptId))).toHaveLength(2);
    expect((await db().all('SELECT account_id FROM stripe_connections WHERE pt_id=?', s.ptId))).toEqual([{ account_id: acct }]);
  });

  it('five concurrent first-time Connect posts create one account and share the idempotency key', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const acct = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
    const calls = mockStripe([
      ['POST', /^\/v2\/core\/accounts$/, async () => { await new Promise(r => setTimeout(r, 20)); return json(200, { id: acct, livemode: false }); }],
      ['POST', /^\/v2\/core\/account_links$/, () => json(200, { url: 'https://connect.stripe.com/setup/concurrent', livemode: false })]
    ]);
    const results = await Promise.all(Array.from({ length: 5 }, () => call(pt, 'POST', '/api/pt/stripe/connect')));
    const bodies = await Promise.all(results.map(jsonOf));
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(new Set(bodies.map(b => b.url))).toEqual(new Set(['https://connect.stripe.com/setup/concurrent']));
    expect((await db().all('SELECT account_id FROM stripe_connections WHERE pt_id=?', s.ptId))).toEqual([{ account_id: acct }]);
    const accountCalls = calls.filter(c => c.path === '/v2/core/accounts');
    expect(accountCalls.length).toBeGreaterThanOrEqual(1);
    expect(new Set(accountCalls.map(c => c.idempotency))).toEqual(new Set(['account:' + s.ptId]));
  });
});

describe('authz, readiness and error codes', () => {
  it('only the PT owner or admin can connect or refresh status; every error has a code', async () => {
    const s = await seedBlock({ customers: 1 });
    const other = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const otherPt = await seedUser({ role: 'pt', ptId: other.ptId });
    const admin = await seedUser({ role: 'admin' });
    mockStripe([
      ['POST', /^\/v2\/core\/accounts$/, () => json(200, { id: 'acct_test_auth', livemode: false })],
      ['POST', /^\/v2\/core\/account_links$/, () => json(200, { url: 'https://connect.stripe.com/setup/auth', livemode: false })]
    ]);
    const customer = await jsonOf(await call(s.users[0], 'POST', '/api/pt/stripe/connect'));
    expect(customer).toMatchObject({ error: 'Your account does not have access to this action.', code: 'FORBIDDEN' });
    const cross = await jsonOf(await call(otherPt, 'POST', '/api/pt/stripe/connect', { pt_id: s.ptId }));
    expect(cross).toMatchObject({ code: 'FORBIDDEN' });
    const owner = await call(pt, 'POST', '/api/pt/stripe/connect');
    expect(owner.status).toBe(200);
    const adminRes = await call(admin, 'POST', '/api/pt/stripe/connect', { pt_id: s.ptId });
    expect(adminRes.status).toBe(200);
    const anon = await jsonOf(await worker.fetch(new Request(ORIGIN + '/api/pt/stripe/connect', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' }), single()));
    expect(anon).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('readiness fails closed with PAYMENTS_NOT_READY before any write or Stripe call', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const calls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      calls.push(String(typeof input === 'string' ? input : input.url));
      return json(404, { error: { message: 'no mock' } });
    });
    const r = await call(pt, 'POST', '/api/pt/stripe/connect', {}, single({ STRIPE_WEBHOOK_SECRET: undefined }));
    expect(r.status).toBe(503);
    expect(await jsonOf(r)).toMatchObject({ code: 'PAYMENTS_NOT_READY' });
    expect(calls).toEqual([]);
    expect((await db().get('SELECT count(*) n FROM stripe_jobs')).n).toBe(0);
  });
});

describe('status refresh and dashboard snapshot', () => {
  it('persists charges, payouts, requirements and returns the matching state', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const admin = await seedUser({ role: 'admin' });
    const acct = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
    await db().run("INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready,details_submitted) VALUES(?,'stripe_test',?,'connected',0,0)", s.ptId, acct);
    mockStripe([
      ['GET', /^\/v2\/core\/accounts\//, () => json(200, {
        id: acct, livemode: false,
        configuration: { merchant: { capabilities: { card_payments: { status: 'active' }, transfers: { status: 'active' } }, requirements: { currently_due: [], past_due: [], disabled_reason: null } } },
        charges_enabled: true, payouts_enabled: true, details_submitted: true
      })]
    ]);
    const refreshed = await jsonOf(await call(pt, 'POST', '/api/pt/stripe/status'));
    expect(refreshed).toMatchObject({
      state: 'active', account_id: acct, routing: 'connected', ready: true,
      charges_enabled: true, payouts_enabled: true, details_submitted: true,
      requirements: { currently_due: [], past_due: [], disabled_reason: null }, mode: 'stripe_test'
    });
    const row = await db().get('SELECT ready,charges_enabled,payouts_enabled,details_submitted FROM stripe_connections WHERE pt_id=?', s.ptId);
    expect(row).toEqual({ ready: 1, charges_enabled: 1, payouts_enabled: 1, details_submitted: 1 });
    const dash = await jsonOf(await worker.fetch(getRequest(pt, '/api/dashboard'), single()));
    expect(dash.pt.stripe).toMatchObject({ state: 'active', account_id: acct, charges_enabled: true });
    const setup = await jsonOf(await worker.fetch(getRequest(pt, '/api/pt/stripe/setup'), single()));
    expect(setup).toMatchObject({ state: 'active', account_id: acct });
    const adminDash = await jsonOf(await worker.fetch(getRequest(admin, '/api/dashboard'), single()));
    const listed = adminDash.pts.find(p => p.id === s.ptId);
    expect(listed.stripe.state).toBe('active');
  });

  it('returns not_connected without calling Stripe when no account is linked', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const calls = mockStripe([]);
    const body = await jsonOf(await call(pt, 'POST', '/api/pt/stripe/status'));
    expect(body).toMatchObject({ state: 'not_connected', account_id: null, ready: false, charges_enabled: false });
    expect(calls).toEqual([]);
  });
});

describe('account.updated dedupe and ordering', () => {
  async function bind(ptId, acct) {
    await db().batch([
      db().stmt("INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready,updated_at) VALUES(?,'stripe_test',?,'connected',0,0)", ptId, acct),
      db().stmt('UPDATE pts SET stripe_account=? WHERE id=?', acct, ptId)
    ]);
  }
  const event = (acct, created, over = {}) => ({
    id: 'evt_' + nodeCrypto.randomBytes(6).toString('hex'), type: 'account.updated', created, livemode: false, account: acct,
    data: { object: { id: acct, object: 'account', livemode: false, charges_enabled: over.charges ?? false, payouts_enabled: over.payouts ?? false, details_submitted: over.details ?? true, requirements: over.requirements ?? { currently_due: [], past_due: [], disabled_reason: over.disabled || null } } }
  });

  it('applies a newer event, ignores a stale one, and stores requirements used for state', async () => {
    const { ptId } = await seedBlock({ customers: 0 });
    const acct = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
    await bind(ptId, acct);
    const newer = event(acct, 4000, { charges: true, payouts: true, details: true });
    const stale = event(acct, 1000, { charges: false, details: true, disabled: 'listed', requirements: { currently_due: [], past_due: ['external_account'], disabled_reason: 'listed' } });
    expect((await worker.fetch(signedWebhook(newer)(), single())).status).toBe(200);
    expect((await worker.fetch(signedWebhook(stale)(), single())).status).toBe(200);
    const row = await db().get('SELECT account_id,ready,charges_enabled,payouts_enabled,details_submitted,updated_at,requirements FROM stripe_connections WHERE pt_id=?', ptId);
    expect(row).toMatchObject({ account_id: acct, ready: 1, charges_enabled: 1, payouts_enabled: 1, updated_at: 4000000 });
    expect(connectState(row)).toBe('active');
  });

  it('the same account.updated delivered five times concurrently is applied once', async () => {
    const { ptId } = await seedBlock({ customers: 0 });
    const acct = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
    await bind(ptId, acct);
    const ev = event(acct, 5000, { charges: true, payouts: true, details: true });
    const hook = signedWebhook(ev);
    const results = await Promise.all(Array.from({ length: 5 }, () => worker.fetch(hook(), single()).then(async r => ({ status: r.status, body: await jsonOf(r) }))));
    expect(tally(results.map(r => r.body.received ? 'received' : r.body.duplicate ? 'duplicate' : 'other'))).toEqual({ received: 1, duplicate: 4 });
    expect((await db().all('SELECT id FROM webhook_events')).filter(x => x.id === ev.id || x.id.endsWith(ev.id)).length).toBeGreaterThanOrEqual(1);
    expect((await db().get('SELECT ready,charges_enabled FROM stripe_connections WHERE pt_id=?', ptId))).toEqual({ ready: 1, charges_enabled: 1 });
  });
});

describe('single_connect guard and direct charges', () => {
  it('blocks a second Connect account when MULTI_PT_ENABLED is not true, and disables platform link', async () => {
    const a = await seedBlock({ customers: 0, blockId: 'rc5-a' });
    const b = await seedBlock({ customers: 0, blockId: 'rc5-b' });
    const ptA = await seedUser({ role: 'pt', ptId: a.ptId });
    const ptB = await seedUser({ role: 'pt', ptId: b.ptId });
    const admin = await seedUser({ role: 'admin' });
    const jobA = await prepareConnect(db(), { userId: ptA.id, origin: ORIGIN, mode: 'stripe_test', multiPt: false });
    const jobB = await prepareConnect(db(), { userId: ptB.id, origin: ORIGIN, mode: 'stripe_test', multiPt: false });
    await completeJob(db(), { id: jobA, result: { id: 'acct_test_one' } });
    await expect(completeJob(db(), { id: jobB, result: { id: 'acct_test_two' } })).rejects.toMatchObject({ status: 409, code: 'SINGLE_CONNECT_EXISTS' });
    expect(await db().all('SELECT account_id FROM stripe_connections')).toEqual([{ account_id: 'acct_test_one' }]);
    await expect(prepareConnect(db(), { userId: ptB.id, origin: ORIGIN, mode: 'stripe_test', multiPt: false })).rejects.toMatchObject({ status: 409, code: 'SINGLE_CONNECT_EXISTS' });
    await expect(prepareLink(db(), { userId: admin.id, ptId: a.ptId, mode: 'stripe_test', multiPt: false })).rejects.toMatchObject({ status: 409, code: 'PLATFORM_LINK_DISABLED' });
    const allowed = await prepareLink(db(), { userId: admin.id, ptId: b.ptId, mode: 'stripe_test', multiPt: true });
    expect(allowed).toMatch(/^link:/);
  });

  it('checkout is a direct charge on the connected account with no application fee', async () => {
    await db().run('DELETE FROM stripe_jobs');
    await db().run('DELETE FROM stripe_connections');
    const s = await seedBlock({ customers: 1 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const job = await prepareConnect(db(), { userId: pt.id, origin: ORIGIN, mode: 'stripe_test', multiPt: false });
    await completeJob(db(), { id: job, result: { id: 'acct_test_direct' } });
    await db().run("UPDATE stripe_connections SET ready=1 WHERE pt_id=? AND mode='stripe_test'", s.ptId);
    const bk = await insertBooking({
      blockId: s.blockId, customerId: s.users[0].id, status: 'pending', mode: 'stripe_test',
      extra: { stripe_account_id: 'acct_test_direct', stripe_routing: 'connected' }
    });
    const checkoutId = await prepareCheckout(db(), { bookingId: bk, userId: s.users[0].id, origin: ORIGIN, mode: 'stripe_test' });
    const payload = JSON.parse((await db().get('SELECT payload FROM stripe_jobs WHERE id=?', checkoutId)).payload);
    expect(payload.account).toBe('acct_test_direct');
    expect(JSON.stringify(payload)).not.toMatch(/application_fee/);
  });
});
