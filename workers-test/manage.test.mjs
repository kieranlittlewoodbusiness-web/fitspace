import { describe, it, expect } from 'vitest';
import { exports } from 'cloudflare:workers';
import { reserve } from '../src/ops/bookings.mjs';
import { updateBlock, markAttendance } from '../src/ops/manage.mjs';
import { db, seedBlock, seedUser, insertBooking, jsonRequest, bookingRequest, tally } from './helpers.mjs';

const call = (user, method, path, body) => exports.default.fetch(jsonRequest(user, method, path, body));
const ptBody = (slug, create_key = crypto.randomUUID()) => ({ create_key, slug, brand_name: 'Test Studio', tagline: 'Strong every week', description: 'Small group strength classes.', about: 'Six-week blocks for all levels.', accent: '#cc3300', background: '#ffffff', foreground: '#111111', features: ['Small groups'], owner_name: 'Test Trainer', email: `${slug}@example.com` });
const blockBody = (over = {}) => ({ create_key: crypto.randomUUID(), title: 'Strength block', description: 'Six weeks', venue: 'Studio', price_pence: 1500, capacity: 5, sessions: [{ starts_at: '2099-01-05T18:30', duration_minutes: 60 }], ...over });

describe('admin: create PT', () => {
  it('5 concurrent creates with one slug: 1 created, 4 x 409; a PT cannot create PTs', async () => {
    const admin = await seedUser({ role: 'admin' });
    const slug = 'pt-' + crypto.randomUUID().slice(0, 8);
    const res = await Promise.all(Array.from({ length: 5 }, (_, i) => call(admin, 'POST', '/api/admin/pts', { ...ptBody(slug), email: `${slug}-${i}@example.com` })));
    console.log('createPt x5 same slug:', JSON.stringify(tally(res.map(r => r.status))));
    expect(tally(res.map(r => r.status))).toEqual({ 201: 1, 409: 4 });
    expect((await db().get('SELECT count(*) n FROM pts WHERE slug=?', slug)).n).toBe(1);
    const { ptId } = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId });
    expect((await call(pt, 'POST', '/api/admin/pts', ptBody('pt-' + crypto.randomUUID().slice(0, 8)))).status).toBe(403);
  });
});

