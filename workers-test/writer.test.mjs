// The REAL Writer class (TestWriter = Writer + probe ops) — CR 5940135102 M2/M3.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import { write, writerKey } from '../src/writer.mjs';
import { probeHold } from './entry.mjs';
import { db, tally } from './helpers.mjs';

const tw = (name, args) => write(env, name, args, { binding: env.TEST_WRITER });

async function probeBlock(capacity = 5) {
  const d = db();
  await d.run('CREATE TABLE IF NOT EXISTS probe_blocks(id TEXT PRIMARY KEY, capacity INTEGER NOT NULL)');
  await d.run('CREATE TABLE IF NOT EXISTS probe_holds(block_id TEXT NOT NULL, tag TEXT NOT NULL)');
  const id = 'probe-' + crypto.randomUUID();
  await d.run('INSERT INTO probe_blocks VALUES(?,?)', id, capacity);
  return id;
}
const held = async id => (await db().get('SELECT count(*) n FROM probe_holds WHERE block_id=?', id)).n;

describe('Writer queue (real Writer.run)', () => {
  it('an unguarded read-then-write oversells without the Writer and holds exactly 5 through it', async () => {
    const without = await probeBlock(), through = await probeBlock();
    const d = db();
    await Promise.all(Array.from({ length: 20 }, (_, i) => probeHold(d, { blockId: without, tag: 'n' + i })));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => tw('probeHold', { blockId: through, tag: 'q' + i })));
    console.log('unguarded probe x20 cap 5: without Writer held', await held(without), '| through Writer held', await held(through), JSON.stringify(tally(results)));
    expect(await held(without)).toBeGreaterThan(5);
    expect(await held(through)).toBe(5);
    expect(tally(results)).toEqual({ held: 5, full: 15 });
  });

  it('error envelope: unknown op 500, an HTTP status passes through, anything else 503 without internals', async () => {
    await expect(tw('nope', {})).rejects.toMatchObject({ status: 500, message: 'Unknown writer operation.' });
    await expect(tw('throwsStatus', {})).rejects.toMatchObject({ status: 418, message: 'Short and stout.' });
    const plain = await tw('throwsPlain', {}).catch(e => e);
    expect(plain.status).toBe(503);
    expect(plain.message).not.toMatch(/SQLITE|secret_table/);
    // A failed op does not wedge the queue.
    expect(await tw('sleep', { ms: 1, label: 'after-errors' })).toMatchObject({ label: 'after-errors' });
  });

  it('slot timeout: a slow op releases the queue after slotMs (150 ms) and its caller still gets the result', async () => {
    const t0 = Date.now();
    const slow = tw('sleep', { ms: 1200, label: 'slow' });
    await new Promise(r => setTimeout(r, 20));
    const fast = await tw('sleep', { ms: 1, label: 'fast' });
    const slowResult = await slow;
    console.log('slot timeout: fast finished after', fast.at - t0, 'ms; slow finished after', slowResult.at - t0, 'ms');
    expect(fast.at).toBeLessThan(slowResult.at);
    expect(fast.at - t0).toBeLessThan(800);
    expect(slowResult.label).toBe('slow');
  });

  it('without a timeout hit, ops on one key run strictly in order', async () => {
    const order = await Promise.all([tw('sleep', { ms: 60, label: 'a' }), tw('sleep', { ms: 1, label: 'b' })]);
    expect(order[0].at).toBeLessThanOrEqual(order[1].at);
  });

  it('keying: reserve/updateBlock use one instance per block; everything else is global', () => {
    expect(writerKey('reserve', { blockId: 'b1' })).toBe('block:b1');
    expect(writerKey('updateBlock', { blockId: 'b2' })).toBe('block:b2');
    expect(writerKey('reserve', {})).toBe('global');
    for (const name of ['handleWebhook', 'completeDemo', 'requestReset', 'resetPassword', 'createPt', 'createBlock', 'markAttendance', 'claimCode']) expect(writerKey(name, { blockId: 'b1' })).toBe('global');
  });

  it('different block keys are different instances: a slow op on block A does not delay block B', async () => {
    // Production binding: keys map to different instance ids. Then TestWriter (same class code)
    // shows a slow op on 'block:A' does not hold up 'block:B'.
    const a = env.WRITER.idFromName(writerKey('reserve', { blockId: 'A' }));
    const b = env.WRITER.idFromName(writerKey('reserve', { blockId: 'B' }));
    expect(a.equals(b)).toBe(false);
    const t0 = Date.now();
    const slow = env.TEST_WRITER.get(env.TEST_WRITER.idFromName('block:A')).run('sleep', { ms: 600, label: 'A' });
    const fast = await env.TEST_WRITER.get(env.TEST_WRITER.idFromName('block:B')).run('sleep', { ms: 1, label: 'B' });
    expect(fast.value.at - t0).toBeLessThan(300);
    await slow;
  });
});
