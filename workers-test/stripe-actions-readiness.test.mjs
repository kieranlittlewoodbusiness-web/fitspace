// QA D1 (fitspace #4 @ f978692): Stripe ACTION routes under the legacy "diagnostic" prefixes
// (/api/pt/stripe/connect, /api/pt/stripe/status, /api/admin/stripe/link) must fail closed
// on a misconfigured Stripe deploy BEFORE any DB write and before any Stripe call, like
// checkout. fetch is spied for every host; nothing reaches the network.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import nodeCrypto from 'node:crypto';
import worker from '../worker/index.mjs';
import { db, seedBlock, seedUser, jsonRequest, getRequest } from './helpers.mjs';

afterEach(() => vi.restoreAllMocks());
const stripeEnv = (over = {}) => Object.assign(Object.create(null), env, { PAYMENT_MODE: 'stripe_test', STRIPE_INTEGRATION: 'connect' }, over);
const spyFetch = () => {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    calls.push(String(typeof input === 'string' ? input : input.url));
    return new Response(JSON.stringify({ error: { message: 'no mock' } }), { status: 404, headers: { 'content-type': 'application/json' } });
  });
  return calls;
};
const counts = async () => ({
  jobs: (await db().get('SELECT count(*) n FROM stripe_jobs')).n,
  connections: (await db().get('SELECT count(*) n FROM stripe_connections')).n,
  connectionState: JSON.stringify(await db().all('SELECT pt_id,mode,account_id,routing,ready FROM stripe_connections ORDER BY pt_id,mode')),
  audit: (await db().get('SELECT count(*) n FROM audit_log')).n
});

// "Unconfigured" as QA ran it, plus each single misconfiguration checkout already refuses.
const MISCONFIGURED = {
  unconfigured_no_key_no_webhook_secret: { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined, STRIPE_CONNECT_WEBHOOK_SECRET: undefined },
  no_key: { STRIPE_SECRET_KEY: undefined },
  empty_key: { STRIPE_SECRET_KEY: '' },
  live_key_in_test_mode: { STRIPE_SECRET_KEY: 'sk_live_' + nodeCrypto.randomBytes(12).toString('hex') },
  no_webhook_secret: { STRIPE_WEBHOOK_SECRET: undefined },
  http_app_url: { APP_URL: 'http://example.test' },
  app_url_with_path: { APP_URL: 'https://example.test/app' }
};

async function fixtures() {
  const s = await seedBlock({ customers: 0 });
  await db().run('UPDATE pts SET published=1 WHERE id=?', s.ptId);
  const trainer = await seedUser({ role: 'pt', ptId: s.ptId });
  // A second PT that already has a Connect account, so /status would call Stripe and then write.
  const s2 = await seedBlock({ customers: 0 });
  await db().run('INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready) VALUES(?,?,?,?,0)', s2.ptId, 'stripe_test', 'acct_' + nodeCrypto.randomBytes(6).toString('hex'), 'connected');
  const trainer2 = await seedUser({ role: 'pt', ptId: s2.ptId });
  const admin = await seedUser({ role: 'admin' });
  return {
    connect: () => jsonRequest(trainer, 'POST', '/api/pt/stripe/connect', {}),
    status: () => jsonRequest(trainer2, 'POST', '/api/pt/stripe/status', {}),
    adminLink: () => jsonRequest(admin, 'POST', '/api/admin/stripe/link', { pt_id: s.ptId }),
    trainer, admin
  };
}

describe('QA D1: Stripe actions fail closed before any write or Stripe call', () => {
  for (const [name, over] of Object.entries(MISCONFIGURED)) {
    it(`${name}: connect, status and admin link → 503, 0 stripe_jobs, 0 fetch calls, no row changes`, async () => {
      const f = await fixtures();
      const calls = spyFetch();
      const before = await counts();
      for (const route of ['connect', 'status', 'adminLink']) {
        const r = await worker.fetch(f[route](), stripeEnv(over));
        expect(r.status, route).toBe(503);
        expect(await r.json(), route).toMatchObject({ error: expect.any(String), code: 'PAYMENTS_NOT_READY' });
        expect(calls, route).toEqual([]);
        expect(await counts(), route).toEqual(before);
      }
      expect(before.jobs).toBe(0);
    });
  }

  it('read-only setup pages stay reachable when misconfigured (diagnostics), still without writes or Stripe calls', async () => {
    const f = await fixtures();
    const calls = spyFetch();
    const before = await counts();
    const e = stripeEnv(MISCONFIGURED.unconfigured_no_key_no_webhook_secret);
    expect((await worker.fetch(getRequest(f.trainer, '/api/pt/stripe/setup'), e)).status).toBe(200);
    expect((await worker.fetch(getRequest(f.admin, '/api/admin/stripe/setup'), e)).status).toBe(200);
    // admin check is a diagnostic GET /v1/account; with no key, stripe() refuses before fetch
    expect((await worker.fetch(jsonRequest(f.admin, 'POST', '/api/admin/stripe/check', {}), e)).status).toBe(503);
    expect(calls).toEqual([]);
    expect(await counts()).toEqual(before);
  });

  it('control: correctly configured, connect does create its job and reach Stripe (so the 503s above are the gate)', async () => {
    const f = await fixtures();
    const calls = spyFetch();
    const before = (await db().get("SELECT count(*) n FROM stripe_jobs WHERE kind='account'")).n;
    const r = await worker.fetch(f.connect(), stripeEnv());
    expect(r.status).not.toBe(200); // the mock answers 404, so the job fails; what matters is that it ran
    expect(calls.some(u => u.startsWith('https://api.stripe.com/'))).toBe(true);
    expect((await db().get("SELECT count(*) n FROM stripe_jobs WHERE kind='account'")).n).toBe(before + 1);
  });
});
