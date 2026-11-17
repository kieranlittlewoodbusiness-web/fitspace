// Test-only entry: the real Worker plus TestWriter, the REAL Writer class (same run()/queue
// code) with extra probe ops and a short queue-slot timeout. Not part of the shipped bundle.
import { Writer } from '../src/writer.mjs';
import { ops } from '../src/ops/index.mjs';
import { httpError } from '../src/util.mjs';
export { default, Writer } from '../worker/index.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Deliberately UNGUARDED read-then-write (no batch, no guard), with a yield between the
// read and the write so concurrent callers deterministically interleave without a queue.
async function probeHold(db, { blockId, tag }) {
  const { n } = await db.get('SELECT count(*) n FROM probe_holds WHERE block_id=?', blockId);
  const { capacity } = await db.get('SELECT capacity FROM probe_blocks WHERE id=?', blockId);
  await pause(1);
  if (n >= capacity) return 'full';
  await db.run('INSERT INTO probe_holds(block_id,tag) VALUES(?,?)', blockId, tag);
  return 'held';
}
const probeOps = {
  probeHold,
  sleep: async (_db, { ms, label }) => { await pause(ms); return { label, at: Date.now() }; },
  throwsStatus: async () => { throw httpError(418, 'Short and stout.'); },
  throwsPlain: async () => { throw new Error('SQLITE_ERROR near "secret_table": syntax error'); }
};

export class TestWriter extends Writer {
  static ops = { ...ops, ...probeOps };
  constructor(ctx, env) {
    super(ctx, env);
    this.slotMs = 150;
  }
}
export { probeHold };