describe('blocks: create/update through scopeFor', () => {
  it("a PT's create ignores body.pt_id; a PT cannot update another PT's block (404)", async () => {
    const a = await seedBlock({ customers: 0 }), b = await seedBlock({ customers: 0 });
    const ptA = await seedUser({ role: 'pt', ptId: a.ptId });
    const created = await call(ptA, 'POST', '/api/blocks', blockBody({ pt_id: b.ptId }));
    expect(created.status).toBe(201);
    const { block, replay } = await created.json();
    expect(replay).toBe(false);
    expect(block.pt_id).toBe(a.ptId);
    const cross = await call(ptA, 'PUT', '/api/blocks/' + b.blockId, blockBody({ title: 'Hijacked block' }));
    const own = await call(ptA, 'PUT', '/api/blocks/' + a.blockId, blockBody({ title: 'Renamed block' }));
    console.log('updateBlock cross-PT:', cross.status, 'own:', own.status);
    expect(cross.status).toBe(404);
    expect(own.status).toBe(200);
    expect((await db().get('SELECT title FROM blocks WHERE id=?', b.blockId)).title).toBe('Strength block');
    const customer = await seedUser({ role: 'customer' });
    expect((await call(customer, 'PUT', '/api/blocks/' + a.blockId, blockBody())).status).toBe(403);
  });

  it('capacity cut racing reservations (HTTP, Writer): holds never exceed the final capacity', async () => {
    const { ptId, blockId, users } = await seedBlock({ capacity: 5, customers: 6 });
    const pt = await seedUser({ role: 'pt', ptId });
    for (const u of users.slice(0, 2)) await insertBooking({ blockId, customerId: u.id, status: 'paid' });
    const res = await Promise.all([
      ...users.slice(2).map(u => exports.default.fetch(bookingRequest(u, blockId))),
      call(pt, 'PUT', '/api/blocks/' + blockId, blockBody({ capacity: 3 }))
    ]);
    const cap = (await db().get('SELECT capacity FROM blocks WHERE id=?', blockId)).capacity;
    const held = (await db().get("SELECT count(*) n FROM bookings WHERE block_id=? AND status IN ('paid','pending')", blockId)).n;
    console.log('capacity 5->3 vs 4 reservations (Writer):', JSON.stringify(res.map(r => r.status)), 'final capacity', cap, 'held', held);
    expect(held).toBeLessThanOrEqual(cap);
    const cut = res.at(-1);
    if (cut.status !== 200) {
      expect(cut.status).toBe(409);
      expect(await cut.json()).toMatchObject({ code: expect.stringMatching(/^(CAPACITY_BELOW_HOLDS|BOOKINGS_CHANGED)$/), retryable: true });
    }
  });

  it('capacity cut racing reservations with the Writer bypassed: the commit-time guard holds', async () => {
    for (let round = 0; round < 5; round++) {
      const { ptId, blockId, users } = await seedBlock({ capacity: 5, customers: 6 });
      const pt = await seedUser({ role: 'pt', ptId });
      for (const u of users.slice(0, 2)) await insertBooking({ blockId, customerId: u.id, status: 'paid' });
      const d = db();
      const r = await Promise.allSettled([
        ...users.slice(2).map(u => reserve(d, { userId: u.id, blockId, token: crypto.randomUUID() })),
        updateBlock(d, { userId: pt.id, blockId, body: blockBody({ capacity: 3 }) })
      ]);
      const cap = (await d.get('SELECT capacity FROM blocks WHERE id=?', blockId)).capacity;
      const held = (await d.get("SELECT count(*) n FROM bookings WHERE block_id=? AND status IN ('paid','pending')", blockId)).n;
      if (round === 0) console.log('capacity 5->3 vs 4 reservations (unqueued):', JSON.stringify(r.map(x => (x.status === 'fulfilled' ? 'ok' : x.reason.status))), 'final capacity', cap, 'held', held);
      expect(held).toBeLessThanOrEqual(cap);
      const cut = r.at(-1);
      if (cut.status === 'rejected') {
        expect(cut.reason.status).toBe(409);
        expect(cut.reason.code).toMatch(/^(CAPACITY_BELOW_HOLDS|BOOKINGS_CHANGED)$/);
        expect(cut.reason.retryable).toBe(true);
      }
    }
  });
});

describe('attendance', () => {
  async function pastBooking() {
    const s = await seedBlock({ customers: 2 });
    await db().run('INSERT INTO class_sessions VALUES(?,?,?,?,?)', s.blockId + '-past', s.blockId, '2020-01-06T18:30', Date.UTC(2020, 0, 6, 18, 30), 60);
    const bookingId = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'paid' });
    return { ...s, bookingId, sessionId: s.blockId + '-past' };
  }
  it('no-show marked 5x concurrently: 1 email; another PT gets 404', async () => {
    const s = await pastBooking();
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const other = await seedBlock({ customers: 0 });
    const otherPt = await seedUser({ role: 'pt', ptId: other.ptId });
    const cross = await call(otherPt, 'POST', '/api/attendance', { booking_id: s.bookingId, session_id: s.sessionId, status: 'no_show' });
    const res = await Promise.all(Array.from({ length: 5 }, () => call(pt, 'POST', '/api/attendance', { booking_id: s.bookingId, session_id: s.sessionId, status: 'no_show' })));
    const emails = (await db().get('SELECT count(*) n FROM email_outbox WHERE dedupe_key=?', `noshow:${s.bookingId}:${s.sessionId}`)).n;
    const rows = (await db().get('SELECT count(*) n FROM attendance WHERE booking_id=?', s.bookingId)).n;
    console.log('attendance no_show x5:', JSON.stringify(tally(res.map(r => r.status))), 'emails', emails, 'attendance rows', rows, '| cross-PT', cross.status);
    expect(cross.status).toBe(404);
    expect(tally(res.map(r => r.status))).toEqual({ 200: 5 });
    expect(emails).toBe(1);
    expect(rows).toBe(1);
  });
  it('attendance on a booking cancelled after the read is refused at commit time', async () => {
    const s = await pastBooking();
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const d = db();
    const r = await Promise.allSettled([
      markAttendance(d, { userId: pt.id, bookingId: s.bookingId, sessionId: s.sessionId, status: 'attended' }),
      d.run("UPDATE bookings SET status='cancelled' WHERE id=?", s.bookingId)
    ]);
    const att = await d.get('SELECT status FROM attendance WHERE booking_id=?', s.bookingId);
    // Either attendance committed before the cancel, or it was refused (409) and wrote nothing.
    if (r[0].status === 'rejected') { expect(r[0].reason.status).toBe(409); expect(att).toBeNull(); }
    else expect(att.status).toBe('attended');
  });
});

