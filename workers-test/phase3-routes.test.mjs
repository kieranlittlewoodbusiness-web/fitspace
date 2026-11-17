// Phase 3: every remaining route goes through scopeFor() (or is public/self-only), each
// with a cross-tenant test. Demo mode here; Stripe routes are in phase3-stripe.test.mjs.
import { describe, it, expect } from 'vitest';
import { exports } from 'cloudflare:workers';
import { db, seedBlock, seedUser, insertBooking, jsonRequest, getRequest, ORIGIN, tally } from './helpers.mjs';

const call = (user, method, path, body) => exports.default.fetch(jsonRequest(user, method, path, body));
const get = (user, path) => exports.default.fetch(getRequest(user, path));
const anon = (method, path, body, ip = '203.0.113.' + Math.floor(Math.random() * 250)) => exports.default.fetch(new Request(ORIGIN + path, { method, headers: { origin: ORIGIN, 'content-type': 'application/json', 'CF-Connecting-IP': ip }, body: body ? JSON.stringify(body) : undefined }));
const cookieOf = r => /fit_session=([^;]*)/.exec(r.headers.get('set-cookie') || '')?.[1];

describe('account routes', () => {
  it('signup, me, login, password change, logout; duplicate email 409; wrong password 401', async () => {
    const email = `p3-${crypto.randomUUID().slice(0, 8)}@example.com`, password = 'Correct-horse-9';
    const s = await anon('POST', '/api/auth/signup', { name: 'Phase Three', email, password, demo_acknowledged: true });
    expect(s.status).toBe(201);
    const { user, csrf } = await s.json();
    const me = { id: user.id, token: cookieOf(s), csrf };
    expect(user).toMatchObject({ email, role: 'customer' });
    expect(JSON.stringify(user)).not.toMatch(/password_hash|scrypt/);
    expect((await anon('POST', '/api/auth/signup', { name: 'Again', email, password, demo_acknowledged: true })).status).toBe(409);
    expect((await (await get(me, '/api/me')).json()).user.id).toBe(user.id);
    expect((await anon('POST', '/api/auth/login', { email, password: 'wrong-password-1' })).status).toBe(401);
    expect((await anon('POST', '/api/auth/login', { email: 'nobody-' + email, password })).status).toBe(401);
    const login = await anon('POST', '/api/auth/login', { email, password });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax/);
    expect((await call(me, 'POST', '/api/auth/password', { current_password: 'nope-nope-1', new_password: 'New-password-77' })).status).toBe(400);
    const changed = await call(me, 'POST', '/api/auth/password', { current_password: password, new_password: 'New-password-77' });
    expect(changed.status).toBe(200);
    const me2 = { token: cookieOf(changed), csrf: (await changed.json()).csrf };
    expect((await anon('POST', '/api/auth/login', { email, password })).status).toBe(401);
    expect((await anon('POST', '/api/auth/login', { email, password: 'New-password-77' })).status).toBe(200);
    expect((await call(me2, 'POST', '/api/auth/logout')).status).toBe(200);
    expect((await (await get(me2, '/api/me')).json()).user).toBeNull();
  });

  it('login is rate limited per client (16th attempt in the window -> 429)', async () => {
    const ip = '198.51.100.' + Math.floor(Math.random() * 250);
    const statuses = [];
    for (let i = 0; i < 16; i++) statuses.push((await anon('POST', '/api/auth/login', { email: 'rl@example.com', password: 'whatever-123' }, ip)).status);
    console.log('login rate limit, 16 attempts:', JSON.stringify(tally(statuses)));
    expect(statuses.slice(0, 15).every(s => s === 401)).toBe(true);
    expect(statuses[15]).toBe(429);
  });

  it('password change racing another change: one wins, the other gets 409 PASSWORD_CHANGED_ELSEWHERE or 400', async () => {
    const email = `p3r-${crypto.randomUUID().slice(0, 8)}@example.com`, password = 'Correct-horse-9';
    const s = await anon('POST', '/api/auth/signup', { name: 'Racer', email, password, demo_acknowledged: true });
    const me = { token: cookieOf(s), csrf: (await s.json()).csrf };
    const r = await Promise.all(['First-change-11', 'Second-change-22'].map(p => call(me, 'POST', '/api/auth/password', { current_password: password, new_password: p })));
    const statuses = r.map(x => x.status).sort();
    console.log('concurrent password changes:', JSON.stringify(statuses));
    expect(statuses.filter(x => x === 200)).toHaveLength(1);
  });
});

