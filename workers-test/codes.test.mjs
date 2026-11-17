import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { claimCode } from '../src/ops/codes.mjs';
import { write } from '../src/writer.mjs';
import { db, seedBlock, insertBooking, tally } from './helpers.mjs';

async function seedCode(maxUses, bookings = 1) {
  const { ptId, blockId, users } = await seedBlock({ customers: bookings });
  const id = 'code-' + crypto.randomUUID();
  await db().run("INSERT INTO discount_codes(id,code,owner,pt_id,scope,kind,amount,max_uses,created_by,created_at) VALUES(?,?,'pt',?,'all_classes','percent',10,?,?,?)", id, 'SPRING' + id.slice(-6), ptId, maxUses, users[0].id, Date.now());
  const bookingIds = [];
  for (const u of users) bookingIds.push(await insertBooking({ blockId, customerId: u.id, status: 'pending' }));
  return { id, bookingIds };
}
const uses = async id => (await db().get('SELECT uses FROM discount_codes WHERE id=?', id)).uses;

describe('discount code max_uses', () => {
  it('20 concurrent claims for 20 bookings with max_uses=5 succeed exactly 5 times (no queue)', async () => {
    const { id, bookingIds } = await seedCode(5, 20);
    const d = db();
    const results = await Promise.allSettled(bookingIds.map(bookingId => claimCode(d, { codeId: id, bookingId })));
    const outcome = results.map(r => (r.status === 'fulfilled' ? 'claimed' : r.reason.status === 409 ? 'limit' : 'error'));
    const redemptions = (await d.get('SELECT count(*) n FROM discount_redemptions WHERE code_id=?', id)).n;
    console.log('claimCode x20 max_uses 5:', JSON.stringify(tally(outcome)), 'uses:', await uses(id), 'redemptions:', redemptions);
    expect(tally(outcome)).toEqual({ claimed: 5, limit: 15 });
    expect(await uses(id)).toBe(5);
    expect(redemptions).toBe(5);
  });

  it('a retry for the same booking (lost response) does not count twice, also when concurrent', async () => {
    const { id, bookingIds: [bookingId] } = await seedCode(5);
    const first = await claimCode(db(), { codeId: id, bookingId });
    const retry = await claimCode(db(), { codeId: id, bookingId });
    const burst = await Promise.all(Array.from({ length: 10 }, () => claimCode(db(), { codeId: id, bookingId })));
    console.log('claimCode same booking: first', JSON.stringify({ uses: first.uses, replay: first.replay }), 'retry', JSON.stringify({ uses: retry.uses, replay: retry.replay }), 'x10 concurrent replays', burst.filter(r => r.replay).length, 'uses', await uses(id));
    expect(first).toMatchObject({ uses: 1, replay: false });
    expect(retry).toMatchObject({ uses: 1, replay: true, redemption_id: first.redemption_id });
    expect(burst.every(r => r.replay && r.redemption_id === first.redemption_id)).toBe(true);
    expect(await uses(id)).toBe(1);
  });

  it('10 concurrent FIRST claims for one booking (no prior row): counted once via the unique key', async () => {
    const { id, bookingIds: [bookingId] } = await seedCode(5);
    const r = await Promise.all(Array.from({ length: 10 }, () => claimCode(db(), { codeId: id, bookingId })));
    console.log('claimCode x10 first-claims same booking:', JSON.stringify(tally(r.map(x => (x.replay ? 'replay' : 'counted')))), 'uses', await uses(id));
    expect(tally(r.map(x => (x.replay ? 'replay' : 'counted')))).toEqual({ counted: 1, replay: 9 });
    expect(await uses(id)).toBe(1);
  });

  it('the same claims through the Writer also stop at max_uses', async () => {
    const { id, bookingIds } = await seedCode(3, 10);
    const results = await Promise.allSettled(bookingIds.map(bookingId => write(env, 'claimCode', { codeId: id, bookingId })));
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(3);
    expect(results.filter(r => r.status === 'rejected').every(r => r.reason.status === 409)).toBe(true);
  });

  it('the CHECK constraint refuses uses > max_uses even for an unguarded UPDATE', async () => {
    const { id } = await seedCode(1);
    await db().run('UPDATE discount_codes SET uses=1 WHERE id=?', id);
    await expect(db().run('UPDATE discount_codes SET uses=uses+1 WHERE id=?', id)).rejects.toThrow(/CHECK constraint failed/);
  });
});
