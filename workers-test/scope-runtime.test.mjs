// CR 5941600057 M4: runtime cross-PT checks, one per bypass CR reported at 036cb53 (db alias,
// object-property alias, env destructuring, comma join, \u and \x escapes). CR's probes went
// through GET /api/dashboard (worker/index.mjs -> src/views.mjs dashboard), so each case asserts
// that route returns only the caller's PT data, plus the structural guarantee behind it.
// `node workers-test/scope-bypass-mutations.mjs` injects each bypass into index and views and
// requires both this file and the scope lint to fail.
import { describe, it, expect, beforeAll } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { createDb, withoutDb } from '../src/db.mjs';
import { handle } from '../worker/index.mjs';
import { db, seedBlock, seedUser, getRequest, insertBooking } from './helpers.mjs';

let a, b, ptA, ptB, bookingsA, bookingsB;
beforeAll(async () => {
  a = await seedBlock({ capacity: 5, customers: 2 });
  b = await seedBlock({ capacity: 5, customers: 2 });
  ptA = await seedUser({ role: 'pt', ptId: a.ptId });
  ptB = await seedUser({ role: 'pt', ptId: b.ptId });
  bookingsA = [await insertBooking({ blockId: a.blockId, customerId: a.users[0].id }), await insertBooking({ blockId: a.blockId, customerId: a.users[1].id })];
  bookingsB = [await insertBooking({ blockId: b.blockId, customerId: b.users[0].id }), await insertBooking({ blockId: b.blockId, customerId: b.users[1].id })];
});

/** GET /api/dashboard as `pt`: 200, exactly its own bookings, and no id of the other PT's
 *  bookings, block, customers or PT anywhere in the response. */
async function noCrossPtLeak(pt, own, other) {
  const res = await exports.default.fetch(getRequest(pt, '/api/dashboard'));
  expect(res.status).toBe(200);
  const text = await res.text();
  const body = JSON.parse(text);
  expect(body.bookings.map(x => x.id).sort()).toEqual([...own.bookings].sort());
  for (const id of [...other.bookings, other.blockId, other.ptId, ...other.users.map(u => u.id)]) expect(text, id).not.toContain(id);
}
const both = async () => {
  await noCrossPtLeak(ptA, { bookings: bookingsA }, { ...b, bookings: bookingsB });
  await noCrossPtLeak(ptB, { bookings: bookingsB }, { ...a, bookings: bookingsA });
};

describe('runtime cross-PT isolation (CR 5941600057 M4)', () => {
  it('db alias (`const q = db; q.all(...)`): the PT dashboard returns only its own bookings', both);

  it('object-property alias (`o.h.all(...)`): no cross-PT rows; the wrapper is frozen and has no raw binding', async () => {
    await both();
    const w = createDb(env.DB);
    expect(Object.isFrozen(w)).toBe(true);
    expect('d1' in w).toBe(false);
    expect(Object.keys(w).sort()).toEqual(['all', 'batch', 'get', 'guard', 'run', 'stmt']);
  });

  it('env destructuring (`const { DB: x } = env`): route, op and cron code never see the raw binding', async () => {
    await both();
    // withoutDb: destructuring or indexing DB yields nothing, and it cannot be put back.
    const appEnv = withoutDb(env);
    const { DB: x } = appEnv;
    expect(x).toBeUndefined();
    expect(appEnv['DB']).toBeUndefined();
    expect(Object.isFrozen(appEnv)).toBe(true);
    expect(() => { 'use strict'; appEnv.DB = env.DB; }).toThrow();
    // handle(): the raw binding is read exactly twice per request (createDb + withoutDb at the
    // entry), so nothing downstream reads env.DB.
    let reads = 0;
    const spied = Object.defineProperty({ ...env }, 'DB', { get() { reads++; return env.DB; }, enumerable: true });
    const res = await handle(getRequest(ptA, '/api/dashboard'), spied);
    expect(res.status).toBe(200);
    expect(reads).toBe(2);
    // Writer ops get the env without DB.
    const stub = env.WRITER.get(env.WRITER.idFromName('scope-runtime-probe'));
    const seen = await runInDurableObject(stub, instance => ({ hasDb: 'DB' in instance.appEnv, frozen: Object.isFrozen(instance.appEnv), wrapperHasD1: 'd1' in instance.db }));
    expect(seen).toEqual({ hasDb: false, frozen: true, wrapperHasD1: false });
  });

  it('comma join (`FROM (SELECT 1) z, bookings b`): no cross-PT rows', both);
  it('\\u escape (`\\u0062ookings`): no cross-PT rows', both);
  it('\\x escape (`\\x62ookings`): no cross-PT rows', both);

  it('control: the same data IS visible unscoped, so the checks above can fail', async () => {
    const all = (await db().all('SELECT id FROM bookings WHERE id IN (?,?,?,?)', ...bookingsA, ...bookingsB)).map(r => r.id);
    expect(all.sort()).toEqual([...bookingsA, ...bookingsB].sort());
  });
});
