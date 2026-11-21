// CR 5940914487 M5: guards that the global Writer queue used to hide. Every test here calls
// the op directly on D1 (Writer bypassed) with concurrent callers, or drives the exact
// Worker check, so removing the guard makes the test fail (see docs §7 mutation table).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:workers';
import nodeCrypto from 'node:crypto';
import worker from '../worker/index.mjs';
import { prepareRefund, prepareConnect, completeJob } from '../src/ops/stripe-jobs.mjs';
import { createPt, createBlock, updateBlock, markAttendance } from '../src/ops/manage.mjs';
import { requestReset } from '../src/ops/password-reset.mjs';
import { deliverAuthMail } from '../src/mail.mjs';
import { seal } from '../src/pt-credentials.mjs';
import { db, seedBlock, seedUser, insertBooking, jsonRequest, ORIGIN, tally } from './helpers.mjs';

afterEach(() => vi.restoreAllMocks());
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const settle = list => Promise.allSettled(list).then(r => r.map(x => (x.status === 'fulfilled' ? x.value : { error: x.reason?.status || x.reason?.message })));

describe('guards with the Writer bypassed (direct D1, concurrent)', () => {
  it('one_active_refund: 5 concurrent refund requests (different tokens) create exactly 1 refund job', async () => {
    const s = await seedBlock({ customers: 1 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const bk = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'paid', mode: 'stripe_test', extra: { stripe_account_id: 'acct_test_x', stripe_routing: 'connected', payment_intent: 'pi_test_' + nodeCrypto.randomBytes(6).toString('hex') } });
    const out = await settle(Array.from({ length: 5 }, () => prepareRefund(db(), { bookingId: bk, userId: pt.id, token: crypto.randomUUID(), mode: 'stripe_test' })));
    const jobs = await db().all("SELECT id FROM stripe_jobs WHERE target_id=? AND kind='refund'", bk);
    console.log('one_active_refund direct x5:', JSON.stringify(tally(out.map(o => (typeof o === 'string' ? 'job' : 'err:' + o.error)))), 'jobs', jobs.length);
    expect(jobs).toHaveLength(1);
    expect(out.every(o => o === jobs[0].id)).toBe(true);
  });

  it('job_not_done (account kind): 5 concurrent completeJob calls bind once and chain exactly 1 onboarding job', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const jobId = await prepareConnect(db(), { userId: pt.id, origin: ORIGIN, mode: 'stripe_test', multiPt: true });
    expect(jobId).toMatch(/^account:/);
    const account = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
    const out = await settle(Array.from({ length: 5 }, () => completeJob(db(), { id: jobId, result: { id: account } })));
    const onboard = await db().all("SELECT id FROM stripe_jobs WHERE target_id=? AND kind='onboard'", s.ptId);
    console.log('job_not_done account direct x5: onboarding jobs', onboard.length, 'distinct results', new Set(out.map(o => JSON.stringify(o))).size);
    expect(onboard).toHaveLength(1);
    expect(out.every(o => o.stripe_next === onboard[0].id)).toBe(true);
    expect(await db().get('SELECT account_id FROM stripe_connections WHERE pt_id=?', s.ptId)).toEqual({ account_id: account });
  });

  it('job_not_done (refund kind): 5 concurrent completeJob calls record the refund once, consistent result', async () => {
    const s = await seedBlock({ customers: 1 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const pi = 'pi_test_' + nodeCrypto.randomBytes(6).toString('hex');
    const bk = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'paid', mode: 'stripe_test', extra: { stripe_account_id: 'acct_test_x', stripe_routing: 'connected', payment_intent: pi } });
    const jobId = await prepareRefund(db(), { bookingId: bk, userId: pt.id, token: crypto.randomUUID(), mode: 'stripe_test' });
    const refund = { id: 're_test_' + nodeCrypto.randomBytes(6).toString('hex'), status: 'succeeded', amount: 1500, currency: 'gbp', payment_intent: pi };
    const out = await settle(Array.from({ length: 5 }, () => completeJob(db(), { id: jobId, result: refund })));
    expect(out.every(o => o.refund_id === refund.id)).toBe(true);
    expect(await db().all('SELECT id,amount_pence,status FROM stripe_refunds WHERE booking_id=?', bk)).toEqual([{ id: refund.id, amount_pence: 1500, status: 'succeeded' }]);
    expect(await db().get('SELECT status,refund_status,refunded_pence FROM bookings WHERE id=?', bk)).toEqual({ status: 'cancelled', refund_status: 'succeeded', refunded_pence: 1500 });
    expect(await db().get('SELECT status FROM stripe_jobs WHERE id=?', jobId)).toEqual({ status: 'done' });
  });

  it('pts_create_key: 5 concurrent createPt calls with one key create 1 PT; all callers get it', async () => {
    const admin = await seedUser({ role: 'admin' });
    const slug = 'guard-' + nodeCrypto.randomBytes(4).toString('hex');
    const body = { create_key: crypto.randomUUID(), owner_name: 'Guard Trainer', email: slug + '@example.com', brand_name: 'GUARD CLUB', slug, tagline: 'Guards hold.', description: 'Commit-time checks.', about: 'Train with guards.', accent: '#ffd43b', background: '#ffffff', foreground: '#111111', features: ['One'], published: true };
    const out = await settle(Array.from({ length: 5 }, () => createPt(db(), { userId: admin.id, body, temporaryHash: 'x', temporary: 'TempPass123!', multiPt: true })));
    const rows = await db().all('SELECT id FROM pts WHERE slug=?', slug);
    console.log('pts_create_key direct x5:', JSON.stringify(tally(out.map(o => (o.pt_id ? (o.replay ? 'replay' : 'created') : 'err:' + o.error)))));
    expect(rows).toHaveLength(1);
    expect(out.every(o => o.pt_id === rows[0].id)).toBe(true);
    expect(out.filter(o => o.replay === false)).toHaveLength(1);
  });

  it('auth-mail claim: two overlapping deliverAuthMail runs send each reset link exactly once', async () => {
    const s = await seedBlock({ customers: 3 });
    for (const u of s.users) await requestReset(db(), { email: `${u.id}@example.com` }, env);
    const sent = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      sent.push(new Headers(init.headers).get('Idempotency-Key'));
      await new Promise(r => setTimeout(r, 25));
      return json(200, { id: 'email_' + sent.length });
    });
    const now = Date.now();
    const [a, b] = await Promise.all([deliverAuthMail(env, db(), { now }), deliverAuthMail(env, db(), { now })]);
    console.log('auth-mail claim, 2 overlapping runs:', JSON.stringify({ a, b, sends: sent.length, distinct: new Set(sent).size }));
    expect(sent.length).toBe(3);
    expect(new Set(sent).size).toBe(3);
    expect(a.sent + b.sent).toBe(3);
  });
});

