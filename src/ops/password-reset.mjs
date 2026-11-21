// Password reset, ported from app/password-reset.cjs requestReset()/resetPassword()
// (two BEGIN IMMEDIATE transactions). Both run in the Writer and commit with one batch.
// Email delivery (Resend) stays out of the batch and is ported with the mail worker in
// phase 3; the batch only records an auth_mail_jobs row, as the original does.
import crypto from 'node:crypto';
import { isGuardFailure } from '../db.mjs';
import { digest, hashPassword, httpError, uid } from '../util.mjs';
import { email as validEmail, password as validPassword } from '../validate.mjs';
import { isProduction, safeDatabaseId } from '../../docs/rc-4/d1-rehearsal/guard.mjs';

export const MESSAGE = 'If an eligible account uses that email address, a password reset link will be emailed. Check your inbox and spam folder. You can request another link later if it does not arrive.';
const INVALID = 'This reset link is invalid or expired. Request a new link.';
export const RESET_TTL_MS = 30 * 60 * 1000;

export function configured(env) {
  return env.RESET_EMAIL_MODE === 'send' && Boolean(env.RESEND_API_KEY && env.MAIL_FROM) && (env.AUTH_RESET_SECRET || '').length >= 32 && /^https:\/\/[^/]+\/?$/.test(env.APP_URL || '');
}

// Preview-only fallback: when AUTH_RESET_SECRET is unset, derive a dedicated
// reset-signing key from PT_INVITE_SECRET (already on the preview Worker).
// Salt/info differ from any earlier preview-gate cookie HKDF, and from the raw invite secret.
// Out-of-band consume is allowed only for EMAIL_MODE=preview plus the preview env markers,
// and never when the bound database id is production (shared normalised guard).
export const PREVIEW_RESET_SALT = 'resiliencecoaching-preview-reset';
export const PREVIEW_RESET_INFO = 'reset-v1';
export const PREVIEW_APP_URL = 'https://resiliencecoaching-preview.littlk.workers.dev';
export const PREVIEW_DB = '81379d2e-c718-48b7-870d-1d189feea966';

function boundDatabaseId(env) {
  const raw = env.D1_DATABASE_ID ?? env.DATABASE_ID;
  return raw == null || raw === '' ? null : raw;
}

