// Test-only entry: the real Worker plus a probe Durable Object used to answer
// "does a Durable Object hold other requests while it awaits D1?".
import { DurableObject } from 'cloudflare:workers';
import { createDb } from '../src/db.mjs';
export { default, Writer } from '../worker/index.mjs';

export class GateProbe extends DurableObject {
  #tail = Promise.resolve();
  // Read-then-write with awaits between the read and the write, NO queue.
  async naive(blockId, tag) {
    const db = createDb(this.env.DB);
    const { n } = await db.get('SELECT count(*) n FROM gate_holds WHERE block_id=?', blockId);
    const { capacity } = await db.get('SELECT capacity FROM gate_blocks WHERE id=?', blockId);
    if (n >= capacity) return 'full';
    await db.run('INSERT INTO gate_holds(block_id,tag) VALUES(?,?)', blockId, tag);
    return 'held';
  }
  // Same logic behind the Writer's promise-queue pattern.
  async queued(blockId, tag) {
    const result = this.#tail.then(() => this.naive(blockId, tag));
    this.#tail = result.catch(() => {});
    return result;
  }
}
