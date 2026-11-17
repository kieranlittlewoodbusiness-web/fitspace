// Password reset, ported from app/password-reset.cjs requestReset()/resetPassword()
// (two BEGIN IMMEDIATE transactions). Both run in the Writer and commit with one batch.
// Email delivery (Resend) stays out of the batch and is ported with the mail worker in
// phase 3; the batch only records an auth_mail_jobs row, as the original does.
import crypto from 'node:crypto';
import { isGuardFailure } from '../db.mjs';
import { digest, hashPassword, httpError, uid } from '../util.mjs';
import { email as validEmail, password as validPassword } from '../validate.mjs';

export const MESSAGE = 'If an eligible account uses that email address, a password reset link will be emailed. Check your inbox and spam folder. You can request another link later if it does not arrive.';
const INVALID = 'This reset link is invalid or expired. Request a new link.';

export function configured(env) {
  return env.RESET_EMAIL_MODE === 'send' && Boolean(env.RESEND_API_KEY && env.MAIL_FROM) && (env.AUTH_RESET_SECRET || '').length >= 32 && /^https:\/\/[^/]+\/?$/.test(env.APP_URL || '');
}
export function resetToken(env, id) {
  return id + '.' + crypto.createHmac('sha256', env.AUTH_RESET_SECRET || '').update('fitspace-password-reset:' + id).digest('base64url');
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
    writes.push(db.stmt(`INSERT INTO password_resets(id,user_id,token_hash,password_hash,expires_at,created_at) SELECT ?,?,?,?,?,? WHERE ${limited}`, resetId, user.id, digest(resetToken(env, resetId)), user.password_hash, now + 30 * 60000, now, limitId));
    writes.push(db.stmt(`INSERT INTO auth_mail_jobs(id,user_id,reset_id,kind,recipient,sender,origin,created_at) SELECT ?,?,?,'link',?,?,?,? WHERE ${limited}`, mailId, user.id, resetId, user.email, env.MAIL_FROM, new URL(env.APP_URL).origin, now, limitId));
  }
  const results = await db.batch(writes);
  if (!results[3].rows.length) return null;
  return mailId;
}

/** Consumes a reset link once. Returns the 'changed' auth_mail_jobs id. */
export async function resetPassword(db, { token, newPassword, now = Date.now() }, env) {
  if (!configured(env)) throw httpError(503, 'Password reset email is not configured. Contact your trainer or platform owner.');
  if (typeof token !== 'string' || !/^[-a-f0-9]{36}\.[A-Za-z0-9_-]{43}$/.test(token)) throw httpError(400, INVALID);
  const pass = validPassword(newPassword);
  const row = await db.get('SELECT r.*,u.email,u.role,u.active,u.demo,u.password_hash current_hash FROM password_resets r JOIN users u ON u.id=r.user_id WHERE r.token_hash=?', digest(token));
  if (!row || row.used_at || row.expires_at <= now || !row.active || row.demo || !['customer', 'pt'].includes(row.role) || row.password_hash !== row.current_hash || digest(resetToken(env, row.id)) !== row.token_hash) throw httpError(400, INVALID);
  const mailId = uid();
  try {
    await db.batch([
      // Commit-time check: link still unused and unexpired, and the password has not changed
      // since the link was issued. A second concurrent use fails here and changes nothing.
      db.guard('reset_link_valid', "EXISTS(SELECT 1 FROM password_resets r JOIN users u ON u.id=r.user_id WHERE r.id=? AND r.used_at IS NULL AND r.expires_at>? AND u.active=1 AND u.password_hash=r.password_hash AND u.password_hash=?)", row.id, now, row.current_hash),
      db.stmt('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?', hashPassword(pass), row.user_id),
      db.stmt('DELETE FROM sessions WHERE user_id=?', row.user_id),
      db.stmt('UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL', now, row.user_id),
      db.stmt('INSERT INTO audit_log VALUES(?,?,?,?,?)', uid(), row.user_id, 'password_reset', row.user_id, now),
      db.stmt("INSERT INTO auth_mail_jobs(id,user_id,reset_id,kind,recipient,sender,origin,created_at) VALUES(?,?,NULL,'changed',?,?,?,?)", mailId, row.user_id, row.email, env.MAIL_FROM, new URL(env.APP_URL).origin, now)
    ]);
  } catch (error) {
    if (isGuardFailure(error)) throw httpError(400, INVALID);
    throw error;
  }
  return mailId;
}