describe('retry-safe creates (create_key)', () => {
  it('createPt: a retry after a lost response returns the same PT and the same temporary password; 5 concurrent -> 1 PT', async () => {
    const admin = await seedUser({ role: 'admin' });
    const slug = 'pt-' + crypto.randomUUID().slice(0, 8), key = crypto.randomUUID();
    const first = await (await call(admin, 'POST', '/api/admin/pts', ptBody(slug, key))).json();
    const retry = await call(admin, 'POST', '/api/admin/pts', ptBody(slug, key));
    const retryBody = await retry.json();
    expect(retry.status).toBe(201);
    expect(retryBody).toMatchObject({ pt_id: first.pt_id, temporary_password: first.temporary_password, replay: true });
    const slug2 = 'pt-' + crypto.randomUUID().slice(0, 8), key2 = crypto.randomUUID();
    const burst = await Promise.all(Array.from({ length: 5 }, () => call(admin, 'POST', '/api/admin/pts', ptBody(slug2, key2))));
    const bodies = await Promise.all(burst.map(r => r.json()));
    const pts = (await db().get('SELECT count(*) n FROM pts WHERE slug=?', slug2)).n;
    console.log('createPt same key: retry', retry.status, 'same password', retryBody.temporary_password === first.temporary_password, '| x5 concurrent:', JSON.stringify(tally(burst.map(r => r.status))), 'pts', pts, 'distinct pt ids', new Set(bodies.map(b => b.pt_id)).size, 'distinct passwords', new Set(bodies.map(b => b.temporary_password)).size);
    expect(pts).toBe(1);
    expect(new Set(bodies.map(b => b.pt_id)).size).toBe(1);
    expect(new Set(bodies.map(b => b.temporary_password)).size).toBe(1);
    // The derived password really is the account's password.
    const { verifyPassword } = await import('../src/util.mjs');
    const hash = (await db().get('SELECT password_hash FROM users WHERE pt_id=?', first.pt_id)).password_hash;
    expect(verifyPassword(first.temporary_password, hash)).toBe(true);
    // Missing key -> 400 with a stable code.
    const nokey = await call(admin, 'POST', '/api/admin/pts', { ...ptBody('pt-' + crypto.randomUUID().slice(0, 8)), create_key: undefined });
    expect(nokey.status).toBe(400);
    expect((await nokey.json()).code).toBe('CREATE_KEY_REQUIRED');
  });

  it('createBlock: retry and 5 concurrent with one key -> 1 block; another PT reusing the key -> 409 without revealing it', async () => {
    const a = await seedBlock({ customers: 0 }), b = await seedBlock({ customers: 0 });
    const ptA = await seedUser({ role: 'pt', ptId: a.ptId }), ptB = await seedUser({ role: 'pt', ptId: b.ptId });
    const body = blockBody({ title: 'Keyed block' });
    const first = await (await call(ptA, 'POST', '/api/blocks', body)).json();
    const burst = await Promise.all(Array.from({ length: 5 }, () => call(ptA, 'POST', '/api/blocks', body)));
    const ids = await Promise.all(burst.map(async r => (await r.json()).block.id));
    const count = (await db().get('SELECT count(*) n FROM blocks WHERE create_key=?', body.create_key)).n;
    const cross = await call(ptB, 'POST', '/api/blocks', body);
    const crossBody = await cross.json();
    console.log('createBlock same key: first + x5 ->', JSON.stringify(tally(burst.map(r => r.status))), 'rows', count, 'distinct ids', new Set([first.block.id, ...ids]).size, '| other PT same key', cross.status, crossBody.code);
    expect(count).toBe(1);
    expect(new Set([first.block.id, ...ids]).size).toBe(1);
    expect(cross.status).toBe(409);
    expect(crossBody.code).toBe('CREATE_KEY_REUSED');
    expect(JSON.stringify(crossBody)).not.toContain(first.block.id);
  });

  it('createBlock with the Writer bypassed: 5 concurrent with one key -> 1 block (unique key)', async () => {
    const { createBlock } = await import('../src/ops/manage.mjs');
    const a = await seedBlock({ customers: 0 });
    const pt = await seedUser({ role: 'pt', ptId: a.ptId });
    const body = blockBody();
    const r = await Promise.all(Array.from({ length: 5 }, () => createBlock(db(), { userId: pt.id, body })));
    expect(new Set(r.map(x => x.block.id)).size).toBe(1);
    expect(tally(r.map(x => (x.replay ? 'replay' : 'created')))).toEqual({ created: 1, replay: 4 });
  });
});

