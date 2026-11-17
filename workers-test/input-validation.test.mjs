// CR 5940135102 nits: bad ids are 400s (not 503s); an invalid STRIPE_INTEGRATION is refused.
import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { handle } from '../worker/index.mjs';
import { seedBlock, seedUser, jsonRequest, getRequest } from './helpers.mjs';

describe('input validation', () => {
  it('malformed %-escape in a path id -> 400; non-string block_id/booking_id -> 400', async () => {
    const { users, ptId } = await seedBlock({ customers: 1 });
    const pt = await seedUser({ role: 'pt', ptId });
    const statuses = {
      getBadEscape: (await exports.default.fetch(getRequest(users[0], '/api/bookings/%E0%A4%A'))).status,
      payBadEscape: (await exports.default.fetch(jsonRequest(users[0], 'POST', '/api/bookings/%ZZ/pay', { result: 'success' }))).status,
      reserveObjectId: (await exports.default.fetch(jsonRequest(users[0], 'POST', '/api/bookings', { block_id: { $ne: 1 }, checkout_token: crypto.randomUUID() }))).status,
      attendanceNumberId: (await exports.default.fetch(jsonRequest(pt, 'POST', '/api/attendance', { booking_id: 42, session_id: 's', status: 'attended' }))).status
    };
    console.log('input validation statuses:', JSON.stringify(statuses));
    expect(statuses).toEqual({ getBadEscape: 400, payBadEscape: 400, reserveObjectId: 400, attendanceNumberId: 400 });
  });
  it('an unknown STRIPE_INTEGRATION is refused with 503 (same as app/pt-stripe.cjs)', async () => {
    await expect(handle(new Request('http://example.test/health'), { ...env, STRIPE_INTEGRATION: 'other' })).rejects.toMatchObject({ status: 503 });
  });
});
