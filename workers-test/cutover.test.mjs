// PM ruling (17 Nov 2026), duplicate live bookings at cutover: the import halts with a
// report; the only resolution is an explicit opt-in that keeps the earliest PAID booking
// live and moves the others to 'review' for a manual refund decision. Never delete/refund.
import { describe, it, expect } from 'vitest';
import precheckSql from '../scripts/cutover-precheck.sql?raw';
import { DUPLICATE_REPORT_SQL, CONFIRM_PHRASE, importGate, markDuplicatesForReview } from '../src/cutover.mjs';
import { db, seedBlock, insertBooking } from './helpers.mjs';

const firstQuery = sql => sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean)[0];
const norm = s => s.replace(/\s+/g, ' ').trim();
const INDEX = "CREATE UNIQUE INDEX bookings_one_live_per_customer ON bookings(block_id,customer_id) WHERE status IN ('pending','paid')";

describe('cutover import gate', () => {
  it('halts with the exact report fields, refuses to mark without the phrase, then the opt-in keeps the earliest PAID booking', async () => {
    const d = db();
    // Simulate source data imported without the index (this file's isolated storage only).
    await d.run('DROP INDEX bookings_one_live_per_customer');
    const { blockId, users } = await seedBlock({ customers: 3 });
    const t = Date.now() - 3600_000;
    // Customer 0: pending (oldest), paid later, paid earliest -> keep the earliest PAID.
    const c0pending = await insertBooking({ blockId, customerId: users[0].id, status: 'pending', extra: { created_at: t } });
    const c0paidLate = await insertBooking({ blockId, customerId: users[0].id, status: 'paid', extra: { created_at: t + 10, paid_at: t + 500 } });
    const c0paidEarly = await insertBooking({ blockId, customerId: users[0].id, status: 'paid', extra: { created_at: t + 20, paid_at: t + 100, payment_intent: 'pi_test_secret_should_not_leak' } });
    // Customer 1: two pending, no payment -> keep the earliest booking.
    const c1first = await insertBooking({ blockId, customerId: users[1].id, status: 'pending', extra: { created_at: t + 1 } });
    const c1second = await insertBooking({ blockId, customerId: users[1].id, status: 'pending', extra: { created_at: t + 2 } });
    // Customer 2: one live booking -> not reported, not touched.
    const c2 = await insertBooking({ blockId, customerId: users[2].id, status: 'paid' });

    expect(norm(firstQuery(precheckSql))).toBe(norm(DUPLICATE_REPORT_SQL));
    const gate = await importGate(d);
    console.log('cutover gate:', JSON.stringify({ halted: gate.halted, groups: gate.groups, rows: gate.report.length, fields: Object.keys(gate.report[0]) }));
    expect(gate.halted).toBe(true);
    expect(gate.groups).toBe(2);
    expect(Object.keys(gate.report[0]).sort()).toEqual(['block_id', 'booking_id', 'created_at', 'customer_id', 'paid_at', 'payment_status', 'refund_status']);
    expect(gate.report.map(r => r.booking_id).sort()).toEqual([c0pending, c0paidLate, c0paidEarly, c1first, c1second].sort());
    expect(gate.report.find(r => r.booking_id === c0paidEarly)).toMatchObject({ customer_id: users[0].id, block_id: blockId, payment_status: 'paid', paid_at: t + 100, created_at: t + 20 });
    // No payment ids, card data, emails or names in the report.
    const text = JSON.stringify(gate.report);
    expect(text).not.toMatch(/pi_test|@|card|secret|cs_/);
    await expect(d.run(INDEX)).rejects.toThrow(/UNIQUE constraint failed/);

    // Opt-in only.
    await expect(markDuplicatesForReview(d, {})).rejects.toMatchObject({ status: 400 });
    await expect(markDuplicatesForReview(d, { confirm: 'yes' })).rejects.toMatchObject({ status: 400 });
    expect((await importGate(d)).halted).toBe(true);

    const { marked } = await markDuplicatesForReview(d, { confirm: CONFIRM_PHRASE, now: t + 9999 });
    const status = Object.fromEntries((await d.all(`SELECT id,status,refund_status,refunded_pence FROM bookings WHERE block_id=?`, blockId)).map(r => [r.id, r]));
    console.log('cutover opt-in marked', marked.length, '| kept', [c0paidEarly, c1first, c2].map(id => status[id].status).join(','));
    expect(marked.sort()).toEqual([c0pending, c0paidLate, c1second].sort());
    expect(status[c0paidEarly].status).toBe('paid');
    expect(status[c1first].status).toBe('pending');
    expect(status[c2].status).toBe('paid');
    for (const id of marked) expect(status[id]).toMatchObject({ status: 'review', refund_status: 'none', refunded_pence: 0 });
    const audits = await d.all("SELECT target_id FROM audit_log WHERE action='cutover_duplicate_review' ORDER BY target_id");
    expect(audits.map(a => a.target_id)).toEqual([...marked].sort());
    // Nothing deleted, gate passes, the index can now be created.
    expect((await d.get('SELECT count(*) n FROM bookings WHERE block_id=?', blockId)).n).toBe(6);
    expect((await importGate(d)).halted).toBe(false);
    await d.run(INDEX);
    // Re-running the opt-in is a no-op.
    expect((await markDuplicatesForReview(d, { confirm: CONFIRM_PHRASE })).marked).toEqual([]);
  });
});
