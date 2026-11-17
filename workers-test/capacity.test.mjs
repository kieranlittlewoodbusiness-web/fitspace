import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { reserve } from '../src/ops/bookings.mjs';
import { db, seedBlock, bookingRequest, tally } from './helpers.mjs';

describe('capacity holds (reserve)', () => {
  it('20 concurrent HTTP reservations at capacity 5 hold exactly 5 places', async () => {
    const { blockId, users } = await seedBlock({ capacity: 5, customers: 20 });
    const responses = await Promise.all(users.map(u => exports.default.fetch(bookingRequest(u, blockId))));
    const statuses = responses.map(r => r.status);
    const bodies = await Promise.all(responses.map(r => r.json()));
    const held = await db().get("SELECT count(*) n FROM bookings WHERE block_id=? AND status='pending'", blockId);
    console.log('HTTP x20 cap 5 statuses:', JSON.stringify(tally(statuses)), 'held rows:', held.n);
    expect(tally(statuses)).toEqual({ 201: 5, 409: 15 });
    expect(bodies.filter(b => b.error).every(b => b.error === 'This block is full. Please choose another class.')).toBe(true);
    expect(held.n).toBe(5);
  });

  it('the count-form guarded INSERT alone holds exactly 5 when 20 reserves interleave (no Writer queue)', async () => {
    const { blockId, users } = await seedBlock({ capacity: 5, customers: 20 });
    const d = db();
    const results = await Promise.allSettled(users.map(u => reserve(d, { userId: u.id, blockId, token: crypto.randomUUID() })));
    const outcome = results.map(r => (r.status === 'fulfilled' ? 'held' : r.reason.status === 409 ? 'full' : 'error:' + r.reason.message));
    const held = await d.get("SELECT count(*) n FROM bookings WHERE block_id=? AND status IN ('pending','paid')", blockId);
    console.log('direct reserve x20 cap 5 (unqueued):', JSON.stringify(tally(outcome)), 'held rows:', held.n);
    expect(tally(outcome)).toEqual({ held: 5, full: 15 });
    expect(held.n).toBe(5);
  });

  it('a retried checkout token returns the same hold; a second token for the same customer is refused', async () => {
    const { blockId, users } = await seedBlock({ capacity: 5, customers: 1 });
    const token = crypto.randomUUID();
    const [a, b] = await Promise.all([exports.default.fetch(bookingRequest(users[0], blockId, token)), exports.default.fetch(bookingRequest(users[0], blockId, token))]);
    const [ja, jb] = [await a.json(), await b.json()];
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(ja.booking.id).toBe(jb.booking.id);
    const again = await exports.default.fetch(bookingRequest(users[0], blockId));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/already have a booking/);
  });

  it('the partial unique index blocks a second live booking even when the read check is bypassed', async () => {
    const { blockId, users } = await seedBlock({ capacity: 5, customers: 1 });
    const d = db();
    const insert = token => d.run("INSERT INTO bookings(id,block_id,customer_id,reference,status,amount_pence,mode,checkout_token,expires_at,created_at) VALUES(?,?,?,?, 'pending',1500,'demo',?,?,?)", crypto.randomUUID(), blockId, users[0].id, 'FIT-' + token.slice(0, 8), token, Date.now() + 60000, Date.now());
    await insert(crypto.randomUUID());
    await expect(insert(crypto.randomUUID())).rejects.toThrow(/UNIQUE constraint failed: bookings.block_id, bookings.customer_id/);
  });

  it('expired holds free their place inside the same batch', async () => {
    const { blockId, users } = await seedBlock({ capacity: 1, customers: 2 });
    const d = db();
    await d.run("INSERT INTO bookings(id,block_id,customer_id,reference,status,amount_pence,mode,checkout_token,expires_at,created_at) VALUES('old',?,?,'FIT-OLD','pending',1500,'demo','old-token-000000',?,?)", blockId, users[0].id, Date.now() - 1, Date.now() - 1000);
    const res = await exports.default.fetch(bookingRequest(users[1], blockId));
    expect(res.status).toBe(201);
    expect((await d.get("SELECT status FROM bookings WHERE id='old'")).status).toBe('expired');
  });
});