describe('PT webhook: the re-fetched event must match the signed one', () => {
  const ptDirectEnv = () => Object.assign(Object.create(null), env, { PAYMENT_MODE: 'stripe_test', STRIPE_INTEGRATION: 'pt_direct' });
  it('same id but a different type or object id is refused with the match error; nothing recorded', async () => {
    const s = await seedBlock({ customers: 1 });
    const row = { id: crypto.randomUUID(), pt_id: s.ptId, mode: 'stripe_test' };
    const key = 'rk_test_' + nodeCrypto.randomBytes(12).toString('hex'), whsec = 'whsec_' + nodeCrypto.randomBytes(16).toString('hex');
    const account = 'acct_direct_' + row.id.slice(0, 8);
    await db().run('INSERT INTO pt_stripe_credentials(id,pt_id,mode,account_id,api_cipher,webhook_cipher,enabled,charges_ready,created_at) VALUES(?,?,?,?,?,?,1,1,?)', row.id, s.ptId, 'stripe_test', account, seal(env, key, row, 'api'), seal(env, whsec, row, 'webhook'), Date.now());
    const pi = 'pi_test_' + nodeCrypto.randomBytes(6).toString('hex');
    const bk = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'paid', mode: 'stripe_test', extra: { stripe_account_id: account, stripe_routing: 'platform', stripe_credential_id: row.id, payment_intent: pi } });
    const event = { id: 'evt_test_' + nodeCrypto.randomBytes(6).toString('hex'), type: 'charge.refunded', livemode: false, data: { object: { id: 'ch_test_1', payment_intent: pi, amount: 1500, amount_refunded: 1500, currency: 'gbp', livemode: false } } };
    const signed = payload => {
      const raw = JSON.stringify(payload), t = Math.floor(Date.now() / 1000);
      const v1 = nodeCrypto.createHmac('sha256', whsec).update(t + '.' + raw).digest('hex');
      return new Request(`${ORIGIN}/api/stripe/pt/${row.id}/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${v1}`, 'content-type': 'application/json' }, body: raw });
    };
    // Each variant is a fully valid, applicable event on its own; only the match check refuses it.
    for (const authoritative of [{ ...event, data: { object: { ...event.data.object, id: 'ch_test_other' } } }, { ...event, type: 'charge.refund.updated' }]) {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(200, authoritative));
      const r = await worker.fetch(signed(event), ptDirectEnv());
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe('Webhook event does not belong to this account.');
      vi.restoreAllMocks();
    }
    expect(await db().get('SELECT id FROM webhook_events WHERE id LIKE ?', '%' + event.id)).toBeNull();
    expect(await db().get('SELECT status,refunded_pence FROM bookings WHERE id=?', bk)).toEqual({ status: 'paid', refunded_pence: 0 });
    // Control: the matching copy is applied.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(200, event));
    expect((await worker.fetch(signed(event), ptDirectEnv())).status).toBe(200);
    expect(await db().get('SELECT status,refunded_pence FROM bookings WHERE id=?', bk)).toEqual({ status: 'cancelled', refunded_pence: 1500 });
  });
});

