// RC-32: a failed Connect account job can be retried with a fresh job id and Idempotency-Key;
// pending jobs still dedupe; Stripe errors are logged redacted; platform-setup errors map to a
// fixed PT message. fetch is mocked; no test contacts Stripe.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../worker/index.mjs';
import { accountJobId } from '../src/ops/stripe-jobs.mjs';
import { PLATFORM_NOT_READY, platformNotReady, redactStripeText, stripeErrorLog } from '../src/stripe.mjs';
import { db, seedBlock, seedUser, jsonRequest } from './helpers.mjs';
import nodeCrypto from 'node:crypto';

const e = (over = {}) => Object.assign(Object.create(null), env, { PAYMENT_MODE: 'stripe_test', STRIPE_INTEGRATION: 'connect', MULTI_PT_ENABLED: 'false' }, over);
const call = (user, path, body) => worker.fetch(jsonRequest(user, 'POST', path, body), e());
const jsonOf = async res => JSON.parse(await res.text());
const json = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const PLATFORM_MSG = 'Please review the responsibilities of managing losses for connected accounts at https://dashboard.stripe.com/settings/connect/platform-profile.';

function mockStripe(handler) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== 'https://api.stripe.com') throw new Error('unexpected host in test: ' + url.origin);
    const info = { method: init.method || 'GET', path: url.pathname, idempotency: new Headers(init.headers).get('Idempotency-Key') };
    calls.push(info);
    return handler(info, calls);
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await db().batch([db().stmt('DELETE FROM stripe_jobs'), db().stmt('DELETE FROM stripe_connections'), db().stmt('UPDATE pts SET stripe_account=NULL, stripe_ready=0')]);
});

describe('RC-32 Connect retry after a failed account job', () => {
  it('a failed attempt is followed by a new job with a new idempotency key, and the retry succeeds', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const acct = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
    let failNext = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = mockStripe(info => {
      if (info.path === '/v2/core/accounts') {
        if (failNext) { failNext = false; return json(400, { error: { type: 'invalid_request_error', message: PLATFORM_MSG } }, { 'request-id': 'req_rc32fail' }); }
        return json(200, { id: acct, livemode: false });
      }
      return json(200, { url: 'https://connect.stripe.com/setup/rc32', livemode: false });
    });
    const first = await call(pt, '/api/pt/stripe/connect');
    const firstBody = await jsonOf(first);
    expect(first.status).toBe(409);
    expect(firstBody).toMatchObject({ error: PLATFORM_NOT_READY, code: 'STRIPE_PLATFORM_NOT_READY' });
    expect(errorSpy).toHaveBeenCalled();

    const second = await call(pt, '/api/pt/stripe/connect');
    expect(second.status).toBe(200);
    expect((await jsonOf(second)).url).toBe('https://connect.stripe.com/setup/rc32');

    const accountCalls = calls.filter(c => c.path === '/v2/core/accounts');
    expect(accountCalls).toHaveLength(2);
    expect(accountCalls[0].idempotency).toBe('account:' + s.ptId);
    expect(accountCalls[1].idempotency).toMatch(new RegExp('^account:' + s.ptId + ':[0-9a-f-]{36}$'));
    const jobs = await db().all("SELECT id,status FROM stripe_jobs WHERE kind='account' AND target_id=? ORDER BY created_at", s.ptId);
    expect(jobs.map(j => j.status)).toEqual(['failed', 'done']);
    expect(jobs[1].id).toBe(accountCalls[1].idempotency);
    expect(await db().get('SELECT account_id FROM stripe_connections WHERE pt_id=?', s.ptId)).toEqual({ account_id: acct });

    // A third tap now uses the stored connection (onboarding link), not a third account job.
    await call(pt, '/api/pt/stripe/connect');
    expect(calls.filter(c => c.path === '/v2/core/accounts')).toHaveLength(2);
  });

  it('a pending or retrying account job is still reused (double taps share one job and key)', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const base = 'account:' + s.ptId;
    expect(await accountJobId(db(), s.ptId, 'stripe_test')).toBe(base);
    await db().run("INSERT INTO stripe_jobs(id,kind,target_id,actor_id,payload,created_at) VALUES(?,?,?,?,?,?)", base, 'account', s.ptId, pt.id, '{}', Date.now() - 1000);
    expect(await accountJobId(db(), s.ptId, 'stripe_test')).toBe(base);
    await db().run("UPDATE stripe_jobs SET status='retry' WHERE id=?", base);
    expect(await accountJobId(db(), s.ptId, 'stripe_test')).toBe(base);
    await db().run("UPDATE stripe_jobs SET status='failed' WHERE id=?", base);
    const fresh = await accountJobId(db(), s.ptId, 'stripe_test');
    expect(fresh).toMatch(new RegExp('^' + base + ':'));
    await db().run("INSERT INTO stripe_jobs(id,kind,target_id,actor_id,payload,created_at) VALUES(?,?,?,?,?,?)", fresh, 'account', s.ptId, pt.id, '{}', Date.now());
    expect(await accountJobId(db(), s.ptId, 'stripe_test')).toBe(fresh);
    // Live mode keeps its own namespace.
    expect(await accountJobId(db(), s.ptId, 'stripe_live')).toBe('account:live:' + s.ptId);
  });

  it('five concurrent taps after a failure create exactly one new job and one Stripe account call', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    await db().run("INSERT INTO stripe_jobs(id,kind,target_id,actor_id,payload,status,last_error,created_at) VALUES(?,?,?,?,?,?,?,?)", 'account:' + s.ptId, 'account', s.ptId, pt.id, JSON.stringify({ mode: 'stripe_test' }), 'failed', 'old', Date.now() - 5000);
    const acct = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
    const calls = mockStripe(async info => {
      if (info.path === '/v2/core/accounts') { await new Promise(r => setTimeout(r, 20)); return json(200, { id: acct, livemode: false }); }
      return json(200, { url: 'https://connect.stripe.com/setup/c', livemode: false });
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => call(pt, '/api/pt/stripe/connect')));
    expect(results.every(r => r.status === 200)).toBe(true);
    const keys = new Set(calls.filter(c => c.path === '/v2/core/accounts').map(c => c.idempotency));
    expect(keys.size).toBe(1);
    const jobs = await db().all("SELECT id,status FROM stripe_jobs WHERE kind='account' AND target_id=?", s.ptId);
    expect(jobs).toHaveLength(2);
    expect(jobs.filter(j => j.status === 'done')).toHaveLength(1);
  });
});

