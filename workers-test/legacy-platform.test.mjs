// Port of app/tests/platform.test.cjs (all 10 tests) to the Worker + D1. The data is the
// app's own demo seed, produced in the live snapshot format and loaded through the real
// snapshot -> D1 import (scripts/snapshot-import.mjs; see vitest.workers.config.mjs).
// Differences from the original are marked "PORT:".
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:workers';
import nodeCrypto from 'node:crypto';
import worker from '../worker/index.mjs';
import { verifyWebhook } from '../src/stripe-webhook.mjs';
import { toEpoch } from '../src/validate.mjs';
import { MOTIVATIONS } from '../src/validate.mjs';
import { db, ORIGIN } from './helpers.mjs';

// PORT: the original ran createApp({demo:true}); demo accounts log in only with DEMO_MODE.
const demoEnv = (over = {}) => Object.assign(Object.create(null), env, { DEMO_MODE: 'true' }, over);
let ipCounter = 0;
function client(e = demoEnv()) {
  let cookie = '', csrf = '';
  const ip = '10.9.' + Math.floor(ipCounter / 250) + '.' + (ipCounter++ % 250);
  return {
    async request(url, method = 'GET', body, options = {}) {
      const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: options.origin || ORIGIN } : {}), ...(csrf && !options.noCsrf ? { 'X-CSRF-Token': csrf } : {}) };
      const response = await worker.fetch(new Request(ORIGIN + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e);
      const data = await response.json();
      const set = response.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      if (data.csrf) csrf = data.csrf;
      return { status: response.status, data };
    },
    async login(email) { const r = await this.request('/api/auth/login', 'POST', { email, password: 'TrainTogether123!' }); expect(r.status).toBe(200); return r; },
    async signup(email, extra = {}) { const r = await this.request('/api/auth/signup', 'POST', { name: 'Test Customer', email, password: 'CustomerPassword123!', demo_acknowledged: true, ...extra }); expect(r.status).toBe(201); return r; }
  };
}
const future = (days = 20) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10) + 'T18:30'; };
// PORT: create_key is now required on creates (CR 5940418854 condition 3); app.js sends it.
const blockPayload = (o = {}) => ({ create_key: crypto.randomUUID(), title: 'Eight-week test block', description: 'Coached training to build a consistent routine.', venue: 'Test studio', price_pence: 12000, capacity: 15, published: true, sessions: Array.from({ length: 8 }, (_, i) => ({ starts_at: future(20 + i * 7), duration_minutes: 60 })), ...o });
const brandPayload = (o = {}) => ({ create_key: crypto.randomUUID(), owner_name: 'New Trainer', email: 'new-trainer@example.com', brand_name: 'NEW TRAINING CLUB', slug: 'new-training-club', tagline: 'Move with purpose. Build your confidence.', description: 'Personal coaching and a supportive small group.', about: 'Build strength and conditioning with a routine that works for you.', accent: '#438bff', background: '#ffffff', foreground: '#101c34', features: ['Strength coaching', 'A supportive group', 'Flexible class blocks'], published: true, ...o });

beforeAll(async () => {
  const statements = JSON.parse(env.DEMO_SNAPSHOT_SQL);
  const d = db();
  for (let i = 0; i < statements.length; i += 50) await d.batch(statements.slice(i, i + 50).map(s => d.stmt(s)));
  console.log('legacy suite: imported demo snapshot rows', statements.length);
});

