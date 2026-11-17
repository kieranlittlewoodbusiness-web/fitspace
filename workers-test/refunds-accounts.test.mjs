import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { write } from '../src/writer.mjs';
import { handleWebhook } from '../src/ops/webhooks.mjs';
import { db, seedBlock, insertBooking, tally } from './helpers.mjs';

const ACCT = 'acct_test123';
const rid = p => p + '_' + crypto.randomUUID().replaceAll('-', '');
async function paidStripeBooking() {
  const { blockId, users } = await seedBlock({ customers: 1 });
  const pi = rid('pi_test');
  const id = await insertBooking({ blockId, customerId: users[0].id, status: 'paid', mode: 'stripe_test', extra: { payment_intent: pi, stripe_account_id: ACCT, stripe_routing: 'connected' } });
  return { id, pi };
}
const refundEvent = (b, { refundId, amount, status, created, type = 'refund.updated', eventId = rid('evt') }) => ({
  id: eventId, type, created, livemode: false, account: ACCT,
  data: { object: { id: refundId, object: 'refund', amount, currency: 'gbp', status, payment_intent: b.pi, livemode: false } }
});
const hook = event => write(env, 'handleWebhook', { event, mode: 'stripe_test' });
const bookingRow = id => db().get('SELECT status,refunded_pence,refund_status,charge_refunded_pence FROM bookings WHERE id=?', id);
const outcome = r => (r.status === 'fulfilled' ? (r.value.duplicate ? 'duplicate' : 'received') : r.reason.status);

describe('refund webhooks (applyRefund without SAVEPOINT)', () => {
  it('the same refund event x5 concurrently: applied once; full refund cancels the booking', async () => {
    const b = await paidStripeBooking();
    const event = refundEvent(b, { refundId: rid('re'), amount: 1500, status: 'succeeded', created: 100 });
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => hook(event)));
    const row = await bookingRow(b.id);
    console.log('refund.updated x5 same event:', JSON.stringify(tally(r.map(outcome))), JSON.stringify(row));
    expect(tally(r.map(outcome))).toEqual({ received: 1, duplicate: 4 });
    expect(row).toMatchObject({ status: 'cancelled', refunded_pence: 1500, refund_status: 'succeeded' });
  });

  it('out of order: an older "pending" after "succeeded" changes nothing', async () => {
    const b = await paidStripeBooking();
    const refundId = rid('re');
    await hook(refundEvent(b, { refundId, amount: 500, status: 'succeeded', created: 200 }));
    await hook(refundEvent(b, { refundId, amount: 500, status: 'pending', created: 100, type: 'refund.created' }));
    const stored = await db().get('SELECT status,event_time FROM stripe_refunds WHERE id=?', refundId);
    const row = await bookingRow(b.id);
    console.log('refund out-of-order:', JSON.stringify(stored), JSON.stringify(row));
    expect(stored).toEqual({ status: 'succeeded', event_time: 200 });
    expect(row).toMatchObject({ status: 'paid', refunded_pence: 500, refund_status: 'partial' });
  });

  it('a newer "failed" replaces an older "pending"; the booking stays active', async () => {
    const b = await paidStripeBooking();
    const refundId = rid('re');
    await hook(refundEvent(b, { refundId, amount: 1500, status: 'pending', created: 100, type: 'refund.created' }));
    expect((await bookingRow(b.id)).refund_status).toBe('pending');
    await hook(refundEvent(b, { refundId, amount: 1500, status: 'failed', created: 101, type: 'refund.failed' }));
    expect(await bookingRow(b.id)).toMatchObject({ status: 'paid', refunded_pence: 0, refund_status: 'failed' });
  });

  it('total guard: refunds over the payment abort the whole event (key not recorded)', async () => {
    const b = await paidStripeBooking();
    await hook(refundEvent(b, { refundId: rid('re'), amount: 1000, status: 'succeeded', created: 100 }));
    const second = refundEvent(b, { refundId: rid('re'), amount: 1000, status: 'succeeded', created: 101 });
    await expect(hook(second)).rejects.toMatchObject({ status: 400, message: 'Refund total exceeds the booking payment.' });
    expect(await db().get('SELECT id FROM webhook_events WHERE id=?', second.id)).toBeNull();
    expect(await db().get('SELECT id FROM stripe_refunds WHERE id=?', second.data.object.id)).toBeNull();
    expect(await bookingRow(b.id)).toMatchObject({ status: 'paid', refunded_pence: 1000, refund_status: 'partial' });
  });

  it('two different refunds racing past the total (Writer bypassed): exactly one commits', async () => {
    const b = await paidStripeBooking();
    const d = db();
    const events = Array.from({ length: 4 }, (_, i) => refundEvent(b, { refundId: rid('re'), amount: 1000, status: 'succeeded', created: 100 + i }));
    const r = await Promise.allSettled(events.map(event => handleWebhook(d, { event, mode: 'stripe_test' })));
    const sum = (await d.get("SELECT coalesce(sum(amount_pence),0) s FROM stripe_refunds WHERE booking_id=? AND status='succeeded'", b.id)).s;
    console.log('4 refunds of 1000 on a 1500 booking (unqueued):', JSON.stringify(tally(r.map(outcome))), 'succeeded sum', sum);
    expect(tally(r.map(outcome))).toEqual({ received: 1, 400: 3 });
    expect(sum).toBe(1000);
  });

  it('charge.refunded is monotonic: an older, smaller total never lowers it', async () => {
    const b = await paidStripeBooking();
    const charge = (amount_refunded, created) => ({ id: rid('evt'), type: 'charge.refunded', created, livemode: false, account: ACCT, data: { object: { id: rid('ch'), object: 'charge', amount: 1500, amount_refunded, currency: 'gbp', payment_intent: b.pi, livemode: false } } });
    await hook(charge(1500, 200));
    await hook(charge(500, 100));
    const row = await bookingRow(b.id);
    console.log('charge.refunded 1500 then stale 500:', JSON.stringify(row));
    expect(row).toMatchObject({ status: 'cancelled', charge_refunded_pence: 1500, refunded_pence: 1500, refund_status: 'succeeded' });
  });
});

