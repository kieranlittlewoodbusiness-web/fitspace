// Tenant isolation (the D1 stand-in for row-level security): a PT can never read or change
// another PT's blocks, bookings or outbox, at the data layer and over HTTP.
import { describe, it, expect, beforeAll } from 'vitest';
import { exports } from 'cloudflare:workers';
import { scopeFor } from '../src/scope.mjs';
import { db, seedBlock, seedUser, bookingRequest, getRequest } from './helpers.mjs';

let a, b, ptA, ptB, admin, customerA, bookingA;
beforeAll(async () => {
  a = await seedBlock({ capacity: 5, customers: 1 });
  b = await seedBlock({ capacity: 5, customers: 1 });
  ptA = await seedUser({ role: 'pt', ptId: a.ptId });
  ptB = await seedUser({ role: 'pt', ptId: b.ptId });
  admin = await seedUser({ role: 'admin' });
  customerA = a.users[0];
  const res = await exports.default.fetch(bookingRequest(customerA, a.blockId));
  bookingA = (await res.json()).booking.id;
  await db().run("INSERT INTO email_outbox(id,pt_id,dedupe_key,recipient,subject,body,kind,status,created_at) VALUES('mail-a',?,'k-a','x@example.com','s','b','confirmation','preview',0)", a.ptId);
});

describe('tenant scope (data layer)', () => {
  it('a PT sees only their own blocks, bookings and outbox', async () => {
    const s = scopeFor(db(), ptB);
    expect(await s.block(a.blockId)).toBeNull();
    expect(await s.block(b.blockId)).toMatchObject({ id: b.blockId });
    expect((await s.blocks()).map(x => x.id)).toEqual([b.blockId]);
    expect(await s.booking(bookingA)).toBeNull();
    expect((await s.bookings()).map(x => x.id)).not.toContain(bookingA);
    expect((await s.outbox()).map(x => x.id)).not.toContain('mail-a');
    const own = scopeFor(db(), ptA);
    expect(await own.booking(bookingA)).toMatchObject({ id: bookingA, pt_id: a.ptId });
    expect((await own.outbox()).map(x => x.id)).toContain('mail-a');
  });

  it('a guarded update from another PT changes nothing', async () => {
    const d = db();
    const [r] = await d.batch([scopeFor(d, ptB).updateBlockStmt(a.blockId, 'title=?', 'Hijacked')]);
    expect(r.changes).toBe(0);
    expect((await d.get('SELECT title FROM blocks WHERE id=?', a.blockId)).title).toBe('Strength block');
    const [ok] = await d.batch([scopeFor(d, ptA).updateBlockStmt(a.blockId, 'title=?', 'Renamed by owner')]);
    expect(ok.changes).toBe(1);
  });

  it('customers cannot use PT management reads and see only their own bookings', async () => {
    const s = scopeFor(db(), { ...b.users[0], role: 'customer' });
    await expect(s.blocks()).rejects.toMatchObject({ status: 403 });
    expect(await s.booking(bookingA)).toBeNull();
  });

  it('a PT account without a pt_id is refused; admins are unscoped', async () => {
    expect(() => scopeFor(db(), { id: 'x', role: 'pt', pt_id: null })).toThrow(/does not have access/);
    expect(await scopeFor(db(), admin).booking(bookingA)).toMatchObject({ id: bookingA });
  });
});

describe('tenant scope (HTTP)', () => {
  it('GET /api/bookings/:id: owner PT 200, other PT 404, other customer 404, owner customer 200', async () => {
    const statuses = {};
    for (const [name, user] of Object.entries({ ptA, ptB, otherCustomer: b.users[0], customerA, admin })) {
      statuses[name] = (await exports.default.fetch(getRequest(user, '/api/bookings/' + bookingA))).status;
    }
    console.log('cross-tenant GET /api/bookings/:id statuses:', JSON.stringify(statuses));
    expect(statuses).toEqual({ ptA: 200, ptB: 404, otherCustomer: 404, customerA: 200, admin: 200 });
  });
});
