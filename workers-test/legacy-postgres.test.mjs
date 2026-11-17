// Port of tests/postgres.test.mjs (Netlify + Postgres snapshot, production mode: no demo
// accounts, owner-bootstrapped admin) to the Worker + D1. "PORT:" marks differences.
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../worker/index.mjs';
import { bootstrapAdminSql } from '../scripts/bootstrap-admin.mjs';
import { runScheduled } from '../src/mail.mjs';
import { resetToken, resetPassword } from '../src/ops/password-reset.mjs';
import { db } from './helpers.mjs';

const base = 'https://public.example', adminPass = 'OwnedAdminFixturePassword123!', customerPass = 'CustomerFixturePassword123!';
const prodEnv = (over = {}) => Object.assign(Object.create(null), env, { DEMO_MODE: undefined, PAYMENT_MODE: 'demo' }, over);
let ip = 0;
function client(e = prodEnv()) {
  let cookie = '', csrf = '';
  const address = `198.51.100.${++ip}`;
  return {
    async request(path, method = 'GET', data, headers = {}) {
      const response = await worker.fetch(new Request(base + path, { method, headers: { 'CF-Connecting-IP': address, ...(cookie ? { cookie } : {}), ...(!['GET', 'HEAD'].includes(method) ? { origin: base, 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), e);
      const set = response.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const result = (response.headers.get('content-type') || '').includes('json') ? await response.json() : await response.text();
      if (result.csrf) csrf = result.csrf;
      return { status: response.status, data: result, headers: response.headers };
    },
    async login(email, password) { const r = await this.request('/api/auth/login', 'POST', { email, password }); expect(r.status, JSON.stringify(r.data)).toBe(200); return r; },
    async signup(email) { const r = await this.request('/api/auth/signup', 'POST', { name: 'Test Customer', email, password: customerPass, demo_acknowledged: true, role: 'admin' }); expect(r.status, JSON.stringify(r.data)).toBe(201); expect(r.data.user.role).toBe('customer'); }
  };
}
const admin = client(), pt = client(), customer = client();
const future = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10) + 'T18:30';
const classData = (extra = {}) => ({ create_key: crypto.randomUUID(), title: 'Six-week strength block', description: 'Supportive coaching and progress every week.', venue: 'Training Studio', capacity: 15, price_pence: 9000, published: true, sessions: Array.from({ length: 6 }, (_, i) => ({ starts_at: future(7 + i * 7), duration_minutes: 60 })), ...extra });
let blockId, bookingId;

// PORT: ADMIN_EMAIL/ADMIN_PASSWORD on every request -> the one-off bootstrap SQL (same as scripts/bootstrap-admin.mjs).
beforeAll(async () => { await env.DB.exec(bootstrapAdminSql({ email: 'owner@example.com', password: adminPass }).trim()); });
afterEach(() => vi.restoreAllMocks());

describe('ported tests/postgres.test.mjs', () => {
  it('public browsing requires no preview cookie; dashboards and fixture accounts remain protected', async () => {
    const anon = client();
    const home = await anon.request('/');
    expect(home.status).toBe(200);
    expect(home.data).not.toContain('Preview password');
    expect(home.data).not.toContain('noindex');
    const script = await anon.request('/app.js');
    expect(script.status).toBe(200);
    expect(script.data).not.toContain('TrainTogether123!');
    expect(script.data).not.toContain('demo-login');
    expect((await anon.request('/api/me')).data.demo).toBe(false);
    expect((await anon.request('/api/public/pts')).status).toBe(200);
    expect((await anon.request('/api/dashboard')).status).toBe(401);
    expect((await anon.request('/api/auth/login', 'POST', { email: 'admin@example.com', password: 'TrainTogether123!' })).status).toBe(401);
    await admin.login('owner@example.com', adminPass);
    const dashboard = await admin.request('/api/dashboard');
    expect(dashboard.data.stats.pts).toBe(0);
    expect(dashboard.data.stats.customers).toBe(0);
  });

  it('admin creates the PT; public pages, signup, checkout and attendance work without a site password', async () => {
    const result = await admin.request('/api/admin/pts', 'POST', { create_key: crypto.randomUUID(), owner_name: 'Alex Trainer', email: 'coach@example.com', brand_name: 'SIX WEEK CLUB', slug: 'six-week-club', tagline: 'Six weeks. Get stronger.', description: 'Build strength, fitness and confidence with focused coaching.', about: 'Train well and build a routine you can keep.', accent: '#ffd43b', background: '#ffffff', foreground: '#111111', features: ['Strength coaching', 'Small supportive groups'], published: true });
    expect(result.status, JSON.stringify(result.data)).toBe(201);
    await pt.login(result.data.email, result.data.temporary_password);
    expect((await pt.request('/api/auth/password', 'POST', { current_password: result.data.temporary_password, new_password: 'OwnedPTFixturePassword123!' })).status).toBe(200);
    const created = await pt.request('/api/blocks', 'POST', classData());
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    blockId = created.data.block.id;
    const anon = client();
    expect((await anon.request('/api/public/pts/six-week-club')).data.blocks[0].available).toBe(15);
    await customer.signup('client@example.com');
    const booking = await customer.request('/api/bookings', 'POST', { block_id: blockId, checkout_token: crypto.randomUUID(), amount_pence: 1 });
    expect(booking.status).toBe(201);
    bookingId = booking.data.booking.id;
    expect(booking.data.booking.amount_pence).toBe(9000);
    const paid = await customer.request('/api/bookings/' + bookingId + '/pay', 'POST', { result: 'success' });
    expect(paid.data.booking.status).toBe('paid');
    expect((await anon.request('/api/public/pts/six-week-club')).data.blocks[0].available).toBe(14);
    expect((await customer.request('/api/admin/pts', 'POST', {})).status).toBe(403);
    expect((await pt.request('/api/admin/pts', 'POST', {})).status).toBe(403);
    expect((await anon.request('/api/bookings/' + bookingId)).status).toBe(401);
    const sessionId = paid.data.booking.sessions[0].id;
    // PORT: the fixture shift is a direct D1 update instead of withSnapshot().
    await db().run('UPDATE class_sessions SET starts_epoch=? WHERE id=?', Date.now() - 86400000, sessionId);
    const missed = await pt.request('/api/attendance', 'POST', { booking_id: bookingId, session_id: sessionId, status: 'no_show' });
    expect(missed.status, JSON.stringify(missed.data)).toBe(200);
    expect(missed.data.email.subject).toBe('Sorry we missed you at class!');
    expect(missed.data.email.status).toBe('preview');
    const again = await pt.request('/api/attendance', 'POST', { booking_id: bookingId, session_id: sessionId, status: 'no_show' });
    expect(again.data.email.id).toBe(missed.data.email.id);
    expect((await admin.request('/api/dashboard')).data.quotes.length).toBe(20);
    // PORT: "restart the pool" -> a fresh request; state lives in D1, not in an isolate.
    expect((await customer.request('/api/bookings/' + bookingId)).data.booking.status).toBe('paid');
  });

  it('public capacity, idempotency, failed checkout and cross-origin checks remain enforced', async () => {
    const created = await pt.request('/api/blocks', 'POST', classData({ title: 'One-place class', capacity: 1, sessions: [{ starts_at: future(50), duration_minutes: 60 }] }));
    expect(created.status).toBe(201);
    const a = client(), b = client();
    await a.signup('a@example.com'); await b.signup('b@example.com');
    const tokens = [crypto.randomUUID(), crypto.randomUUID()];
    const results = await Promise.all([a, b].map((c, i) => c.request('/api/bookings', 'POST', { block_id: created.data.block.id, checkout_token: tokens[i] })));
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    const winner = results.findIndex(x => x.status === 201), c = [a, b][winner], id = results[winner].data.booking.id;
    expect((await c.request('/api/bookings', 'POST', { block_id: created.data.block.id, checkout_token: tokens[winner] })).data.booking.id).toBe(id);
    expect((await c.request('/api/bookings/' + id + '/pay', 'POST', { result: 'declined' })).data.booking.status).toBe('failed');
    expect((await pt.request('/api/blocks', 'POST', classData(), { origin: 'https://other.example' })).status).toBe(403);
    expect((await pt.request('/api/pt/stripe/connect', 'POST', {})).status).toBe(503);
  });

  it('old demo databases and missing owner setup fail safely; failed writes are not acknowledged', async () => {
    // PORT: the owner-setup 503 (/api/me without ADMIN_PASSWORD) no longer exists: the admin is
    // bootstrapped once, outside the request path. Demo accounts imported from an old demo
    // snapshot cannot sign in without DEMO_MODE (also legacy-platform "PORT extra").
    await db().run("INSERT INTO users(id,name,email,password_hash,role,demo,created_at) VALUES('legacy-demo','Old Demo','old-demo@example.com',(SELECT password_hash FROM users WHERE email='owner@example.com'),'admin',1,1)");
    expect((await client().request('/api/auth/login', 'POST', { email: 'old-demo@example.com', password: adminPass })).status).toBe(401);
    // PORT: "storage failure does not acknowledge writes" -> a failing D1 write returns 503 and
    // nothing is committed (one atomic batch).
    const before = (await db().get('SELECT count(*) n FROM blocks')).n;
    const failing = prodEnv({ DB: new Proxy(env.DB, { get: (t, k) => (k === 'batch' ? async () => { throw new Error('fixture failure'); } : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }) });
    const r = await worker.fetch(new Request(base + '/api/auth/signup', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.77' }, body: JSON.stringify({ name: 'Nope', email: 'nope@example.com', password: customerPass, demo_acknowledged: true }) }), failing);
    expect(r.status).toBe(503);
    expect(await db().get("SELECT id FROM users WHERE email='nope@example.com'")).toBeNull();
    expect((await db().get('SELECT count(*) n FROM blocks')).n).toBe(before);
  });

  it('custom nine-week block with seven participants cannot oversell; lowering below occupied places is rejected', async () => {
    const details = classData({ title: 'Nine weeks, seven participants', capacity: 7, sessions: Array.from({ length: 9 }, (_, i) => ({ starts_at: future(10 + i * 7), duration_minutes: 60 })) });
    const created = await pt.request('/api/blocks', 'POST', details);
    expect(created.status).toBe(201);
    const id = created.data.block.id;
    expect(created.data.block.sessions.length).toBe(9);
    expect(created.data.block.capacity).toBe(7);
    const people = Array.from({ length: 10 }, () => client());
    for (let i = 0; i < people.length; i++) await people[i].signup('capacity-' + i + '@example.com');
    const results = await Promise.all(people.map(c => c.request('/api/bookings', 'POST', { block_id: id, checkout_token: crypto.randomUUID() })));
    expect(results.filter(r => r.status === 201).length).toBe(7);
    expect(results.filter(r => r.status === 409).length).toBe(3);
    const get = async () => (await client().request('/api/public/pts/six-week-club')).data.blocks.find(b => b.id === id);
    expect((await get()).available).toBe(0);
    const cut = await pt.request('/api/blocks/' + id, 'PUT', { ...details, capacity: 6 });
    expect(cut.status).toBe(409);
    expect(cut.data.code).toBe('CAPACITY_BELOW_HOLDS');
    const winner = results.findIndex(r => r.status === 201);
    expect((await people[winner].request('/api/bookings/' + results[winner].data.booking.id + '/pay', 'POST', { result: 'success' })).status).toBe(200);
    expect((await pt.request('/api/blocks/' + id, 'PUT', { ...details, capacity: 8 })).status).toBe(200);
    expect((await get()).available).toBe(1);
    const loser = results.findIndex(r => r.status === 409);
    expect((await people[loser].request('/api/bookings', 'POST', { block_id: id, checkout_token: crypto.randomUUID() })).status).toBe(201);
    expect((await get()).available).toBe(0);
    await db().run("UPDATE bookings SET expires_at=? WHERE block_id=? AND status='pending'", Date.now() - 1, id);
    expect((await get()).available).toBe(7);
    expect((await get()).paid_count).toBe(1);
    for (const capacity of [0, 101, 2.5]) expect((await pt.request('/api/blocks', 'POST', { ...details, create_key: crypto.randomUUID(), capacity })).status).toBe(400);
  });
});

// Port of the tests/password-reset.test.mjs cases not already covered by
// workers-test/password-reset.test.mjs (phase 2). Delivery is the Cron Trigger; Resend mocked.
describe('ported tests/password-reset.test.mjs (gaps)', () => {
  const sendEnv = () => Object.assign(Object.create(null), env, { EMAIL_MODE: 'send' });
  async function linkFor(email) {
    const anon = client();
    expect((await anon.request('/api/auth/forgot-password', 'POST', { email })).status).toBe(200);
    const row = await db().get('SELECT r.id FROM password_resets r JOIN users u ON u.id=r.user_id WHERE u.email=? AND r.used_at IS NULL ORDER BY r.created_at DESC LIMIT 1', email);
    return row && resetToken(env, row.id);
  }
  const reset = (token, password) => client().request('/api/auth/reset-password', 'POST', { token, new_password: password });

  it('PT can reset a temporary password without changing role, trainer ownership, prices or bookings', async () => {
    const created = await admin.request('/api/admin/pts', 'POST', { create_key: crypto.randomUUID(), owner_name: 'Reset Trainer', email: 'reset-pt@example.com', brand_name: 'RESET CLUB', slug: 'reset-club', tagline: 'Reset and go again.', description: 'Coaching for steady progress.', about: 'Train well and keep going.', accent: '#ffd43b', background: '#ffffff', foreground: '#111111', features: ['Coaching'], published: true });
    const before = await db().get("SELECT id,role,pt_id FROM users WHERE email='reset-pt@example.com'");
    const token = await linkFor('reset-pt@example.com');
    expect((await reset(token, 'BrandNewTrainerPass123!')).status).toBe(200);
    const after = await db().get("SELECT id,role,pt_id,must_change_password FROM users WHERE email='reset-pt@example.com'");
    expect(after).toMatchObject({ id: before.id, role: 'pt', pt_id: created.data.pt_id, must_change_password: 0 });
    const t = client(); await t.login('reset-pt@example.com', 'BrandNewTrainerPass123!');
  });

  it('expired, tampered and rotated-secret reset links fail; GET does not consume a valid link', async () => {
    const email = 'client@example.com';
    const token = await linkFor(email);
    expect((await client().request('/api/auth/reset-password?token=' + encodeURIComponent(token))).status).toBe(404); // PORT: no GET handler; the link is consumed only by POST
    expect((await reset(token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA'), 'AnotherPassword123!')).status).toBe(400);
    // PORT: the reset commits inside the Writer DO, which reads its own deployment secrets, so a
    // per-request env override cannot rotate it; rotation is exercised on the op directly.
    const rotated = Object.assign(Object.create(null), env, { AUTH_RESET_SECRET: 'r'.repeat(64) });
    await expect(resetPassword(db(), { token, newPassword: 'AnotherPassword123!' }, rotated)).rejects.toMatchObject({ status: 400 });
    await db().run('UPDATE password_resets SET expires_at=? WHERE used_at IS NULL', Date.now() - 1);
    expect((await reset(token, 'AnotherPassword123!')).status).toBe(400);
  });

  it('normal password changes invalidate reset links; a successful reset invalidates all outstanding links', async () => {
    await db().run('DELETE FROM password_reset_limits');
    const email = 'a@example.com';
    const first = await linkFor(email);
    const c = client(); await c.login(email, customerPass);
    expect((await c.request('/api/auth/password', 'POST', { current_password: customerPass, new_password: 'ChangedNormally123!' })).status).toBe(200);
    expect((await reset(first, 'ShouldNotWork123!')).status).toBe(400);
    const one = await linkFor(email), two = await linkFor(email);
    expect((await reset(two, 'ResetWorked123!')).status).toBe(200);
    expect((await reset(one, 'SecondShouldFail123!')).status).toBe(400);
  });

  // CR 5941600057: password-reset #6 in full (limits persist with an identical answer; reset off
  // is explicit via /api/me and sends nothing; back on is reported again).
  it('request limits persist with an identical generic answer; unavailable configuration is explicit and sends nothing', async () => {
    await db().run('DELETE FROM password_reset_limits');
    await client().signup('limits@example.com');
    await client().signup('reset-off@example.com');
    const jobs = async email => (await db().get('SELECT count(*) n FROM auth_mail_jobs WHERE recipient=?', email)).n;
    const ask = (email, e) => client(e).request('/api/auth/forgot-password', 'POST', { email });
    const first = await ask('limits@example.com');
    expect(first.status).toBe(200);
    await ask('limits@example.com'); await ask('limits@example.com');
    expect(await jobs('limits@example.com')).toBe(3);
    const limited = await ask('limits@example.com');
    expect(limited.status).toBe(200);
    expect(limited.data).toEqual(first.data);
    expect(await jobs('limits@example.com')).toBe(3);
    const off = prodEnv({ RESET_EMAIL_MODE: 'off' });
    expect((await client(off).request('/api/me')).data.password_reset_available).toBe(false);
    const quiet = await ask('reset-off@example.com', off);
    expect(quiet.status).toBe(200);
    expect(quiet.data).toEqual(first.data);
    expect(await jobs('reset-off@example.com')).toBe(0);
    expect(await db().get("SELECT count(*) n FROM password_resets r JOIN users u ON u.id=r.user_id WHERE u.email='reset-off@example.com'")).toEqual({ n: 0 });
    expect((await client().request('/api/me')).data.password_reset_available).toBe(true);
    await db().run("DELETE FROM auth_mail_jobs WHERE recipient IN ('limits@example.com','reset-off@example.com')"); // keep later cron tests independent
  });

  it('email failures stay private: a Resend failure is retried by cron, never shown to the requester', async () => {
    await db().run('DELETE FROM password_reset_limits');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ message: 'provider exploded: secret detail' }), { status: 500 }));
    const r = await client().request('/api/auth/forgot-password', 'POST', { email: 'b@example.com' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.data)).not.toMatch(/provider|exploded/);
    const out = await runScheduled(sendEnv(), db());
    expect(out.auth.failed).toBeGreaterThanOrEqual(1);
    const job = await db().get("SELECT status,last_error FROM auth_mail_jobs WHERE recipient='b@example.com' ORDER BY created_at DESC LIMIT 1");
    expect(job.status).toBe('retry');
    expect(job.last_error).not.toMatch(/exploded/);
  });
});
