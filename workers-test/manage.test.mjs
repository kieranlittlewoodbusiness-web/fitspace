import { describe, it, expect } from 'vitest';
import { exports } from 'cloudflare:workers';
import { reserve } from '../src/ops/bookings.mjs';
import { updateBlock, markAttendance } from '../src/ops/manage.mjs';
import { db, seedBlock, seedUser, insertBooking, jsonRequest, bookingRequest, tally } from './helpers.mjs';

const call = (user, method, path, body) => exports.default.fetch(jsonRequest(user, method, path, body));
const ptBody = slug => ({ slug, brand_name: 'Test Studio', tagline: 'Strong every week', description: 'Small group strength classes.', about: 'Six-week blocks for all levels.', accent: '#cc3300', background: '#ffffff', foreground: '#111111', features: ['Small groups'], owner_name: 'Test Trainer', email: `${slug}@example.com` });
const blockBody = (over = {}) => ({ title: 'Strength block', description: 'Six weeks', venue: 'Studio', price_pence: 1500, capacity: 5, sessions: [{ starts_at: '2099-01-05T18:30', duration_minutes: 60 }], ...over });

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
    const { block } = await created.json();
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
