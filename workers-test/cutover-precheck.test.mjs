// The cutover pre-check finds data that would make 0002's partial unique index fail.
import { describe, it, expect } from 'vitest';
import precheckSql from '../scripts/cutover-precheck.sql?raw';
import { db, seedBlock, insertBooking } from './helpers.mjs';

const firstQuery = sql => sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean)[0];

describe('cutover pre-check', () => {
  it('reports duplicate live bookings that would break bookings_one_live_per_customer', async () => {
    const d = db();
    // Simulate source data imported without the index (this file's isolated storage only).
    await d.run('DROP INDEX bookings_one_live_per_customer');
    const { blockId, users } = await seedBlock({ customers: 2 });
    await insertBooking({ blockId, customerId: users[0].id, status: 'paid' });
    await insertBooking({ blockId, customerId: users[0].id, status: 'pending' });
    await insertBooking({ blockId, customerId: users[1].id, status: 'paid' });
    const rows = await d.all(firstQuery(precheckSql));
    console.log('cutover precheck rows:', rows.length, rows.map(r => r.problem + ' n=' + r.n).join(','));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ problem: 'duplicate_live_booking', customer_id: users[0].id, n: 2 });
    await expect(d.run("CREATE UNIQUE INDEX bookings_one_live_per_customer ON bookings(block_id,customer_id) WHERE status IN ('pending','paid')")).rejects.toThrow(/UNIQUE constraint failed/);
  });
});