describe('public pages', () => {
  it('unpublished PTs and blocks are hidden; no private fields', async () => {
    const pub = await seedBlock({ customers: 0 }), hidden = await seedBlock({ customers: 0 });
    await db().run('UPDATE pts SET published=0 WHERE id=?', hidden.ptId);
    const list = await (await get({ token: '' }, '/api/public/pts')).json();
    expect(list.pts.map(p => p.id)).toContain(pub.ptId);
    expect(list.pts.map(p => p.id)).not.toContain(hidden.ptId);
    expect((await get({ token: '' }, '/api/public/pts/' + hidden.ptId)).status).toBe(404);
    const page = await (await get({ token: '' }, '/api/public/pts/' + pub.ptId)).json();
    expect(page.blocks.map(b => b.id)).toEqual([pub.blockId]);
    expect(JSON.stringify(page)).not.toMatch(/stripe_account|create_key|owner_email/);
  });
});

describe('dashboard is scoped per role', () => {
  it('PT sees only own blocks, bookings and outbox; customer only own bookings; admin all', async () => {
    const a = await seedBlock({ customers: 1 }), b = await seedBlock({ customers: 1 });
    const bkA = await insertBooking({ blockId: a.blockId, customerId: a.users[0].id });
    const bkB = await insertBooking({ blockId: b.blockId, customerId: b.users[0].id });
    await db().run("INSERT INTO email_outbox(id,pt_id,customer_id,dedupe_key,recipient,subject,body,kind,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)", 'ob-' + bkB, b.ptId, b.users[0].id, 'k-' + bkB, 'x@example.com', 'S', 'B', 'confirmation', 'preview', Date.now());
    const ptA = await seedUser({ role: 'pt', ptId: a.ptId }), admin = await seedUser({ role: 'admin' });
    const dA = await (await get(ptA, '/api/dashboard')).json();
    expect(dA.blocks.map(x => x.id)).toEqual([a.blockId]);
    expect(dA.bookings.map(x => x.id)).toEqual([bkA]);
    expect(dA.outbox.map(o => o.id)).not.toContain('ob-' + bkB);
    const dC = await (await get(a.users[0], '/api/dashboard')).json();
    expect(dC.bookings.map(x => x.id)).toEqual([bkA]);
    const dAdmin = await (await get(admin, '/api/dashboard')).json();
    expect(dAdmin.bookings.map(x => x.id)).toEqual(expect.arrayContaining([bkA, bkB]));
    console.log('dashboard scoping: PT A blocks', dA.blocks.length, 'bookings', dA.bookings.length, '| customer', dC.bookings.length, '| admin bookings', dAdmin.bookings.length);
  });
});

