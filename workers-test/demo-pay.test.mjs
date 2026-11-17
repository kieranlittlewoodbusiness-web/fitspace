import { describe, it, expect } from 'vitest';
import { exports } from 'cloudflare:workers';
import { db, seedBlock, insertBooking, jsonRequest, tally } from './helpers.mjs';

const pay = (user, id, result = 'success') => exports.default.fetch(jsonRequest(user, 'POST', `/api/bookings/${id}/pay`, { result }));
const mails = async id => (await db().get('SELECT count(*) n FROM email_outbox WHERE dedupe_key=?', 'confirmation:' + id)).n;

describe('completeDemo (Writer)', () => {
  it('5 concurrent "pay" calls: all 200, booking paid once, exactly 1 confirmation email', async () => {
    const { blockId, users } = await seedBlock({ customers: 1 });
    const id = await insertBooking({ blockId, customerId: users[0].id, status: 'pending' });
    const res = await Promise.all(Array.from({ length: 5 }, () => pay(users[0], id)));
    const bodies = await Promise.all(res.map(r => r.json()));
    const row = await db().get('SELECT status,paid_at FROM bookings WHERE id=?', id);
    console.log('completeDemo x5:', JSON.stringify(tally(res.map(r => r.status))), 'statuses', JSON.stringify(tally(bodies.map(b => b.booking.status))), 'emails', await mails(id));
    expect(tally(res.map(r => r.status))).toEqual({ 200: 5 });
    expect(bodies.every(b => b.booking.status === 'paid')).toBe(true);
    expect(row.status).toBe('paid');
    expect(await mails(id)).toBe(1);
  });

  it('success racing failure ends in one consistent state', async () => {
    const { blockId, users } = await seedBlock({ customers: 1 });
    const id = await insertBooking({ blockId, customerId: users[0].id, status: 'pending' });
    const res = await Promise.all([pay(users[0], id, 'success'), pay(users[0], id, 'failed'), pay(users[0], id, 'success'), pay(users[0], id, 'failed')]);
    const final = (await db().get('SELECT status FROM bookings WHERE id=?', id)).status;
    const emails = await mails(id);
    console.log('completeDemo success/fail race:', JSON.stringify(res.map(r => r.status)), 'final', final, 'emails', emails);
    expect(['paid', 'failed']).toContain(final);
    expect(emails).toBe(final === 'paid' ? 1 : 0);
  });

  it('an expired hold cannot be paid; another customer gets 404; a Stripe booking gets 403', async () => {
    const { blockId, users } = await seedBlock({ customers: 2 });
    const expired = await insertBooking({ blockId, customerId: users[0].id, status: 'pending', expiresAt: Date.now() - 1 });
    expect((await pay(users[0], expired)).status).toBe(409);
    expect((await db().get('SELECT status FROM bookings WHERE id=?', expired)).status).toBe('expired');
    const mine = await insertBooking({ blockId, customerId: users[0].id, status: 'pending' });
    expect((await pay(users[1], mine)).status).toBe(404);
    const stripeBooking = await insertBooking({ blockId, customerId: users[1].id, status: 'pending', mode: 'stripe_test' });
    expect((await pay(users[1], stripeBooking)).status).toBe(403);
  });
});