describe('ported app/tests/platform.test.cjs', () => {
  it('public pages show distinct PT brands and flexible block lengths', async () => {
    const c = client();
    const one = await c.request('/api/public/pts/six-week-club'), two = await c.request('/api/public/pts/studio-move');
    expect(one.status).toBe(200);
    expect(one.data.blocks[0].sessions.length).toBe(6);
    expect(two.data.blocks.some(b => b.sessions.length === 4)).toBe(true);
    expect(two.data.blocks.some(b => b.sessions.length === 1)).toBe(true);
    expect(one.data.pt.accent).not.toBe(two.data.pt.accent);
    expect(one.data.blocks.every(b => b.available === 15)).toBe(true);
    expect((await c.request('/api/dashboard')).status).toBe(401);
  });

  it('customers cannot grant themselves admin or PT access', async () => {
    const c = client();
    const signup = await c.signup('access-test@example.com', { role: 'admin', pt_id: 'pt-six' });
    expect(signup.data.user.role).toBe('customer');
    expect((await c.request('/api/admin/pts', 'POST', brandPayload())).status).toBe(403);
    expect((await c.request('/api/blocks', 'POST', blockPayload())).status).toBe(403);
    expect((await c.request('/api/attendance', 'POST', { booking_id: 'booking-demo', session_id: 'block-attendance-session-0', status: 'no_show' })).status).toBe(403);
  });

  it('PTs can create arbitrary blocks, but cannot access another PT’s clients or classes', async () => {
    const a = client(), b = client();
    await a.login('pt@example.com'); await b.login('studio@example.com');
    const result = await a.request('/api/blocks', 'POST', blockPayload());
    expect(result.status).toBe(201);
    expect(result.data.block.sessions.length).toBe(8);
    expect((await b.request('/api/blocks/' + result.data.block.id, 'PUT', blockPayload())).status).toBe(404);
    expect((await b.request('/api/bookings/booking-demo')).status).toBe(404);
    expect((await b.request('/api/attendance', 'POST', { booking_id: 'booking-demo', session_id: 'block-attendance-session-0', status: 'no_show' })).status).toBe(404);
    expect((await a.request('/api/admin/pts', 'POST', brandPayload())).status).toBe(403);
  });

  it('admin creates a branded PT account and temporary password must be changed', async () => {
    const admin = client(); await admin.login('admin@example.com');
    const created = await admin.request('/api/admin/pts', 'POST', brandPayload());
    expect(created.status).toBe(201);
    expect(created.data.temporary_password.length).toBeGreaterThanOrEqual(12);
    const page = await client().request('/api/public/pts/new-training-club');
    expect(page.data.pt.brand_name).toBe('NEW TRAINING CLUB');
    expect(page.data.pt.accent).toBe('#438bff');
    const trainer = client();
    const login = await trainer.request('/api/auth/login', 'POST', { email: created.data.email, password: created.data.temporary_password });
    expect(login.data.user.role).toBe('pt');
    expect(login.data.user.must_change_password).toBe(true);
    expect((await trainer.request('/api/blocks', 'POST', blockPayload())).status).toBe(403);
    const changed = await trainer.request('/api/auth/password', 'POST', { current_password: created.data.temporary_password, new_password: 'FreshTrainerPassword123!' });
    expect(changed.status).toBe(200);
    expect((await trainer.request('/api/blocks', 'POST', blockPayload({ sessions: [{ starts_at: future(30), duration_minutes: 45 }], price_pence: 1800, capacity: 12 }))).status).toBe(201);
    expect((await admin.request('/api/admin/pts/' + created.data.pt_id, 'PUT', brandPayload({ accent: '#ffd43b', slug: 'stronger-club', background: '#111111', foreground: '#ffffff' }))).status).toBe(200);
    expect((await client().request('/api/public/pts/stronger-club')).data.pt.foreground).toBe('#ffffff');
    expect((await admin.request('/api/admin/pts/' + created.data.pt_id, 'PUT', brandPayload({ background: '#ffffff', foreground: '#eeeeee' }))).status).toBe(400);
  });

  it('concurrent reservations enforce capacity, retries are idempotent and price is server-owned', async () => {
    const trainer = client(); await trainer.login('pt@example.com');
    const created = await trainer.request('/api/blocks', 'POST', blockPayload({ title: 'One-place class', capacity: 1, sessions: [{ starts_at: future(40), duration_minutes: 60 }], price_pence: 2500 }));
    const id = created.data.block.id, a = client(), b = client();
    await a.signup('booking-a@example.com'); await b.signup('booking-b@example.com');
    const token = crypto.randomUUID();
    const results = await Promise.all([a.request('/api/bookings', 'POST', { block_id: id, checkout_token: token, price_pence: 1 }), b.request('/api/bookings', 'POST', { block_id: id, checkout_token: crypto.randomUUID() })]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    const owner = results[0].status === 201 ? a : b, other = owner === a ? b : a, reservation = results.find(r => r.status === 201).data.booking;
    expect(reservation.amount_pence).toBe(2500);
    const stored = await db().get('SELECT checkout_token FROM bookings WHERE id=?', reservation.id);
    const repeat = await owner.request('/api/bookings', 'POST', { block_id: id, checkout_token: stored.checkout_token });
    expect(repeat.data.booking.id).toBe(reservation.id);
    expect((await other.request('/api/bookings/' + reservation.id + '/pay', 'POST', { result: 'success' })).status).toBe(404);
    const paid = await owner.request('/api/bookings/' + reservation.id + '/pay', 'POST', { result: 'success' });
    expect(paid.data.booking.status).toBe('paid');
    expect((await owner.request('/api/bookings/' + reservation.id + '/pay', 'POST', { result: 'success' })).status).toBe(200);
    expect((await db().get('SELECT count(*) n FROM email_outbox WHERE dedupe_key=?', 'confirmation:' + reservation.id)).n).toBe(1);
    expect((await trainer.request('/api/blocks/' + id, 'PUT', blockPayload({ title: 'One-place class', capacity: 1, sessions: [{ starts_at: future(41), duration_minutes: 60 }], price_pence: 2500 }))).status).toBe(409);
    expect((await owner.request('/api/bookings/' + reservation.id + '/cancel', 'POST', {})).status).toBe(200);
    const publicPage = await client().request('/api/public/pts/six-week-club');
    expect(publicPage.data.blocks.find(c => c.id === id).available).toBe(1);
  });

  it('declined checkouts release places and abandoned holds expire', async () => {
    const trainer = client(); await trainer.login('pt@example.com');
    const created = await trainer.request('/api/blocks', 'POST', blockPayload({ title: 'Release test', capacity: 1, sessions: [{ starts_at: future(42), duration_minutes: 60 }] }));
    const c = client(); await c.signup('decline-test@example.com');
    const reserved = await c.request('/api/bookings', 'POST', { block_id: created.data.block.id, checkout_token: crypto.randomUUID() });
    const failed = await c.request('/api/bookings/' + reserved.data.booking.id + '/pay', 'POST', { result: 'declined' });
    expect(failed.data.booking.status).toBe('failed');
    const second = await c.request('/api/bookings', 'POST', { block_id: created.data.block.id, checkout_token: crypto.randomUUID() });
    await db().run('UPDATE bookings SET expires_at=? WHERE id=?', Date.now() - 100, second.data.booking.id);
    // PORT: payments.expire(db) -> the same sweep runs on public/dashboard reads and in cron.
    const publicPage = await client().request('/api/public/pts/six-week-club');
    expect(publicPage.data.blocks.find(b => b.id === created.data.block.id).available).toBe(1);
    expect((await c.request('/api/bookings/' + second.data.booking.id + '/pay', 'POST', { result: 'success' })).status).toBe(409);
  });

  it('no-show marking generates one supportive email from 20 replies and respects PT isolation', async () => {
    expect(MOTIVATIONS.length).toBe(20);
    expect(new Set(MOTIVATIONS).size).toBe(20);
    const trainer = client(); await trainer.login('pt@example.com');
    const payload = { booking_id: 'booking-demo', session_id: 'block-attendance-session-0', status: 'no_show' };
    const first = await trainer.request('/api/attendance', 'POST', payload);
    expect(first.status).toBe(200);
    expect(first.data.email.subject).toBe('Sorry we missed you at class!');
    expect(first.data.email.status).toBe('preview');
    expect(MOTIVATIONS.some(q => first.data.email.body.includes(q))).toBe(true);
    const again = await trainer.request('/api/attendance', 'POST', payload);
    expect(again.data.email.id).toBe(first.data.email.id);
    expect(again.data.email.body).toBe(first.data.email.body);
    expect((await db().get("SELECT count(*) n FROM email_outbox WHERE kind='no_show' AND customer_id='customer-demo'")).n).toBe(1);
    const attended = await trainer.request('/api/attendance', 'POST', { ...payload, status: 'attended' });
    expect(attended.status).toBe(200);
    expect(attended.data.email).toBeNull();
    const dashboard = await trainer.request('/api/dashboard');
    expect(dashboard.data.bookings.find(b => b.id === 'booking-demo').sessions[0].attendance_status).toBe('attended');
  });

  it('future attendance, forged webhooks and cross-site mutations are rejected', async () => {
    const trainer = client(); await trainer.login('pt@example.com');
    const customer = client(); await customer.signup('future-attendance@example.com');
    const booking = await customer.request('/api/bookings', 'POST', { block_id: 'block-six', checkout_token: crypto.randomUUID() });
    await customer.request('/api/bookings/' + booking.data.booking.id + '/pay', 'POST', { result: 'success' });
    expect((await trainer.request('/api/attendance', 'POST', { booking_id: booking.data.booking.id, session_id: 'block-six-session-0', status: 'no_show' })).status).toBe(409);
    expect((await trainer.request('/api/blocks', 'POST', blockPayload(), { origin: 'https://other.example' })).status).toBe(403);
    expect((await trainer.request('/api/blocks', 'POST', blockPayload(), { noCsrf: true })).status).toBe(403);
    expect(() => verifyWebhook('{}', 't=1,v1=invalid', 'secret', 'stripe_test')).toThrow();
    expect(() => toEpoch('2027-03-28T01:30')).toThrow();
    expect(toEpoch('2026-10-19T18:30')).toBe(Date.parse('2026-10-19T17:30:00Z'));
    expect(toEpoch('2026-10-26T18:30')).toBe(Date.parse('2026-10-26T18:30:00Z'));
  });

  it('signed Stripe test events are account/amount checked and idempotent', async () => {
    // PORT: through the HTTP webhook endpoint (Writer + D1) instead of payments.handleWebhook(db).
    const d = db();
    const booking = await d.get("SELECT * FROM bookings WHERE status='paid' AND customer_id!='customer-demo' LIMIT 1");
    await d.run("UPDATE pts SET stripe_account='acct_test_pt' WHERE id='pt-six'");
    await d.run("UPDATE bookings SET mode='stripe_test',status='pending',paid_at=NULL,expires_at=?,checkout_session='cs_test_verified' WHERE id=?", Date.now() + 60000, booking.id);
    const event = { id: 'evt_test_verified', livemode: false, type: 'checkout.session.completed', account: 'acct_test_pt', data: { object: { id: 'cs_test_verified', mode: 'payment', payment_intent: 'pi_test_verified', metadata: { booking_id: booking.id, pt_id: 'pt-six' }, payment_status: 'paid', amount_total: booking.amount_pence, currency: 'gbp' } } };
    const stripeEnv = demoEnv({ PAYMENT_MODE: 'stripe_test', STRIPE_INTEGRATION: 'connect' });
    const send = (payload, secret = env.STRIPE_WEBHOOK_SECRET) => {
      const raw = JSON.stringify(payload), stamp = String(Math.floor(Date.now() / 1000));
      const v1 = nodeCrypto.createHmac('sha256', secret).update(stamp + '.' + raw).digest('hex');
      return worker.fetch(new Request(ORIGIN + '/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': `t=${stamp},v1=${v1}` }, body: raw }), stripeEnv);
    };
    expect(await (await send(event)).json()).toMatchObject({ received: true });
    expect(await (await send(event)).json()).toMatchObject({ duplicate: true });
    expect((await d.get('SELECT status FROM bookings WHERE id=?', booking.id)).status).toBe('paid');
    expect((await send({ ...event, id: 'evt_wrong', account: 'acct_another_pt' })).status).toBe(400);
    expect((await send({ ...event, id: 'evt_live', livemode: true })).status).toBe(403);
    expect((await send({ ...event, id: 'evt_forged' }, 'whsec_wrong')).status).toBe(400);
  });

  it('passwords are hashed, sessions revoke on logout and state is persisted', async () => {
    const c = client(); await c.login('customer@example.com');
    const hash = (await db().get("SELECT password_hash FROM users WHERE id='customer-demo'")).password_hash;
    expect(hash).not.toBe('TrainTogether123!');
    expect((await c.request('/api/auth/logout', 'POST', {})).status).toBe(200);
    expect((await c.request('/api/dashboard')).status).toBe(401);
    // PORT: "persisted to SQLite" -> persisted in D1.
    expect((await db().get('SELECT count(*) n FROM bookings')).n).toBeGreaterThan(2);
  });

  it('PORT extra: demo accounts cannot sign in when DEMO_MODE is off (the production setting)', async () => {
    const c = client(demoEnv({ DEMO_MODE: undefined }));
    expect((await c.request('/api/auth/login', 'POST', { email: 'admin@example.com', password: 'TrainTogether123!' })).status).toBe(401);
  });
});