describe('PT_INVITE_SECRET must be 32+ characters before any trainer is created', () => {
  const body = () => { const slug = 'inv-' + nodeCrypto.randomBytes(4).toString('hex'); return { create_key: crypto.randomUUID(), owner_name: 'Invite Trainer', email: slug + '@example.com', brand_name: 'INVITE CLUB', slug, tagline: 'Invites.', description: 'Secret checks.', about: 'Secret checks first.', accent: '#ffd43b', background: '#ffffff', foreground: '#111111', features: ['One'], published: true }; };
  it('missing, empty or 31-character secret -> 503 and nothing written; 32 characters -> 201', async () => {
    const admin = await seedUser({ role: 'admin' });
    for (const secret of [undefined, '', 'x'.repeat(31)]) {
      const b = body();
      const r = await worker.fetch(jsonRequest(admin, 'POST', '/api/admin/pts', b), Object.assign(Object.create(null), env, { PT_INVITE_SECRET: secret }));
      expect(r.status, String(secret?.length)).toBe(503);
      expect((await r.json()).error).toMatch(/PT_INVITE_SECRET/);
      expect(await db().get('SELECT id FROM pts WHERE slug=?', b.slug)).toBeNull();
      expect(await db().get('SELECT id FROM users WHERE email=?', b.email)).toBeNull();
    }
    const ok = await worker.fetch(jsonRequest(admin, 'POST', '/api/admin/pts', body()), Object.assign(Object.create(null), env, { PT_INVITE_SECRET: 'y'.repeat(32) }));
    expect(ok.status).toBe(201);
  });
});

