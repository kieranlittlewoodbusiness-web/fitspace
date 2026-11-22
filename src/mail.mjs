// Email delivery for the Cron Trigger (wrangler.jsonc "triggers.crons"), ported from
// app/emails.cjs deliver() (a 15 s setInterval in the Node server) and
// app/password-reset.cjs deliver(). Workers have no background timers, so delivery runs
// from scheduled() every minute.
//
// Exactly-once-ish: each row is CLAIMED with one guarded UPDATE ... RETURNING before the
// HTTP call (a lease), so overlapping cron invocations never pick the same row; Resend
// also gets an Idempotency-Key per row, so a re-send after a crash mid-call is deduped.
import { resetToken, configured as resetConfigured } from './ops/password-reset.mjs';
import { digest } from './util.mjs';
import { replyToForSend } from './profile.mjs';

const LEASE_MS = 5 * 60000;
const RESEND = 'https://api.resend.com/emails';

async function sendResend(env, { idempotencyKey, payload }) {
  const response = await fetch(RESEND, { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  let result = {};
  try { result = await response.json(); } catch { /* empty body */ }
  if (!response.ok) throw new Error(result.message || 'Email provider rejected the request.');
  return result;
}

/** Booking emails (confirmation, no-show). Returns counts for logs/tests (no addresses). */
export async function deliverOutbox(env, db, { now = Date.now(), limit = 10 } = {}) {
  const out = { sent: 0, failed: 0, suppressed: 0, skipped: false };
  if (env.EMAIL_MODE !== 'send' || !env.RESEND_API_KEY || !env.MAIL_FROM) return { ...out, skipped: true };
  const due = await db.all("SELECT id FROM email_outbox WHERE status IN ('queued','failed','sending') AND attempts<5 AND next_attempt_at<=? ORDER BY created_at LIMIT ?", now, limit);
  for (const { id } of due) {
    // Claim: only one runner gets RETURNING for this row (stale 'sending' leases are re-claimable).
    const row = await db.get("UPDATE email_outbox SET status='sending',next_attempt_at=? WHERE id=? AND status IN ('queued','failed','sending') AND attempts<5 AND next_attempt_at<=? RETURNING *", now + LEASE_MS, id, now);
    if (!row) continue;
    if (row.recipient.endsWith('@example.com')) {
      await db.run("UPDATE email_outbox SET status='preview',last_error='Demo example.com recipient: delivery suppressed' WHERE id=?", id);
      out.suppressed++; continue;
    }
    try {
      const owner = row.pt_id ? await db.get("SELECT u.email AS login_email, p.reply_to_email, p.reply_to_name FROM users u JOIN pts p ON p.id=u.pt_id WHERE u.pt_id=? AND u.role='pt' LIMIT 1", row.pt_id) : null;
      const replyTo = owner ? replyToForSend({ replyToEmail: owner.reply_to_email, replyToName: owner.reply_to_name, loginEmail: owner.login_email }) : undefined;
      const result = await sendResend(env, { idempotencyKey: row.dedupe_key, payload: { from: env.MAIL_FROM, to: [row.recipient], subject: row.subject, text: row.body, ...(replyTo ? { reply_to: replyTo } : {}) } });
      await db.run("UPDATE email_outbox SET status='sent',provider_id=?,sent_at=?,last_error=NULL,attempts=attempts+1 WHERE id=? AND status='sending'", result.id ?? null, Date.now(), id);
      out.sent++;
    } catch (error) {
      await db.run("UPDATE email_outbox SET status='failed',attempts=attempts+1,last_error=?,next_attempt_at=? WHERE id=? AND status='sending'", String(error.message).slice(0, 500), Date.now() + Math.min(3600000, 60000 * 2 ** row.attempts), id);
      out.failed++;
    }
  }
  return out;
}

/** Password-reset link / "password changed" emails (auth_mail_jobs). */
export async function deliverAuthMail(env, db, { now = Date.now(), limit = 10 } = {}) {
  const out = { sent: 0, failed: 0, dropped: 0, skipped: false };
  if (!resetConfigured(env)) return { ...out, skipped: true };
  const due = await db.all("SELECT id FROM auth_mail_jobs WHERE status IN ('pending','retry') AND claimed_until<=? AND created_at>? ORDER BY created_at LIMIT ?", now, now - 23 * 3600000, limit);
  for (const { id } of due) {
    const job = await db.get("UPDATE auth_mail_jobs SET claimed_until=? WHERE id=? AND status IN ('pending','retry') AND claimed_until<=? RETURNING *", now + LEASE_MS, id, now);
    if (!job) continue;
    const user = await db.get('SELECT * FROM users WHERE id=? AND active=1', job.user_id);
    let subject, text;
    if (job.kind === 'link') {
      const reset = await db.get('SELECT * FROM password_resets WHERE id=?', job.reset_id);
      const token = reset && resetToken(env, reset.id);
      if (!user || user.email !== job.recipient || !reset || reset.used_at || reset.expires_at <= now || reset.password_hash !== user.password_hash || reset.token_hash !== digest(token)) {
        await db.run("UPDATE auth_mail_jobs SET status='dropped',last_error='Link no longer valid; not sent.' WHERE id=?", id);
        out.dropped++; continue;
      }
      subject = 'Reset your Resilience Coaching password';
      text = 'A password reset was requested for your Resilience Coaching account.\n\nOpen this link to choose a new password:\n' + job.origin + '/reset-password#' + token + '\n\nThis link expires 30 minutes after the request and can be used once. If you did not request this, ignore this email. Your password has not changed.';
    } else {
      if (!user || user.email !== job.recipient) { await db.run("UPDATE auth_mail_jobs SET status='dropped' WHERE id=?", id); out.dropped++; continue; }
      subject = 'Your Resilience Coaching password has changed';
      text = 'Your Resilience Coaching password was reset. All previous sign-in sessions have been closed.\n\nIf you did not make this change, request a fresh password reset from ' + job.origin + '/forgot-password and contact your coach or platform owner.';
    }
    try {
      await sendResend(env, { idempotencyKey: 'fitspace-auth:' + id, payload: { from: job.sender, to: [job.recipient], subject, text } });
      await db.run("UPDATE auth_mail_jobs SET status='sent',last_error=NULL WHERE id=?", id);
      out.sent++;
    } catch {
      await db.run("UPDATE auth_mail_jobs SET status='retry',claimed_until=0,last_error='Email delivery not confirmed. Request a new link if needed.' WHERE id=?", id);
      out.failed++;
    }
  }
  return out;
}

/** Cron Trigger body: mail, then housekeeping. Never logs addresses or bodies. */
export async function runScheduled(env, db, now = Date.now()) {
  const outbox = await deliverOutbox(env, db, { now });
  const auth = await deliverAuthMail(env, db, { now });
  await db.batch([
    db.stmt("UPDATE bookings SET status='expired' WHERE status='pending' AND expires_at<=?", now),
    db.stmt('DELETE FROM rate_limits WHERE window_ends<?', now - 86400000)
  ]);
  return { outbox, auth };
}
