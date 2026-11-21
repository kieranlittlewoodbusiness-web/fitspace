// RC-14: single-PT mode (MULTI_PT_ENABLED defaults to false; this file always sets the flag
// explicitly). Isolated D1 for this file only.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../worker/index.mjs';
import { prepareCheckout, prepareConnect, prepareLink, completeJob } from '../src/ops/stripe-jobs.mjs';
import { db, seedBlock, seedUser, insertBooking, getRequest, jsonRequest, ORIGIN } from './helpers.mjs';

const overlay = (over = {}) => Object.assign(Object.create(null), env, over);
const single = (over = {}) => overlay({ MULTI_PT_ENABLED: 'false', ...over });
const multi = (over = {}) => overlay({ MULTI_PT_ENABLED: 'true', ...over });
const send = (req, e) => worker.fetch(req, e);
const jsonOf = async res => {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
};
const ptBody = (slug, create_key = crypto.randomUUID(), over = {}) => ({
  create_key, slug, brand_name: 'Test Studio', tagline: 'Strong every week',
  description: 'Small group strength classes.', about: 'Six-week blocks for all levels.',
  accent: '#cc3300', background: '#ffffff', foreground: '#111111', features: ['Small groups'],
  owner_name: 'Test Trainer', email: `${slug}@example.com`, published: true, ...over
});

describe('MULTI_PT_ENABLED flag', () => {
  it('is on only for the exact string "true"', async () => {
    const { multiPtEnabled } = await import('../src/multi-pt.mjs');
    expect(multiPtEnabled({})).toBe(false);
    expect(multiPtEnabled({ MULTI_PT_ENABLED: undefined })).toBe(false);
    expect(multiPtEnabled({ MULTI_PT_ENABLED: 'false' })).toBe(false);
    expect(multiPtEnabled({ MULTI_PT_ENABLED: 'TRUE' })).toBe(false);
    expect(multiPtEnabled({ MULTI_PT_ENABLED: '1' })).toBe(false);
    expect(multiPtEnabled({ MULTI_PT_ENABLED: 'true' })).toBe(true);
  });
});