describe('capacity cut (PM ruling: clear, retryable 409)', () => {
  it('the cut gets 409 CAPACITY_BELOW_HOLDS with a retry hint, then succeeds once the holds clear', async () => {
    const { ptId, blockId, users } = await seedBlock({ capacity: 5, customers: 4 });
    const pt = await seedUser({ role: 'pt', ptId });
    for (const u of users) expect((await exports.default.fetch(bookingRequest(u, blockId))).status).toBe(201);
    const cut = await call(pt, 'PUT', '/api/blocks/' + blockId, blockBody({ capacity: 2 }));
    const err = await cut.json();
    console.log('capacity cut with 4 live holds:', cut.status, JSON.stringify(err));
    expect(cut.status).toBe(409);
    expect(err).toMatchObject({ code: 'CAPACITY_BELOW_HOLDS', retryable: true });
    expect(err.error).toMatch(/0 paid, 4 reserved/);
    expect(err.retry_after_seconds).toBeGreaterThan(0);
    // Playbook: close the block to new holds, let holds expire (simulated), then cut.
    expect((await call(pt, 'PUT', '/api/blocks/' + blockId, blockBody({ capacity: 5, closed: true }))).status).toBe(200);
    expect((await exports.default.fetch(bookingRequest((await seedBlock({ customers: 1 })).users[0], blockId))).status).toBe(409);
    await db().run("UPDATE bookings SET expires_at=? WHERE block_id=? AND status='pending'", Date.now() - 1, blockId);
    const retry = await call(pt, 'PUT', '/api/blocks/' + blockId, blockBody({ capacity: 2, closed: true }));
    console.log('capacity cut after holds expired:', retry.status);
    expect(retry.status).toBe(200);
    expect((await db().get('SELECT capacity FROM blocks WHERE id=?', blockId)).capacity).toBe(2);
  });

  it('paid places are not retryable by waiting: retryable=false, no retry_after', async () => {
    const { ptId, blockId, users } = await seedBlock({ capacity: 5, customers: 3 });
    const pt = await seedUser({ role: 'pt', ptId });
    for (const u of users) await insertBooking({ blockId, customerId: u.id, status: 'paid' });
    const cut = await call(pt, 'PUT', '/api/blocks/' + blockId, blockBody({ capacity: 2 }));
    const err = await cut.json();
    expect(cut.status).toBe(409);
    expect(err).toMatchObject({ code: 'CAPACITY_BELOW_HOLDS', retryable: false });
    expect(err.retry_after_seconds).toBeUndefined();
  });
});