describe('minor 1: create_key reused with a different payload', () => {
  it('createPt: same key + same details replays; same key + new details -> 409 CREATE_KEY_REUSED, nothing changed', async () => {
    const admin = await seedUser({ role: 'admin' });
    const slug = 'reuse-' + nodeCrypto.randomBytes(4).toString('hex');
    const body = { create_key: crypto.randomUUID(), owner_name: 'Reuse Trainer', email: slug + '@example.com', brand_name: 'REUSE CLUB', slug, tagline: 'Once.', description: 'Create once.', about: 'Create exactly once.', accent: '#ffd43b', background: '#ffffff', foreground: '#111111', features: ['One'], published: true };
    const first = await worker.fetch(jsonRequest(admin, 'POST', '/api/admin/pts', body), env);
    expect(first.status).toBe(201);
    const id = (await first.json()).pt_id;
    const again = await (await worker.fetch(jsonRequest(admin, 'POST', '/api/admin/pts', body), env)).json();
    expect(again).toMatchObject({ pt_id: id, replay: true });
    const changed = await worker.fetch(jsonRequest(admin, 'POST', '/api/admin/pts', { ...body, slug: slug + '-new', brand_name: 'NEW NAME' }), env);
    expect(changed.status).toBe(409);
    expect((await changed.json()).code).toBe('CREATE_KEY_REUSED');
    expect(await db().all('SELECT slug,brand_name FROM pts WHERE create_key=?', body.create_key)).toEqual([{ slug, brand_name: 'REUSE CLUB' }]);
  });

  it('createBlock: same key + same details replays; a new title, price or session list -> 409 CREATE_KEY_REUSED', async () => {
    const s = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const body = { create_key: crypto.randomUUID(), title: 'Keyed block', description: 'Created once.', venue: 'Studio', price_pence: 2000, capacity: 5, published: true, sessions: [{ starts_at: '2099-02-01T18:30', duration_minutes: 60 }] };
    const first = await createBlock(db(), { userId: pt.id, body });
    expect(first.replay).toBe(false);
    expect((await createBlock(db(), { userId: pt.id, body })).block.id).toBe(first.block.id);
    for (const change of [{ title: 'Another title' }, { price_pence: 2500 }, { sessions: [{ starts_at: '2099-02-08T18:30', duration_minutes: 60 }] }]) {
      await expect(createBlock(db(), { userId: pt.id, body: { ...body, ...change } })).rejects.toMatchObject({ status: 409, code: 'CREATE_KEY_REUSED' });
    }
    expect(await db().all('SELECT title,price_pence FROM blocks WHERE create_key=?', body.create_key)).toEqual([{ title: 'Keyed block', price_pence: 2000 }]);
  });
});

// A concurrent commit landing between an op's reads and its batch, made deterministic: the
// proxied db runs `sql` (another writer's change) immediately before the op's own batch.
const interleaved = (sql, ...args) => {
  const real = db();
  let done = false;
  return { ...real, async batch(statements) { if (!done) { done = true; await real.run(sql, ...args); } return real.batch(statements); } };
};

