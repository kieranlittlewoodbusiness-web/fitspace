// Writer Durable Object: serialises read-then-write flows per key (see writerKey below).
//
// Role (decided in RC-4 phase 2, after CR review 5940135102 M2/M3): DEFENCE IN DEPTH.
// Correctness of every shipped op lives in its ONE guarded db.batch() (count-form guarded
// inserts, `WHERE status=...` updates, db.guard() commit-time assertions, unique keys), and
// each op has a test that runs it concurrently WITHOUT the Writer and still holds its
// invariant. The queue adds: (1) ordering, so concurrent callers on one key see each
// other's committed state and get the precise message (full / already booked) instead of a
// generic "changed while you were editing" guard abort; (2) protection for any future op
// whose guard is incomplete. workers-test/writer.test.mjs proves the queue serialises a
// read-then-write op that oversells without it (Writer.run vs the same op called directly).
//
// A Durable Object does NOT hold other requests while it awaits D1, so the in-memory
// promise chain is what serialises. Two limits keep it from becoming a global bottleneck:
//   - keying: block-scoped ops use one instance per class block ('block:<id>'), cross-block
//     ops (webhooks, auth, admin, attendance, demo pay) use 'global';
//   - a queue-slot timeout (WRITER_SLOT_MS, default 2000 ms): a slow op releases its slot
//     after the timeout so later ops on the key proceed. The slow op is NOT cancelled and
//     its caller still receives its true result. Safe because of the guarded batches above.
//
// Errors with an HTTP status are returned as an envelope, because Workers RPC does not
// carry custom Error properties across the Durable Object boundary.
import { DurableObject } from 'cloudflare:workers';
import { createDb, withoutDb } from './db.mjs';
import { ops } from './ops/index.mjs';
import { errorExtras, httpError } from './util.mjs';

export const DEFAULT_SLOT_MS = 2000;
const BLOCK_KEYED = new Set(['reserve', 'updateBlock']);

/** Which Writer instance an op uses. */
export function writerKey(name, args) {
  if (BLOCK_KEYED.has(name) && typeof args?.blockId === 'string' && args.blockId) return 'block:' + args.blockId;
  return 'global';
}

export class Writer extends DurableObject {
  /** Overridable for tests (workers-test/entry.mjs adds probe ops). */
  static ops = ops;
  #tail = Promise.resolve();

  constructor(ctx, env) {
    super(ctx, env);
    this.db = createDb(env.DB);
    this.appEnv = withoutDb(env); // ops never see the raw binding (CR 5941600057 M4)
    this.slotMs = Number(env.WRITER_SLOT_MS) > 0 ? Number(env.WRITER_SLOT_MS) : DEFAULT_SLOT_MS;
  }

  async run(name, args) {
    const table = this.constructor.ops;
    const op = Object.hasOwn(table, name) ? table[name] : null;
    if (!op) return { error: { status: 500, message: 'Unknown writer operation.' } };
    const turn = this.#tail;
    const result = turn.then(() => op(this.db, args ?? {}, this.appEnv));
    // The slot is held from when this op STARTS until it settles or slotMs passes.
    this.#tail = turn.then(() => new Promise(release => {
      const timer = setTimeout(release, this.slotMs);
      result.then(() => {}, () => {}).finally(() => { clearTimeout(timer); release(); });
    }));
    try {
      return { value: await result };
    } catch (error) {
      if (error.status) return { error: { status: error.status, message: error.message, ...errorExtras(error) } };
      // Never echo SQL, bindings or stack traces.
      console.error('RC-4 writer operation failed:', name, error.code || error.name || 'Error');
      return { error: { status: 503, message: 'The booking service could not save your change. Please try again.' } };
    }
  }
}

/** Run a named writer operation on its keyed instance. `binding` is overridable for tests. */
export async function write(env, name, args, { binding = env.WRITER } = {}) {
  const stub = binding.get(binding.idFromName(writerKey(name, args)));
  const outcome = await stub.run(name, args);
  if (outcome.error) { const { status, message, ...extra } = outcome.error; throw httpError(status, message, extra); }
  return outcome.value;
}
