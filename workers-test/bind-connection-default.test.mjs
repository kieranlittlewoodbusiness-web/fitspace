// RC-5 follow-up (CR #11 m1): bindConnection omits multiPt fail-closed (default false).
// Isolated D1 so the admin can resolve the single PT without an explicit pt_id.
import { describe, it, expect } from 'vitest';
import { bindConnection } from '../src/ops/accounts.mjs';
import { db, seedBlock, seedUser } from './helpers.mjs';

describe('bindConnection multiPt default', () => {
  it('omitting multiPt is fail-closed (same as false): admin can bind the one PT', async () => {
    const s = await seedBlock({ customers: 0, blockId: 'omit-bind' });
    const admin = await seedUser({ role: 'admin' });
    expect((await db().all('SELECT id FROM pts'))).toHaveLength(1);
    const accountId = 'acct_test_omit_bind';
    await db().run(
      "INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready,details_submitted,charges_enabled) VALUES(?,'stripe_test',?,'connected',0,0,0)",
      s.ptId, accountId
    );
    const view = await bindConnection(db(), {
      userId: admin.id, mode: 'stripe_test', accountId, routing: 'connected',
      ready: true, charges_enabled: true, payouts_enabled: true, details_submitted: true
    });
    expect(view).toMatchObject({ state: 'active', account_id: accountId, charges_enabled: true });
    expect(await db().get(
      'SELECT charges_enabled, payouts_enabled, details_submitted, ready FROM stripe_connections WHERE pt_id=?',
      s.ptId
    )).toEqual({ charges_enabled: 1, payouts_enabled: 1, details_submitted: 1, ready: 1 });
    await expect(bindConnection(db(), {
      userId: admin.id, mode: 'stripe_test', accountId, routing: 'connected',
      ready: true, charges_enabled: true, multiPt: true
    })).rejects.toMatchObject({ status: 400, code: 'PT_REQUIRED' });
  });
});