describe('guards against a commit between read and write (no Writer)', () => {
  it('capacity_not_below_holds: a reservation landing after the read makes the capacity cut fail (BOOKINGS_CHANGED)', async () => {
    const s = await seedBlock({ customers: 4, capacity: 5 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    for (const u of s.users.slice(0, 3)) await insertBooking({ blockId: s.blockId, customerId: u.id, status: 'paid' });
    const body = { title: 'Strength block', description: 'Six weeks', venue: 'Studio', price_pence: 1500, capacity: 3, sessions: [{ starts_at: '2099-01-05T18:30', duration_minutes: 60 }] };
    const late = `INSERT INTO bookings(id,block_id,customer_id,reference,status,amount_pence,mode,checkout_token,expires_at,created_at) VALUES('bk-late-${s.blockId}',?,?,'FIT-LATE','pending',1500,'demo',?,?,?)`;
    await expect(updateBlock(interleaved(late, s.blockId, s.users[3].id, crypto.randomUUID(), Date.now() + 600000, Date.now()), { userId: pt.id, blockId: s.blockId, body })).rejects.toMatchObject({ status: 409, code: 'BOOKINGS_CHANGED' });
    expect((await db().get('SELECT capacity FROM blocks WHERE id=?', s.blockId)).capacity).toBe(5);
  });

  it('dates_unlocked: a booking landing after the read stops the schedule rewrite', async () => {
    const s = await seedBlock({ customers: 1, capacity: 5 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const body = { title: 'Strength block', description: 'Six weeks', venue: 'Studio', price_pence: 1500, capacity: 5, sessions: [{ starts_at: '2099-03-05T18:30', duration_minutes: 60 }] };
    const late = `INSERT INTO bookings(id,block_id,customer_id,reference,status,amount_pence,mode,checkout_token,expires_at,created_at) VALUES('bk-late-${s.blockId}',?,?,'FIT-LATE2','paid',1500,'demo',?,?,?)`;
    await expect(updateBlock(interleaved(late, s.blockId, s.users[0].id, crypto.randomUUID(), Date.now() + 600000, Date.now()), { userId: pt.id, blockId: s.blockId, body })).rejects.toMatchObject({ status: 409, code: 'BOOKINGS_CHANGED' });
    expect(await db().all('SELECT starts_at FROM class_sessions WHERE block_id=?', s.blockId)).toEqual([{ starts_at: '2099-01-05T18:30' }]);
  });

  it('booking_still_paid: a cancellation landing after the read stops the attendance write', async () => {
    const s = await seedBlock({ customers: 1 });
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const bk = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'paid' });
    await db().run('UPDATE class_sessions SET starts_epoch=? WHERE block_id=?', Date.now() - 86400000, s.blockId);
    await expect(markAttendance(interleaved("UPDATE bookings SET status='cancelled' WHERE id=?", bk), { userId: pt.id, bookingId: bk, sessionId: s.blockId + '-s0', status: 'attended' })).rejects.toMatchObject({ status: 409 });
    expect(await db().get('SELECT * FROM attendance WHERE booking_id=?', bk)).toBeNull();
  });

  it('account_not_other_pt: an account already bound to another PT is refused at commit; nothing bound', async () => {
    const a = await seedBlock({ customers: 0 }), b = await seedBlock({ customers: 0 });
    const ptA = await seedUser({ role: 'pt', ptId: a.ptId });
    const account = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
    await db().run("INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready) VALUES(?,'stripe_test',?,'connected',1)", b.ptId, account);
    const jobId = await prepareConnect(db(), { userId: ptA.id, origin: ORIGIN, mode: 'stripe_test', multiPt: true });
    await expect(completeJob(db(), { id: jobId, result: { id: account } })).rejects.toMatchObject({ status: 409 });
    expect(await db().get('SELECT * FROM stripe_connections WHERE pt_id=?', a.ptId)).toBeNull();
    expect(await db().get("SELECT count(*) n FROM stripe_jobs WHERE target_id=? AND kind='onboard'", a.ptId)).toEqual({ n: 0 });
  });

  it('checkout_session_matches: a different Checkout Session for a booking that already has one is refused', async () => {
    const s = await seedBlock({ customers: 1 });
    const bk = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'pending', mode: 'stripe_test', extra: { checkout_session: 'cs_test_first', checkout_url: 'https://checkout.stripe.com/first' } });
    const jobId = 'checkout:' + bk;
    await db().run("INSERT INTO stripe_jobs(id,kind,target_id,actor_id,payload,created_at) VALUES(?,'checkout',?,?,?,?)", jobId, bk, s.users[0].id, JSON.stringify({ mode: 'stripe_test' }), Date.now());
    await expect(completeJob(db(), { id: jobId, result: { id: 'cs_test_second', url: 'https://checkout.stripe.com/second' } })).rejects.toMatchObject({ status: 409 });
    expect(await db().get('SELECT checkout_session,checkout_url FROM bookings WHERE id=?', bk)).toEqual({ checkout_session: 'cs_test_first', checkout_url: 'https://checkout.stripe.com/first' });
    expect(await db().get('SELECT status FROM stripe_jobs WHERE id=?', jobId)).toEqual({ status: 'pending' });
  });
});
