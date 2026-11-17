// CR 5941600057 item 3: the Cron Trigger is OFF unless CRON_ENABLED is exactly "true", so a
// deploy of the default env (bound to the real D1 id) runs nothing on a schedule.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker, { cronTick } from '../worker/index.mjs';
import { db, seedBlock, insertBooking } from './helpers.mjs';

const withCron = value => Object.assign(Object.create(null), env, { CRON_ENABLED: value });
async function expiredHold() {
  const s = await seedBlock({ customers: 1 });
  return insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'pending', expiresAt: Date.now() - 60000 });
}
const status = async id => (await db().get('SELECT status FROM bookings WHERE id=?', id)).status;

describe('cron guard', () => {
  it('without CRON_ENABLED (or any value but "true") the scheduled handler does nothing', async () => {
    const id = await expiredHold();
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      expect(await cronTick(withCron(value))).toEqual({ skipped: 'CRON_ENABLED is not "true"' });
    }
    // through the real scheduled() entry point too
    const waits = [];
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, withCron(undefined), { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    expect(await status(id)).toBe('pending');
  });

  it('with CRON_ENABLED="true" it runs (expired holds are released)', async () => {
    const id = await expiredHold();
    const waits = [];
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now() }, withCron('true'), { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    expect(await status(id)).toBe('expired');
  });

  it('the vitest/default config does not enable it; only env.preview does', async () => {
    expect(env.CRON_ENABLED).toBeUndefined();
  });
});
