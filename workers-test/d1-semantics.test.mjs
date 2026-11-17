// Closes the "NOT verified" items from the RC-4 provider comparison, locally.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import crypto from 'node:crypto';
import { db, tally } from './helpers.mjs';

describe('D1 semantics (local workerd)', () => {
  it('rejects BEGIN and SAVEPOINT (no interactive transactions)', async () => {
    await expect(env.DB.prepare('BEGIN').run()).rejects.toThrow(/To execute a transaction/);
    await expect(env.DB.exec('SAVEPOINT s1')).rejects.toThrow(/To execute a transaction/);
  });

  it('batch() rolls back every statement when one fails', async () => {
    const d = db();
    await d.run('CREATE TABLE IF NOT EXISTS rb(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)');
    await d.run('INSERT INTO rb VALUES(1,0)');
    await expect(d.batch([
      d.stmt('UPDATE rb SET n=n+1 WHERE id=1'),
      d.stmt('INSERT INTO rb VALUES(2,1)'),
      d.stmt('INSERT INTO rb VALUES(1,99)') // PRIMARY KEY violation
    ])).rejects.toThrow(/UNIQUE constraint failed: rb.id/);
    const rows = await d.all('SELECT id,n FROM rb ORDER BY id');
    console.log('after failed batch:', JSON.stringify(rows));
    expect(rows).toEqual([{ id: 1, n: 0 }]);
  });

  it('RETURNING works on UPDATE, INSERT ... SELECT and DELETE, also inside batch()', async () => {
    const d = db();
    await d.run('CREATE TABLE IF NOT EXISTS rt(id TEXT PRIMARY KEY, n INTEGER NOT NULL)');
    const ins = await d.get("INSERT INTO rt SELECT 'a',1 WHERE 1 RETURNING *");
    const upd = await d.get("UPDATE rt SET n=n+1 WHERE id='a' AND n<5 RETURNING n");
    const none = await d.get("UPDATE rt SET n=n+1 WHERE id='a' AND n>100 RETURNING n");
    const [b1, b2] = await d.batch([d.stmt("INSERT INTO rt VALUES('b',7) RETURNING id"), d.stmt("DELETE FROM rt WHERE id='b' RETURNING n")]);
    console.log('RETURNING:', JSON.stringify({ ins, upd, none, batchInsert: b1.rows, batchDelete: b2.rows }));
    expect(ins).toEqual({ id: 'a', n: 1 });
    expect(upd).toEqual({ n: 2 });
    expect(none).toBeNull();
    expect(b1.rows).toEqual([{ id: 'b' }]);
    expect(b2.rows).toEqual([{ n: 7 }]);
  });

  it('a Durable Object does NOT hold other requests while awaiting D1, so the queue is needed', async () => {
    const d = db();
    await d.run('CREATE TABLE IF NOT EXISTS gate_blocks(id TEXT PRIMARY KEY, capacity INTEGER NOT NULL)');
    await d.run('CREATE TABLE IF NOT EXISTS gate_holds(block_id TEXT NOT NULL, tag TEXT NOT NULL)');
    const stub = env.GATE_PROBE.get(env.GATE_PROBE.idFromName('one'));
    const naiveRows = [], queuedRows = [];
    for (let round = 0; round < 10; round++) {
      const nb = 'naive-' + round, qb = 'queued-' + round;
      await d.batch([d.stmt('INSERT INTO gate_blocks VALUES(?,5)', nb), d.stmt('INSERT INTO gate_blocks VALUES(?,5)', qb)]);
      await Promise.all(Array.from({ length: 20 }, (_, i) => stub.naive(nb, 'n' + i)));
      await Promise.all(Array.from({ length: 20 }, (_, i) => stub.queued(qb, 'q' + i)));
      naiveRows.push((await d.get('SELECT count(*) n FROM gate_holds WHERE block_id=?', nb)).n);
      queuedRows.push((await d.get('SELECT count(*) n FROM gate_holds WHERE block_id=?', qb)).n);
    }
    console.log('DO gate probe, 10 rounds x 20 calls, capacity 5. Rows held per round: naive', JSON.stringify(naiveRows), '| queued', JSON.stringify(queuedRows));
    // Interleaving is timing-dependent, so any oversold round proves the DO does not
    // serialise across D1 awaits; the queued variant must never oversell.
    expect(Math.max(...naiveRows)).toBeGreaterThan(5);
    expect(queuedRows.every(n => n === 5)).toBe(true);
  });

  // Local workerd does NOT enforce CPU limits (Free: 10 ms/request); this only measures cost.
  it('scrypt cost per call inside local workerd', async () => {
    const t0 = performance.now(), d0 = Date.now();
    for (let i = 0; i < 5; i++) crypto.scryptSync('correct horse battery staple', crypto.randomBytes(16).toString('hex'), 64);
    const elapsed = { performanceNow: performance.now() - t0, dateNow: Date.now() - d0 };
    console.log('5x scryptSync (N=16384, r=8) inside local workerd (ms):', JSON.stringify(elapsed), 'per call ~', (elapsed.performanceNow / 5).toFixed(1));
    expect(elapsed.performanceNow).toBeGreaterThan(5 * 10); // above the Free plan's 10 ms CPU per request
  });
});
