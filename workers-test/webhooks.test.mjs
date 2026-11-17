import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { handle } from '../worker/index.mjs';
import { handleWebhook } from '../src/ops/webhooks.mjs';
import { db, seedBlock, signedWebhook, tally } from './helpers.mjs';

const stripeEnv = { ...env, PAYMENT_MODE: 'stripe_test', STRIPE_INTEGRATION: 'connect' };

async function pendingStripeBooking() {
  const { ptId, blockId, users } = await seedBlock({ capacity: 5, customers: 1 });
  const id = 'bk-' + crypto.randomUUID(), cs = 'cs_test_' + crypto.randomUUID().replaceAll('-', '');
  await db().run(
    "INSERT INTO bookings(id,block_id,customer_id,reference,status,amount_pence,mode,checkout_token,checkout_session,expires_at,created_at,stripe_account_id,stripe_routing) VALUES(?,?,?,?,'pending',1500,'stripe_test',?,?,?,?,?,'connected')",
    id, blockId, users[0].id, 'FIT-' + id.slice(3, 11).toUpperCase(), crypto.randomUUID(), cs, Date.now() + 30 * 60000, Date.now(), 'acct_test123'
  );
  return { id, cs, ptId };
}
const completed = ({ id, cs, ptId }, eventId = 'evt_' + crypto.randomUUID().replaceAll('-', '')) => ({
  id: eventId, type: 'checkout.session.completed', livemode: false, account: 'acct_test123',
  data: { object: { id: cs, object: 'checkout.session', livemode: false, mode: 'payment', payment_status: 'paid', amount_total: 1500, currency: 'gbp', payment_intent: 'pi_test_' + id.slice(3, 15), metadata: { booking_id: id, pt_id: ptId } } }
});

describe('webhook idempotency', () => {
  it('the same signed event delivered 5 times concurrently over HTTP is applied once', async () => {
    const b = await pendingStripeBooking();
    const event = completed(b);
    const make = signedWebhook(event);
    const responses = await Promise.all(Array.from({ length: 5 }, () => handle(make(), stripeEnv)));
    const bodies = await Promise.all(responses.map(r => r.json()));
    const d = db();
    const booking = await d.get('SELECT status,paid_at,payment_intent FROM bookings WHERE id=?', b.id);
    const events = await d.get('SELECT count(*) n FROM webhook_events WHERE id=?', event.id);
    const mails = await d.get("SELECT count(*) n FROM email_outbox WHERE dedupe_key=?", 'confirmation:' + b.id);
    console.log('webhook x5 HTTP:', JSON.stringify(tally(bodies.map(x => (x.duplicate ? 'duplicate' : x.received ? 'received' : 'other')))), 'status:', booking.status, 'webhook_events:', events.n, 'confirmation emails:', mails.n);
    expect(responses.every(r => r.status === 200)).toBe(true);
    expect(tally(bodies.map(x => (x.duplicate ? 'duplicate' : 'received')))).toEqual({ received: 1, duplicate: 4 });
    expect(booking.status).toBe('paid');
    expect(booking.payment_intent).toMatch(/^pi_test_/);
    expect(events.n).toBe(1);
    expect(mails.n).toBe(1);
  });

  it('bypassing the Writer, the webhook_events PRIMARY KEY still applies a duplicate once', async () => {
    const b = await pendingStripeBooking();
    const event = completed(b);
    const d = db();
    const results = await Promise.all(Array.from({ length: 5 }, () => handleWebhook(d, { event, mode: 'stripe_test' })));
    const mails = await d.get("SELECT count(*) n FROM email_outbox WHERE dedupe_key=?", 'confirmation:' + b.id);
    console.log('webhook x5 direct (unqueued):', JSON.stringify(tally(results.map(x => (x.duplicate ? 'duplicate' : 'received')))), 'confirmation emails:', mails.n);
    expect(tally(results.map(x => (x.duplicate ? 'duplicate' : 'received')))).toEqual({ received: 1, duplicate: 4 });
    expect(mails.n).toBe(1);
  });

  it('a different event for an already-paid booking does not re-confirm or change status', async () => {
    const b = await pendingStripeBooking();
    await handleWebhook(db(), { event: completed(b), mode: 'stripe_test' });
    const second = await handleWebhook(db(), { event: { ...completed(b), type: 'checkout.session.async_payment_succeeded' }, mode: 'stripe_test' });
    expect(second).toEqual({ received: true });
    expect((await db().get('SELECT status FROM bookings WHERE id=?', b.id)).status).toBe('paid');
    expect((await db().get("SELECT count(*) n FROM email_outbox WHERE dedupe_key=?", 'confirmation:' + b.id)).n).toBe(1);
  });

  it('a late success after the hold lapsed goes to review, not paid', async () => {
    const b = await pendingStripeBooking();
    await db().run('UPDATE bookings SET expires_at=? WHERE id=?', Date.now() - 1, b.id);
    await handleWebhook(db(), { event: completed(b), mode: 'stripe_test' });
    expect((await db().get('SELECT status FROM bookings WHERE id=?', b.id)).status).toBe('review');
    expect((await db().get("SELECT count(*) n FROM email_outbox WHERE dedupe_key=?", 'confirmation:' + b.id)).n).toBe(0);
  });

  it('rejects a bad signature, an amount mismatch, and a live event in test mode', async () => {
    const b = await pendingStripeBooking();
    const before = (await db().get('SELECT count(*) n FROM webhook_events')).n;
    await expect(handle(signedWebhook(completed(b), 'not-the-secret')(), stripeEnv)).rejects.toMatchObject({ status: 400, message: 'Invalid webhook signature.' });
    const wrongAmount = completed(b); wrongAmount.data.object.amount_total = 1;
    await expect(handleWebhook(db(), { event: wrongAmount, mode: 'stripe_test' })).rejects.toMatchObject({ status: 400 });
    await expect(handleWebhook(db(), { event: { ...completed(b), livemode: true }, mode: 'stripe_test' })).rejects.toMatchObject({ status: 403 });
    expect((await db().get('SELECT count(*) n FROM webhook_events')).n).toBe(before);
    expect((await db().get('SELECT status FROM bookings WHERE id=?', b.id)).status).toBe('pending');
  });
});