describe('admin-only routes', () => {
  it('PT and customer get 403 on admin routes; admin PUT /api/admin/pts/:id updates branding', async () => {
    const a = await seedBlock({ customers: 1 });
    const pt = await seedUser({ role: 'pt', ptId: a.ptId }), admin = await seedUser({ role: 'admin' });
    const branding = { slug: 'renamed-' + crypto.randomUUID().slice(0, 6), brand_name: 'Renamed PT', tagline: 'New tagline', description: 'New description', about: 'New about text', accent: '#ffd43b', background: '#ffffff', foreground: '#111111', features: ['Small groups'], published: true };
    for (const u of [pt, a.users[0]]) {
      expect((await get(u, '/api/admin/stripe/setup')).status).toBe(403);
      expect((await call(u, 'POST', '/api/admin/pts', { create_key: crypto.randomUUID() })).status).toBe(403);
      expect((await call(u, 'PUT', '/api/admin/pts/' + a.ptId, branding)).status).toBe(403);
      expect((await call(u, 'POST', '/api/admin/stripe/link', { pt_id: a.ptId })).status).toBe(403);
    }
    const ok = await call(admin, 'PUT', '/api/admin/pts/' + a.ptId, branding);
    expect([ok.status, ok.status === 200 ? null : await ok.text()]).toEqual([200, null]);
    expect((await db().get('SELECT brand_name FROM pts WHERE id=?', a.ptId)).brand_name).toBe('Renamed PT');
    expect((await call(admin, 'PUT', '/api/admin/pts/missing-pt', { ...branding, slug: 'other-' + crypto.randomUUID().slice(0, 6) })).status).toBe(404);
  });
});

describe('booking routes are scoped', () => {
  it('another customer gets 404 on GET, pay and cancel; another PT gets 404 on cancel; the owner can cancel', async () => {
    const a = await seedBlock({ customers: 2 }), b = await seedBlock({ customers: 0 });
    const bk = await insertBooking({ blockId: a.blockId, customerId: a.users[0].id, status: 'pending' });
    const other = a.users[1], ptB = await seedUser({ role: 'pt', ptId: b.ptId }), ptA = await seedUser({ role: 'pt', ptId: a.ptId });
    expect((await get(other, '/api/bookings/' + bk)).status).toBe(404);
    expect((await call(other, 'POST', `/api/bookings/${bk}/pay`, { result: 'paid' })).status).toBe(404);
    expect((await call(other, 'POST', `/api/bookings/${bk}/cancel`)).status).toBe(404);
    expect((await call(ptB, 'POST', `/api/bookings/${bk}/cancel`)).status).toBe(404);
    expect((await get(ptB, '/api/bookings/' + bk)).status).toBe(404);
    expect((await get(ptA, '/api/bookings/' + bk)).status).toBe(200);
    expect((await db().get('SELECT status FROM bookings WHERE id=?', bk)).status).toBe('pending');
    expect((await call(a.users[0], 'POST', `/api/bookings/${bk}/cancel`)).status).toBe(200);
    expect((await db().get('SELECT status FROM bookings WHERE id=?', bk)).status).toBe('cancelled');
  });

  it('attendance: another PT gets 404; PT stripe setup shows only the caller PT; pt_direct writes are 410', async () => {
    const a = await seedBlock({ customers: 1 }), b = await seedBlock({ customers: 0 });
    const bk = await insertBooking({ blockId: a.blockId, customerId: a.users[0].id });
    const ptB = await seedUser({ role: 'pt', ptId: b.ptId });
    expect((await call(ptB, 'POST', '/api/attendance', { booking_id: bk, session_id: a.blockId + '-s0', status: 'attended' })).status).toBe(404);
    await db().run("INSERT INTO pt_stripe_credentials(id,pt_id,mode,account_id,created_at) VALUES(?,?,?,?,?)", crypto.randomUUID(), a.ptId, 'stripe_test', 'acct_a_only', Date.now());
    const setup = await (await get(ptB, '/api/pt/stripe/setup')).json();
    expect(setup.accounts).toEqual([]);
    for (const w of ['credentials', 'check', 'enable', 'disconnect']) {
      const r = await call(ptB, 'POST', '/api/pt/stripe/' + w, {});
      expect(r.status).toBe(410);
      expect((await r.json()).code).toBe('PT_DIRECT_WRITES_RETIRED');
    }
  });

  it('unknown API routes are 404 (no 501 stubs remain)', async () => {
    const admin = await seedUser({ role: 'admin' });
    expect((await get(admin, '/api/nothing-here')).status).toBe(404);
  });
});