describe('RC-32 M1/m2: a created account is never duplicated', () => {
  // Stripe idempotency model: the same key replays the same account; a new key creates a new one.
  function idempotentAccounts() {
    const byKey = new Map();
    const calls = mockStripe(info => {
      if (info.path === '/v2/core/accounts') {
        if (!byKey.has(info.idempotency)) byKey.set(info.idempotency, 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex'));
        return json(200, { id: byKey.get(info.idempotency), livemode: false });
      }
      return json(200, { url: 'https://connect.stripe.com/setup/m1', livemode: false });
    });
    return { calls, byKey };
  }

  it('M1: if completeJob fails after Stripe created the account, the retry reuses the key and binds the same acct_', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const { calls, byKey } = idempotentAccounts();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await db().run("CREATE TRIGGER rc32_fail_done BEFORE UPDATE OF status ON stripe_jobs WHEN NEW.status='done' AND OLD.kind='account' BEGIN SELECT RAISE(ABORT, 'rc32 simulated done-update failure'); END");
    let first;
    try { first = await call(pt, '/api/pt/stripe/connect'); } finally { await db().run('DROP TRIGGER IF EXISTS rc32_fail_done'); }
    expect(first.status).toBeGreaterThanOrEqual(500);
    const job = await db().get("SELECT id,status FROM stripe_jobs WHERE kind='account' AND target_id=?", s.ptId);
    expect(job.status).toBe('retry');
    expect(await db().get('SELECT account_id FROM stripe_connections WHERE pt_id=?', s.ptId)).toBeNull();

    const second = await call(pt, '/api/pt/stripe/connect');
    expect(second.status).toBe(200);
    const accountCalls = calls.filter(c => c.path === '/v2/core/accounts');
    expect(accountCalls).toHaveLength(2);
    expect(new Set(accountCalls.map(c => c.idempotency))).toEqual(new Set([job.id]));
    expect(byKey.size).toBe(1);
    expect(await db().get('SELECT account_id FROM stripe_connections WHERE pt_id=?', s.ptId)).toEqual({ account_id: byKey.get(job.id) });
    expect((await db().all("SELECT id FROM stripe_jobs WHERE kind='account' AND target_id=?", s.ptId))).toHaveLength(1);
  });

  it('M1: a post-create check failure (livemode mismatch) stays retryable on the same key', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    let n = 0;
    const calls = mockStripe(info => info.path === '/v2/core/accounts'
      ? json(200, { id: 'acct_test_same', livemode: ++n === 1 })
      : json(200, { url: 'https://connect.stripe.com/setup/m1b', livemode: false }));
    const first = await call(pt, '/api/pt/stripe/connect');
    expect(first.status).toBe(403); // 'Stripe response payment mode mismatch.' from the shared client
    expect((await db().get("SELECT status FROM stripe_jobs WHERE kind='account' AND target_id=?", s.ptId)).status).toBe('retry');
    expect((await call(pt, '/api/pt/stripe/connect')).status).toBe(200);
    const keys = calls.filter(c => c.path === '/v2/core/accounts').map(c => c.idempotency);
    expect(new Set(keys)).toEqual(new Set(['account:' + s.ptId]));
    expect(await db().get('SELECT account_id FROM stripe_connections WHERE pt_id=?', s.ptId)).toEqual({ account_id: 'acct_test_same' });
  });

  it('m2: a stale (30 h old) pending account job is retried with the same key instead of blocking', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    let fail = true;
    const calls = mockStripe(info => {
      if (info.path === '/v2/core/accounts') {
        if (fail) { fail = false; return json(503, { error: { type: 'api_error', message: 'try later' } }); }
        return json(200, { id: 'acct_test_stale', livemode: false });
      }
      return json(200, { url: 'https://connect.stripe.com/setup/m2', livemode: false });
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call(pt, '/api/pt/stripe/connect')).status).toBe(503);
    const job = await db().get("SELECT id,status FROM stripe_jobs WHERE kind='account' AND target_id=?", s.ptId);
    expect(job.status).toBe('retry');
    await db().run('UPDATE stripe_jobs SET created_at=? WHERE id=?', Date.now() - 30 * 3600000, job.id);
    const second = await call(pt, '/api/pt/stripe/connect');
    expect(second.status).toBe(200);
    const keys = calls.filter(c => c.path === '/v2/core/accounts').map(c => c.idempotency);
    expect(keys).toEqual([job.id, job.id]);
    expect(await db().get('SELECT account_id FROM stripe_connections WHERE pt_id=?', s.ptId)).toEqual({ account_id: 'acct_test_stale' });
  });
});