describe('account.updated', () => {
  async function connection() {
    const { ptId } = await seedBlock({ customers: 0 });
    const acct = rid('acct');
    await db().batch([
      db().stmt("INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready,updated_at) VALUES(?,'stripe_test',?,'connected',0,0)", ptId, acct),
      db().stmt('UPDATE pts SET stripe_account=? WHERE id=?', acct, ptId)
    ]);
    return { ptId, acct };
  }
  const update = (acct, created, enabled) => ({ id: rid('evt'), type: 'account.updated', created, livemode: false, account: acct, data: { object: { id: acct, object: 'account', charges_enabled: enabled, payouts_enabled: enabled, details_submitted: true, requirements: { currently_due: enabled ? [] : ['external_account'] } } } });

  it('applies a newer event and ignores a stale one delivered later', async () => {
    const { ptId, acct } = await connection();
    await hook(update(acct, 2000, true));
    await hook(update(acct, 1000, false));
    const c = await db().get('SELECT ready,charges_enabled,payouts_enabled,updated_at FROM stripe_connections WHERE pt_id=?', ptId);
    const pt = await db().get('SELECT stripe_ready FROM pts WHERE id=?', ptId);
    console.log('account.updated new(enabled) then stale(disabled):', JSON.stringify(c), 'pts.stripe_ready', pt.stripe_ready);
    expect(c).toEqual({ ready: 1, charges_enabled: 1, payouts_enabled: 1, updated_at: 2000000 });
  });

  it('the same account.updated x5 concurrently is applied once; a mismatched account is refused', async () => {
    const { acct } = await connection();
    const event = update(acct, 3000, true);
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => hook(event)));
    expect(tally(r.map(outcome))).toEqual({ received: 1, duplicate: 4 });
    const bad = update(acct, 4000, true); bad.data.object.id = rid('acct');
    await expect(hook(bad)).rejects.toMatchObject({ status: 400 });
  });
});
