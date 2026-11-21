import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import crypto from 'node:crypto';
import { write } from '../src/writer.mjs';
import { requestReset, resetPassword, resetToken, previewOutOfBandAllowed, resetSigningSecret, RESET_TTL_MS, PREVIEW_APP_URL, PREVIEW_DB } from '../src/ops/password-reset.mjs';
import { digest } from '../src/util.mjs';
import { PRODUCTION_DB } from '../docs/rc-4/d1-rehearsal/guard.mjs';
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


function previewEnv(over = {}) {
  return Object.assign(Object.create(null), env, {
    EMAIL_MODE: 'preview',
    APP_URL: PREVIEW_APP_URL,
    AUTH_RESET_SECRET: '',
    RESET_EMAIL_MODE: 'off',
    RESEND_API_KEY: '',
    MAIL_FROM: '',
    D1_DATABASE_ID: PREVIEW_DB
  }, over);
}

async function issueOutOfBand(user, signEnv, { expiresAt, now = Date.now() } = {}) {
  const id = crypto.randomUUID();
  const token = resetToken(signEnv, id);
  const row = await db().get('SELECT password_hash FROM users WHERE id=?', user.id);
  await db().run(
    'INSERT INTO password_resets(id,user_id,token_hash,password_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)',
    id, user.id, digest(token), row.password_hash, expiresAt ?? (now + RESET_TTL_MS), now
  );
  return { id, token };
}