describe('RC-32 v2 Connect request shapes (2026-09-30.endive)', () => {
  it('POST /v2/core/account_links sends exactly account + use_case.account_onboarding{refresh_url, return_url, collection_options}', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const bodies = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.origin !== 'https://api.stripe.com') throw new Error('unexpected host in test: ' + url.origin);
      if (url.pathname === '/v2/core/account_links') { bodies.push(JSON.parse(init.body)); return json(200, { url: 'https://connect.stripe.com/setup/shape', livemode: false }); }
      return json(200, { id: 'acct_test_shape', livemode: false });
    });
    expect((await call(pt, '/api/pt/stripe/connect')).status).toBe(200);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      account: 'acct_test_shape',
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          refresh_url: 'https://example.test/dashboard?tab=payments&connect=refresh',
          return_url: 'https://example.test/dashboard?tab=payments&connect=return',
          collection_options: { fields: 'eventually_due' }
        }
      }
    });
    expect(JSON.stringify(bodies[0])).not.toContain('configurations');
  });
});

describe('RC-32 v2 account retrieve (status)', () => {
  it('GET /v2/core/accounts/{id} uses the indexed include form include[0]=configuration.merchant', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const acct = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
    await db().run("INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready) VALUES(?,?,?,?,0)", s.ptId, 'stripe_test', acct, 'connected');
    const urls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (!url.startsWith('https://api.stripe.com/')) throw new Error('unexpected host in test: ' + url);
      urls.push({ url, method: init.method || 'GET' });
      return json(200, { id: acct, livemode: false, configuration: { merchant: { capabilities: { card_payments: { status: 'pending' } } } } });
    });
    expect((await call(pt, '/api/pt/stripe/status')).status).toBe(200);
    expect(urls).toEqual([{ url: 'https://api.stripe.com/v2/core/accounts/' + acct + '?include[0]=configuration.merchant', method: 'GET' }]);
  });
});

