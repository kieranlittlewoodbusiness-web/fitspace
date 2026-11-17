import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import crypto from 'node:crypto';
import { write } from '../src/writer.mjs';
import { requestReset, resetPassword, resetToken } from '../src/ops/password-reset.mjs';
import { db, seedUser, jsonRequest, tally } from './helpers.mjs';

async function userWithEmail() {
  const u = await seedUser({ role: 'customer' });
  const address = `${u.id}@example.com`;
  return { ...u, address };
}
const tokenFor = async userId => {
  const r = await db().get('SELECT id FROM password_resets WHERE user_id=? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1', userId);
  return resetToken(env, r.id);
};

describe('password reset (Writer)', () => {
  it('10 concurrent requests for one address create exactly 3 links (3/hour limit at commit time)', async () => {
    const u = await userWithEmail();
    const results = await Promise.all(Array.from({ length: 10 }, () => write(env, 'requestReset', { email: u.address })));
    const links = (await db().get('SELECT count(*) n FROM password_resets WHERE user_id=?', u.id)).n;
    const jobs = (await db().get("SELECT count(*) n FROM auth_mail_jobs WHERE user_id=? AND kind='link'", u.id)).n;
    console.log('requestReset x10 (Writer):', JSON.stringify(tally(results.map(r => (r ? 'link' : 'limited')))), 'links', links, 'mail jobs', jobs);
    expect(links).toBe(3);
    expect(jobs).toBe(3);
  });

  it('the limit also holds when the Writer is bypassed (guarded INSERT ... SELECT)', async () => {
    const u = await userWithEmail();
    const d = db();
    await Promise.all(Array.from({ length: 10 }, () => requestReset(d, { email: u.address }, env)));
    expect((await d.get('SELECT count(*) n FROM password_resets WHERE user_id=?', u.id)).n).toBe(3);
  });

  it('5 concurrent uses of one link: exactly 1 succeeds; sessions are closed; reuse fails', async () => {
    const u = await userWithEmail();
    await write(env, 'requestReset', { email: u.address });
    const token = await tokenFor(u.id);
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => write(env, 'resetPassword', { token, newPassword: 'New password ' + i + ' long' })));
    const outcome = results.map(r => (r.status === 'fulfilled' ? 'reset' : r.reason.status));
    console.log('resetPassword x5 same link (Writer):', JSON.stringify(tally(outcome)));
    expect(tally(outcome)).toEqual({ reset: 1, 400: 4 });
    expect((await db().get('SELECT count(*) n FROM sessions WHERE user_id=?', u.id)).n).toBe(0);
    expect((await db().get("SELECT count(*) n FROM auth_mail_jobs WHERE user_id=? AND kind='changed'", u.id)).n).toBe(1);
    await expect(write(env, 'resetPassword', { token, newPassword: 'Another long password' })).rejects.toMatchObject({ status: 400 });
  });

  it('bypassing the Writer, the commit-time guard still allows one use', async () => {
    const u = await userWithEmail();
    const d = db();
    await requestReset(d, { email: u.address }, env);
    const token = await tokenFor(u.id);
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => resetPassword(d, { token, newPassword: 'Bypass password ' + i + ' xx' }, env)));
    const outcome = results.map(r => (r.status === 'fulfilled' ? 'reset' : r.reason.status));
    console.log('resetPassword x5 same link (unqueued):', JSON.stringify(tally(outcome)));
    expect(tally(outcome)).toEqual({ reset: 1, 400: 4 });
  });

  it('unknown email: generic message, no link; a forged token is refused', async () => {
    const r = await exports.default.fetch(jsonRequest(null, 'POST', '/api/auth/forgot-password', { email: 'nobody-' + crypto.randomUUID() + '@example.com' }));
    expect(r.status).toBe(200);
    expect((await r.json()).message).toMatch(/If an eligible account/);
    const forged = crypto.randomUUID() + '.' + 'A'.repeat(43);
    const bad = await exports.default.fetch(jsonRequest(null, 'POST', '/api/auth/reset-password', { token: forged, new_password: 'Whatever long password' }));
    expect(bad.status).toBe(400);
  });

  it('HTTP reset route clears the cookie and the new password works for nothing else (old sessions gone)', async () => {
    const u = await userWithEmail();
    await write(env, 'requestReset', { email: u.address });
    const res = await exports.default.fetch(jsonRequest(null, 'POST', '/api/auth/reset-password', { token: await tokenFor(u.id), new_password: 'Brand new long password' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/fit_session=;.*Max-Age=0/);
    expect((await exports.default.fetch(new Request('http://example.test/api/bookings/x', { headers: { cookie: 'fit_session=' + u.token } }))).status).toBe(401);
  });
});
