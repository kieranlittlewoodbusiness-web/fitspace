import { describe, it, expect } from 'vitest';
import { exports } from 'cloudflare:workers';
import crypto from 'node:crypto';
import { rateLimit } from '../src/ratelimit.mjs';
import { db, jsonRequest, tally } from './helpers.mjs';

describe('D1 rate limits', () => {
  it('30 concurrent attempts with max 10: exactly 10 allowed', async () => {
    const d = db(), ip = crypto.randomUUID();
    const r = await Promise.allSettled(Array.from({ length: 30 }, () => rateLimit(d, 'login', ip, { max: 10 })));
    const outcome = r.map(x => (x.status === 'fulfilled' ? 'ok' : x.reason.status));
    console.log('rateLimit x30 max 10:', JSON.stringify(tally(outcome)));
    expect(tally(outcome)).toEqual({ ok: 10, 429: 20 });
  });

  it('the window resets after it ends; keys hold a hashed client only', async () => {
    const d = db(), ip = '203.0.113.' + Math.floor(Math.random() * 200);
    const now = Date.now();
    for (let i = 0; i < 3; i++) await rateLimit(d, 'reset', ip, { max: 3, windowMs: 1000, now });
    await expect(rateLimit(d, 'reset', ip, { max: 3, windowMs: 1000, now })).rejects.toMatchObject({ status: 429 });
    expect(await rateLimit(d, 'reset', ip, { max: 3, windowMs: 1000, now: now + 1001 })).toBe(1);
    const keys = (await d.all("SELECT key FROM rate_limits WHERE key LIKE 'reset:%'")).map(r => r.key);
    expect(keys.some(k => k.includes(ip))).toBe(false);
  });

  it('POST /api/auth/forgot-password: 10 allowed, the 11th from the same IP gets 429', async () => {
    const ip = '198.51.100.' + Math.floor(Math.random() * 200);
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const req = jsonRequest(null, 'POST', '/api/auth/forgot-password', { email: `rl${i}@example.com` });
      req.headers.set('CF-Connecting-IP', ip);
      statuses.push((await exports.default.fetch(req)).status);
    }
    console.log('forgot-password x11 same IP:', JSON.stringify(tally(statuses)));
    expect(tally(statuses)).toEqual({ 200: 10, 429: 1 });
  });
});