describe('RC-32 Stripe error logging and PT message', () => {
  it('redacts account ids, emails and keys, and keeps type, code and request id', () => {
    const response = new Response('{}', { status: 400, headers: { 'request-id': 'req_abc123' } });
    const log = stripeErrorLog(response, { error: { type: 'invalid_request_error', code: 'parameter_invalid', message: 'acct_1AbCdEfGhIjK for coach@example.com with rk_live_SECRETVALUE123 and whsec_abcdef' } }, '/v1/accounts/acct_1ZyXwVuTs?x=1');
    expect(log).toEqual({ status: 400, path: '/v1/accounts/acct_1ZyX…', type: 'invalid_request_error', code: 'parameter_invalid', message: 'acct_1AbC… for [email] with rk_live_[redacted] and whsec_[redacted]', request_id: 'req_abc123' });
    const text = JSON.stringify(log);
    for (const leak of ['coach@example.com', 'SECRETVALUE', 'EfGhIjK', 'abcdef']) expect(text).not.toContain(leak);
    expect(redactStripeText('sk_test_abc123')).toBe('sk_test_[redacted]');
    // Nit 2: client secrets.
    const masked = redactStripeText('pi_3Abc123_secret_XyZ987 and seti_1Q2w_secret_Zz9');
    expect(masked).toBe('pi_[redacted]_secret_[redacted] and seti_[redacted]_secret_[redacted]');
    expect(masked).not.toMatch(/XyZ987|Zz9|3Abc123/);
  });

  it('the logged line for a real failed call never contains the key', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const lines = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => lines.push(args.join(' ')));
    mockStripe(() => json(400, { error: { type: 'invalid_request_error', message: 'Invalid email ' + 'pt@example.com' } }, { 'request-id': 'req_x1' }));
    const res = await call(pt, '/api/pt/stripe/connect');
    const body = await jsonOf(res);
    expect(res.status).toBe(409);
    expect(body.error).toBe('Stripe could not complete this action. Check the Stripe account setup and retry.');
    const line = lines.find(l => l.includes('Stripe API error'));
    expect(line).toContain('req_x1');
    expect(line).toContain('[email]');
    expect(line).not.toContain('pt@example.com');
    if (env.STRIPE_SECRET_KEY) expect(line).not.toContain(env.STRIPE_SECRET_KEY);
    expect(line).not.toMatch(/(sk|rk)_(live|test)_[A-Za-z0-9]/);
  });

  it('maps only platform-setup 400s to the fixed message', () => {
    expect(platformNotReady(400, { error: { type: 'invalid_request_error', message: PLATFORM_MSG } }, '/v2/core/accounts')).toBe(true);
    expect(platformNotReady(400, { error: { type: 'invalid_request_error', message: "You can only create new accounts if you've signed up for Connect, which you can learn how to do at https://stripe.com/docs/connect." } }, '/v2/core/accounts')).toBe(true);
    // Nit 3: scoped to account creation; checkout/refund 400s with similar wording stay generic.
    expect(platformNotReady(400, { error: { type: 'invalid_request_error', message: PLATFORM_MSG } }, '/v1/checkout/sessions')).toBe(false);
    expect(platformNotReady(400, { error: { type: 'invalid_request_error', message: PLATFORM_MSG } }, '/v1/refunds')).toBe(false);
    expect(platformNotReady(400, { error: { type: 'invalid_request_error', message: PLATFORM_MSG } })).toBe(false);
    expect(platformNotReady(400, { error: { type: 'invalid_request_error', message: 'Invalid email address: x@example.com' } })).toBe(false);
    expect(platformNotReady(403, { error: { type: 'invalid_request_error', message: PLATFORM_MSG } })).toBe(false);
    expect(platformNotReady(500, { error: { type: 'api_error', message: PLATFORM_MSG } })).toBe(false);
    expect(platformNotReady(400, null)).toBe(false);
    expect(PLATFORM_NOT_READY).toBe("Stripe Connect isn't set up on the platform yet. Ask the site owner to finish Stripe setup.");
  });
});