describe('GET /api/public/site', () => {
  it('returns the contract, Cache-Control, and null pt when none is published', async () => {
    const empty = await send(new Request(ORIGIN + '/api/public/site'), single());
    expect(empty.status).toBe(200);
    expect(empty.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await jsonOf(empty)).toEqual({ multi_pt_enabled: false, pt: null, default_slug: null });

    const s = await seedBlock({ customers: 0 });
    const row = await db().get('SELECT * FROM pts WHERE id=?', s.ptId);
    const ok = await send(new Request(ORIGIN + '/api/public/site'), single());
    const body = await jsonOf(ok);
    expect(ok.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(body.multi_pt_enabled).toBe(false);
    expect(body.default_slug).toBe(row.slug);
    expect(body.pt).toMatchObject({
      id: row.id, slug: row.slug, brand_name: row.brand_name, tagline: row.tagline,
      description: row.description, about: row.about, published: true,
      booking_path: '/pt/' + row.slug
    });
    expect(body.pt).not.toHaveProperty('stripe_account');
    expect(body.pt).not.toHaveProperty('create_key');

    const on = await send(new Request(ORIGIN + '/api/public/site'), multi());
    expect((await jsonOf(on)).multi_pt_enabled).toBe(true);
  });
});

describe('GET /api/me includes multi_pt_enabled', () => {
  it('for anonymous, customer, PT and admin', async () => {
    const s = await seedBlock({ customers: 1 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const admin = await seedUser({ role: 'admin' });
    for (const [who, req] of [
      ['anon', new Request(ORIGIN + '/api/me')],
      ['customer', getRequest(s.users[0], '/api/me')],
      ['pt', getRequest(pt, '/api/me')],
      ['admin', getRequest(admin, '/api/me')]
    ]) {
      const off = await jsonOf(await send(req.clone(), single()));
      const on = await jsonOf(await send(req, multi()));
      expect(off.multi_pt_enabled, who).toBe(false);
      expect(on.multi_pt_enabled, who).toBe(true);
      expect('default_slug' in off, who).toBe(true);
    }
  });
});

describe('public directory and slug', () => {
  it('GET /api/public/pts is 404 when off and lists published PTs when on', async () => {
    const hidden = await send(new Request(ORIGIN + '/api/public/pts'), single());
    expect(hidden.status).toBe(404);
    expect(await jsonOf(hidden)).toMatchObject({ error: 'This action is not available.', code: 'MULTI_PT_DISABLED' });

    await seedBlock({ customers: 0 });
    const listed = await send(new Request(ORIGIN + '/api/public/pts'), multi());
    expect(listed.status).toBe(200);
    const body = await jsonOf(listed);
    expect(Array.isArray(body.pts)).toBe(true);
    expect(body.pts.length).toBeGreaterThan(0);
  });

  it('GET /api/public/pts/:slug resolves only the single published PT when off', async () => {
    const first = await seedBlock({ customers: 0, blockId: 'b-first' });
    const second = await seedBlock({ customers: 0, blockId: 'b-second' });
    const a = await db().get('SELECT slug FROM pts WHERE id=?', first.ptId);
    const b = await db().get('SELECT slug FROM pts WHERE id=?', second.ptId);
    const site = await jsonOf(await send(new Request(ORIGIN + '/api/public/site'), single()));
    const allowed = site.default_slug;
    const other = allowed === a.slug ? b.slug : a.slug;
    const ok = await send(new Request(ORIGIN + '/api/public/pts/' + allowed), single());
    expect(ok.status).toBe(200);
    expect((await jsonOf(ok)).pt.slug).toBe(allowed);
    const denied = await send(new Request(ORIGIN + '/api/public/pts/' + other), single());
    expect(denied.status).toBe(404);
    expect((await jsonOf(denied)).code).toBe('PT_NOT_FOUND');
    // When multi-PT is on, both published slugs still resolve.
    expect((await send(new Request(ORIGIN + '/api/public/pts/' + other), multi())).status).toBe(200);
  });
});

describe('hidden multi-PT routes', () => {
  it('pt_direct key routes 404 when off and keep existing behaviour when on', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const routes = ['/api/pt/stripe/credentials', '/api/pt/stripe/check', '/api/pt/stripe/enable', '/api/pt/stripe/disconnect'];
    for (const path of routes) {
      const off = await send(jsonRequest(pt, 'POST', path, {}), single());
      expect(off.status, path).toBe(404);
      expect((await jsonOf(off)).code, path).toBe('MULTI_PT_DISABLED');
      const on = await send(jsonRequest(pt, 'POST', path, {}), multi());
      expect(on.status, path).toBe(410);
      expect((await jsonOf(on)).code, path).toBe('PT_DIRECT_WRITES_RETIRED');
    }
    const hook = `/api/stripe/pt/00000000-0000-4000-8000-000000000000/webhook`;
    const hidden = await send(new Request(ORIGIN + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), single());
    expect(hidden.status).toBe(404);
    expect((await jsonOf(hidden)).code).toBe('MULTI_PT_DISABLED');
    const shown = await send(new Request(ORIGIN + hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), multi());
    const shownBody = await jsonOf(shown);
    expect(shownBody.code).not.toBe('MULTI_PT_DISABLED');
    // Unknown credential: existing 404, not the single-PT hide.
    expect(shown.status).toBe(404);
    expect(shownBody).not.toHaveProperty('code', 'MULTI_PT_DISABLED');
  });

  it('RC-7 subscription and subscription-code routes 404 when off; gate is off when on', async () => {
    const paths = [
      ['GET', '/api/pt/subscription'],
      ['POST', '/api/pt/subscription/checkout'],
      ['POST', '/api/pt/subscription/portal'],
      ['GET', '/api/admin/subscriptions'],
      ['POST', '/api/admin/subscription-codes'],
      ['POST', '/api/pt/subscription-codes']
    ];
    const admin = await seedUser({ role: 'admin' });
    for (const [method, path] of paths) {
      const req = method === 'GET' ? getRequest(admin, path) : jsonRequest(admin, method, path, {});
      const off = await send(req.clone(), single());
      expect(off.status, path).toBe(404);
      expect((await jsonOf(off)).code, path).toBe('MULTI_PT_DISABLED');
      const on = await send(req, multi());
      const body = await jsonOf(on);
      expect(body.code, path).not.toBe('MULTI_PT_DISABLED');
      expect(on.status, path).toBe(404); // not implemented yet (RC-7 / RC-8)
    }
  });
});

describe('/trainers redirect', () => {
  it('302 to booking_path, or / when there is no published PT; no redirect in multi mode', async () => {
    await db().run('UPDATE pts SET published=0');
    const none = await send(new Request(ORIGIN + '/trainers'), single());
    expect(none.status).toBe(302);
    expect(none.headers.get('Location')).toBe('/');
    const slash = await send(new Request(ORIGIN + '/trainers/'), single());
    expect(slash.headers.get('Location')).toBe('/');

    await seedBlock({ customers: 0, blockId: 'trainers-block' });
    const site = await jsonOf(await send(new Request(ORIGIN + '/api/public/site'), single()));
    expect(site.pt).toBeTruthy();
    const redirected = await send(new Request(ORIGIN + '/trainers'), single());
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get('Location')).toBe(site.pt.booking_path);

    const stay = await send(new Request(ORIGIN + '/trainers'), multi());
    expect(stay.status).not.toBe(302);
  });
});

describe('Stripe Connect: at most one account, direct charges, no application fee', () => {
  it('admin platform link is disabled in single-PT mode and works when multi-PT is on', async () => {
    const s = await seedBlock({ customers: 0 });
    const admin = await seedUser({ role: 'admin' });
    await expect(prepareLink(db(), { userId: admin.id, ptId: s.ptId, mode: 'stripe_test', multiPt: false }))
      .rejects.toMatchObject({ status: 409, code: 'PLATFORM_LINK_DISABLED' });
    const id = await prepareLink(db(), { userId: admin.id, ptId: s.ptId, mode: 'stripe_test', multiPt: true });
    expect(id).toMatch(/^link:/);
  });

  it('single_connect: a second PT cannot bind another account when single-PT mode is on', async () => {
    const a = await seedBlock({ customers: 0, blockId: 'conn-a' });
    const b = await seedBlock({ customers: 0, blockId: 'conn-b' });
    const ptA = await seedUser({ role: 'pt', ptId: a.ptId });
    const ptB = await seedUser({ role: 'pt', ptId: b.ptId });
    // Prepare both jobs before either bind, so the pre-check does not hide the commit-time guard.
    const jobA = await prepareConnect(db(), { userId: ptA.id, origin: ORIGIN, mode: 'stripe_test', multiPt: false });
    const jobB = await prepareConnect(db(), { userId: ptB.id, origin: ORIGIN, mode: 'stripe_test', multiPt: false });
    await completeJob(db(), { id: jobA, result: { id: 'acct_test_one' } });
    expect((await db().all('SELECT pt_id FROM stripe_connections')).length).toBe(1);
    await expect(completeJob(db(), { id: jobB, result: { id: 'acct_test_two' } }))
      .rejects.toMatchObject({ status: 409, code: 'SINGLE_CONNECT_EXISTS' });
    expect(await db().all('SELECT account_id FROM stripe_connections')).toEqual([{ account_id: 'acct_test_one' }]);
    await expect(prepareConnect(db(), { userId: ptB.id, origin: ORIGIN, mode: 'stripe_test', multiPt: false }))
      .rejects.toMatchObject({ status: 409, code: 'SINGLE_CONNECT_EXISTS' });
  });

  it('checkout job is a direct charge (connected account, no application fee)', async () => {
    await db().run('DELETE FROM stripe_jobs');
    await db().run('DELETE FROM stripe_connections');
    const s = await seedBlock({ customers: 1 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const jobA = await prepareConnect(db(), { userId: pt.id, origin: ORIGIN, mode: 'stripe_test', multiPt: false });
    const account = 'acct_test_direct';
    await completeJob(db(), { id: jobA, result: { id: account } });
    await db().run("UPDATE stripe_connections SET ready=1 WHERE pt_id=? AND mode='stripe_test'", s.ptId);
    const bk = await insertBooking({
      blockId: s.blockId, customerId: s.users[0].id, status: 'pending', mode: 'stripe_test',
      extra: { stripe_account_id: account, stripe_routing: 'connected' }
    });
    const checkoutId = await prepareCheckout(db(), { bookingId: bk, userId: s.users[0].id, origin: ORIGIN, mode: 'stripe_test' });
    const row = await db().get('SELECT payload FROM stripe_jobs WHERE id=?', checkoutId);
    const payload = JSON.parse(row.payload);
    expect(payload.account).toBe(account);
    expect(JSON.stringify(payload)).not.toMatch(/application_fee/);
    const accountJob = await db().get("SELECT payload FROM stripe_jobs WHERE kind='account' AND target_id=?", s.ptId);
    const created = JSON.parse(accountJob.payload);
    expect(created.data.defaults.responsibilities.fees_collector).toBe('stripe');
    expect(created.data.defaults.responsibilities.losses_collector).toBe('stripe');
  });
});

describe('customer 409 copy', () => {
  it('tells the customer to contact their coach to refund a completed payment', async () => {
    const s = await seedBlock({ customers: 1 });
    const bk = await insertBooking({
      blockId: s.blockId, customerId: s.users[0].id, status: 'paid', mode: 'stripe_test',
      extra: { stripe_account_id: 'acct_x', stripe_routing: 'connected', payment_intent: 'pi_x' }
    });
    const res = await send(jsonRequest(s.users[0], 'POST', '/api/bookings/' + bk + '/cancel', {}), single());
    expect(res.status).toBe(409);
    expect(await jsonOf(res)).toMatchObject({ error: 'Contact your coach to refund a completed payment.' });
  });
});
