// Serialised writer: one Durable Object instance through which every multi-step
// read-then-write flow runs (reserve, webhooks, completeDemo, password reset, refunds and
// the app/server.cjs tx() callers as they are ported).
//
// Why a queue: D1 has no interactive transactions, and a Durable Object does NOT hold
// other requests while it awaits a D1 call (proved by test/writer-gate.test.mjs). So the
// in-memory promise chain below is what gives BEGIN IMMEDIATE-like serialisation between
// writer operations. Each operation then commits with ONE db.batch() whose statements are
// guarded (WHERE status='pending', count < capacity, uses < max_uses, unique indexes), so
// the commit stays correct even against writes that do not go through the writer.
//
// Errors with an HTTP status are returned as an envelope, because Workers RPC does not
// carry custom Error properties across the Durable Object boundary.
import { DurableObject } from 'cloudflare:workers';
import { createDb } from './db.mjs';
import { ops } from './ops/index.mjs';
import { httpError } from './util.mjs';

export class Writer extends DurableObject {
  #tail = Promise.resolve();

  constructor(ctx, env) {
    super(ctx, env);
    this.db = createDb(env.DB);
  }

  async run(name, args) {
    const op = Object.hasOwn(ops, name) ? ops[name] : null;
    if (!op) return { error: { status: 500, message: 'Unknown writer operation.' } };
    const result = this.#tail.then(() => op(this.db, args ?? {}, this.env));
    this.#tail = result.catch(() => {});
    try {
      return { value: await result };
    } catch (error) {
      if (error.status) return { error: { status: error.status, message: error.message } };
      // Never echo SQL, bindings or stack traces.
      console.error('RC-4 writer operation failed:', name, error.code || error.name || 'Error');
      return { error: { status: 503, message: 'The booking service could not save your change. Please try again.' } };
    }
  }
}

/** Run a named writer operation. One global instance keeps ordering simple at this scale. */
export async function write(env, name, args) {
  const stub = env.WRITER.get(env.WRITER.idFromName('global'));
  const outcome = await stub.run(name, args);
  if (outcome.error) throw httpError(outcome.error.status, outcome.error.message);
  return outcome.value;
}