describe('preview out-of-band reset (EMAIL_MODE=preview, non-prod)', () => {
  it('allows only EMAIL_MODE=preview plus the preview env markers, and never a production D1 id', () => {
    expect(previewOutOfBandAllowed(env)).toBe(false);
    expect(previewOutOfBandAllowed(previewEnv())).toBe(true);
    expect(previewOutOfBandAllowed(previewEnv({ EMAIL_MODE: 'send' }))).toBe(false);
    expect(previewOutOfBandAllowed(previewEnv({ APP_URL: 'https://example.test' }))).toBe(false);
    expect(previewOutOfBandAllowed(previewEnv({ APP_URL: '' }))).toBe(false);
    expect(previewOutOfBandAllowed(previewEnv({ D1_DATABASE_ID: PRODUCTION_DB }))).toBe(false);
    expect(previewOutOfBandAllowed(previewEnv({ D1_DATABASE_ID: ' ' + PRODUCTION_DB.toUpperCase() + ' ' }))).toBe(false);
    expect(previewOutOfBandAllowed(previewEnv({ D1_DATABASE_ID: PRODUCTION_DB.slice(0, 8) + '-0000-4000-8000-000000000000' }))).toBe(false);
    expect(previewOutOfBandAllowed(previewEnv({ D1_DATABASE_ID: crypto.randomUUID() }))).toBe(false);
    expect(resetSigningSecret(previewEnv()).length).toBe(32);
    expect(resetSigningSecret(previewEnv({ AUTH_RESET_SECRET: 'a'.repeat(32) }))).toBe('a'.repeat(32));
    expect(resetSigningSecret(previewEnv({ EMAIL_MODE: 'send', AUTH_RESET_SECRET: 'a'.repeat(32) }))).toBe('');
    expect(resetSigningSecret(previewEnv({ PT_INVITE_SECRET: '', AUTH_RESET_SECRET: '' }))).toBe('');
  });

  it('forgot-password is unchanged on preview: generic message, no row, no mail', async () => {
    const u = await userWithEmail();
    const mailId = await requestReset(db(), { email: u.address }, previewEnv());
    expect(mailId).toBeNull();
    expect((await db().get('SELECT count(*) n FROM password_resets WHERE user_id=?', u.id)).n).toBe(0);
    expect((await db().get("SELECT count(*) n FROM auth_mail_jobs WHERE user_id=?", u.id)).n).toBe(0);
  });

  it('consumes a hashed HKDF token once, skips change-mail, then refuses replay', async () => {
    const u = await seedUser({ role: 'pt' });
    const sign = previewEnv();
    const { id, token } = await issueOutOfBand(u, sign);
    const mailId = await resetPassword(db(), { token, newPassword: 'Preview long password' }, sign);
    expect(mailId).toBeNull();
    expect((await db().get('SELECT used_at FROM password_resets WHERE id=?', id)).used_at).toBeTruthy();
    expect((await db().get('SELECT count(*) n FROM sessions WHERE user_id=?', u.id)).n).toBe(0);
    expect((await db().get("SELECT count(*) n FROM auth_mail_jobs WHERE user_id=? AND kind='changed'", u.id)).n).toBe(0);
    await expect(resetPassword(db(), { token, newPassword: 'Another long password' }, sign)).rejects.toMatchObject({ status: 400, code: 'RESET_LINK_INVALID' });
  });

  it('wrong token, expired token, and a used token are refused with {error, code}', async () => {
    const u = await seedUser({ role: 'pt' });
    const sign = previewEnv();
    const forged = crypto.randomUUID() + '.' + 'A'.repeat(43);
    await expect(resetPassword(db(), { token: forged, newPassword: 'Whatever long password' }, sign)).rejects.toMatchObject({ status: 400, code: 'RESET_LINK_INVALID' });

    const expired = await issueOutOfBand(u, sign, { expiresAt: Date.now() - 1000 });
    await expect(resetPassword(db(), { token: expired.token, newPassword: 'Whatever long password' }, sign)).rejects.toMatchObject({ status: 400, code: 'RESET_LINK_INVALID' });
    expect((await db().get('SELECT used_at FROM password_resets WHERE id=?', expired.id)).used_at).toBeNull();

    const live = await issueOutOfBand(u, sign);
    await resetPassword(db(), { token: live.token, newPassword: 'First long password' }, sign);
    await expect(resetPassword(db(), { token: live.token, newPassword: 'Second long password' }, sign)).rejects.toMatchObject({ status: 400, code: 'RESET_LINK_INVALID' });
  });

  it('concurrent double-submit of one preview token: exactly one succeeds', async () => {
    const u = await seedUser({ role: 'pt' });
    const sign = previewEnv();
    const { token, id } = await issueOutOfBand(u, sign);
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => resetPassword(db(), { token, newPassword: 'Preview race ' + i + ' xxx' }, sign)));
    const outcome = results.map(r => (r.status === 'fulfilled' ? 'reset' : r.reason.status));
    expect(tally(outcome)).toEqual({ reset: 1, 400: 4 });
    expect((await db().get('SELECT used_at FROM password_resets WHERE id=?', id)).used_at).toBeTruthy();
  });

  it('fail-closed: prod or any non-preview config returns 503 and does not consume', async () => {
    const u = await seedUser({ role: 'pt' });
    const sign = previewEnv();
    const { id, token } = await issueOutOfBand(u, sign);
    const closed = [
      previewEnv({ EMAIL_MODE: 'send' }),
      previewEnv({ APP_URL: 'https://resiliencecoaching.example' }),
      previewEnv({ D1_DATABASE_ID: PRODUCTION_DB }),
      previewEnv({ PT_INVITE_SECRET: '', AUTH_RESET_SECRET: '' }),
      Object.assign(Object.create(null), env, { RESET_EMAIL_MODE: 'off', AUTH_RESET_SECRET: '', EMAIL_MODE: 'preview', APP_URL: 'https://example.test' })
    ];
    for (const bad of closed) {
      await expect(resetPassword(db(), { token, newPassword: 'Should not apply xx' }, bad)).rejects.toMatchObject({ status: 503, code: 'RESET_NOT_CONFIGURED' });
    }
    expect((await db().get('SELECT used_at FROM password_resets WHERE id=?', id)).used_at).toBeNull();
    expect((await db().get('SELECT password_hash FROM users WHERE id=?', u.id)).password_hash).toBe('x');
  });

  it('on preview, AUTH_RESET_SECRET is used when set; an HKDF token does not verify against it', async () => {
    const u = await seedUser({ role: 'pt' });
    const hkdf = previewEnv();
    const auth = previewEnv({ AUTH_RESET_SECRET: 'b'.repeat(32) });
    const { token, id } = await issueOutOfBand(u, hkdf);
    await expect(resetPassword(db(), { token, newPassword: 'Should not apply xx' }, auth)).rejects.toMatchObject({ status: 400, code: 'RESET_LINK_INVALID' });
    const issued = await issueOutOfBand(u, auth);
    const mailId = await resetPassword(db(), { token: issued.token, newPassword: 'Auth secret password' }, auth);
    expect(mailId).toBeNull();
    expect((await db().get('SELECT used_at FROM password_resets WHERE id=?', id)).used_at).toBeTruthy();
    expect((await db().get('SELECT used_at FROM password_resets WHERE id=?', issued.id)).used_at).toBeTruthy();
  });
});