/** True only for the preview Worker env: EMAIL_MODE=preview, preview APP_URL, non-prod D1. */
export function previewOutOfBandAllowed(env) {
  if (env.EMAIL_MODE !== 'preview') return false;
  const url = String(env.APP_URL || '').replace(/\/$/, '');
  if (url !== PREVIEW_APP_URL) return false;
  const raw = boundDatabaseId(env);
  if (raw != null) {
    if (isProduction(raw)) return false;
    try {
      if (safeDatabaseId(raw) !== PREVIEW_DB) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function resetSigningSecret(env) {
  const auth = env.AUTH_RESET_SECRET || '';
  if (auth.length >= 32) {
    if (configured(env) || previewOutOfBandAllowed(env)) return auth;
    return '';
  }
  if (previewOutOfBandAllowed(env) && (env.PT_INVITE_SECRET || '').length >= 32) {
    return Buffer.from(crypto.hkdfSync('sha256', String(env.PT_INVITE_SECRET), PREVIEW_RESET_SALT, PREVIEW_RESET_INFO, 32));
  }
  return '';
}

export function resetToken(env, id) {
  return id + '.' + crypto.createHmac('sha256', resetSigningSecret(env)).update('fitspace-password-reset:' + id).digest('base64url');
}

function resetUnavailable() {
  return httpError(503, 'Password reset email is not configured. Contact your coach or the platform owner for help.', { code: 'RESET_NOT_CONFIGURED' });
}

function resetInvalid() {
  return httpError(400, INVALID, { code: 'RESET_LINK_INVALID' });
}

/** Returns the auth_mail_jobs id to deliver, or null (rate-limited, unknown, or not configured). */
export async function requestReset(db, { email, now = Date.now() }, env) {
  const address = validEmail(email);
  const key = digest(address);
  const user = await db.get("SELECT * FROM users WHERE email=? AND active=1 AND demo=0 AND role IN ('customer','pt')", address);
  const limitId = uid();
  const writes = [
    db.stmt('DELETE FROM password_reset_limits WHERE created_at<?', now - 3600000),
    db.stmt('DELETE FROM auth_mail_jobs WHERE created_at<?', now - 7 * 86400000),
    db.stmt('DELETE FROM password_resets WHERE expires_at<?', now - 86400000),
    // At most 3 requests per address per hour, counted at commit time.
    db.stmt('INSERT INTO password_reset_limits SELECT ?,?,? WHERE (SELECT count(*) FROM password_reset_limits WHERE email_hash=?)<3 RETURNING id', limitId, key, now, key)
  ];
  let mailId = null;
  if (configured(env) && user) {
    const resetId = uid();
    mailId = uid();
    const limited = 'EXISTS(SELECT 1 FROM password_reset_limits WHERE id=?)';
    writes.push(db.stmt(`INSERT INTO password_resets(id,user_id,token_hash,password_hash,expires_at,created_at) SELECT ?,?,?,?,?,? WHERE ${limited}`, resetId, user.id, digest(resetToken(env, resetId)), user.password_hash, now + RESET_TTL_MS, now, limitId));
    writes.push(db.stmt(`INSERT INTO auth_mail_jobs(id,user_id,reset_id,kind,recipient,sender,origin,created_at) SELECT ?,?,?,'link',?,?,?,? WHERE ${limited}`, mailId, user.id, resetId, user.email, env.MAIL_FROM, new URL(env.APP_URL).origin, now, limitId));
  }
  const results = await db.batch(writes);
  if (!results[3].rows.length) return null;
  return mailId;
}

/** Consumes a reset link once. Returns the 'changed' auth_mail_jobs id, or null when no mail is configured. */
export async function resetPassword(db, { token, newPassword, now = Date.now() }, env) {
  // A valid, already-issued token can be consumed when a signing secret is
  // available (including the preview-derived key). Sending mail still requires
  // configured() — no auth_mail_jobs row is written otherwise.
  if (!resetSigningSecret(env)) throw resetUnavailable();
  if (typeof token !== 'string' || !/^[-a-f0-9]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) throw resetInvalid();
  const pass = validPassword(newPassword);
  const row = await db.get('SELECT r.*,u.email,u.role,u.active,u.demo,u.password_hash current_hash FROM password_resets r JOIN users u ON u.id=r.user_id WHERE r.token_hash=?', digest(token));
  if (!row || row.used_at || row.expires_at <= now || !row.active || row.demo || !['customer', 'pt'].includes(row.role) || row.password_hash !== row.current_hash || digest(resetToken(env, row.id)) !== row.token_hash) throw resetInvalid();
  const mailId = configured(env) ? uid() : null;
  const writes = [
      // Commit-time check: link still unused and unexpired, and the password has not changed
      // since the link was issued. A second concurrent use fails here and changes nothing.
      db.guard('reset_link_valid', "EXISTS(SELECT 1 FROM password_resets r JOIN users u ON u.id=r.user_id WHERE r.id=? AND r.used_at IS NULL AND r.expires_at>? AND u.active=1 AND u.password_hash=r.password_hash AND u.password_hash=?)", row.id, now, row.current_hash),
      db.stmt('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?', hashPassword(pass), row.user_id),
      db.stmt('DELETE FROM sessions WHERE user_id=?', row.user_id),
      db.stmt('UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL', now, row.user_id),
      db.stmt('INSERT INTO audit_log VALUES(?,?,?,?,?)', uid(), row.user_id, 'password_reset', row.user_id, now)
  ];
  if (mailId) writes.push(db.stmt("INSERT INTO auth_mail_jobs(id,user_id,reset_id,kind,recipient,sender,origin,created_at) VALUES(?,?,NULL,'changed',?,?,?,?)", mailId, row.user_id, row.email, env.MAIL_FROM, new URL(env.APP_URL).origin, now));
  try {
    await db.batch(writes);
  } catch (error) {
    if (isGuardFailure(error)) throw resetInvalid();
    throw error;
  }
  return mailId;
}
