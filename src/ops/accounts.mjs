// Account and PT-settings Writer ops, ported from app/server.cjs:41 (password change),
// :49 (admin PUT /api/admin/pts/:id), payments.cjs syncPt()/SM.bind() and the demo cancel.
// scrypt runs in the Worker BEFORE these ops (never inside the Writer's queue slot).
import crypto from 'node:crypto';
import { scopeFor } from '../scope.mjs';
import { isGuardFailure, isUniqueViolation } from '../db.mjs';
import { digest, httpError, uid } from '../util.mjs';
import { connectStatusView, parseRequirements, resolveConnectPtId } from '../connect-status.mjs';
import { branding } from '../validate.mjs';

const SESSION_MS = 7 * 86400000;
export function newSession(db, userId, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
  return { token, csrf, stmt: db.stmt('INSERT INTO sessions VALUES(?,?,?,?)', digest(token), userId, csrf, now + SESSION_MS) };
}

/** Password change: verified in the Worker against `expectedHash`; committed only if the
 *  hash is still that value (a concurrent reset/change wins, this one 409s). */
export async function changePassword(db, { userId, expectedHash, newHash, now = Date.now() }) {
  const s = newSession(db, userId, now);
  try {
    await db.batch([
      db.guard('password_unchanged', 'EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND password_hash=?)', userId, expectedHash),
      db.stmt('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?', newHash, userId),
      db.stmt('DELETE FROM sessions WHERE user_id=?', userId),
      s.stmt,
      db.stmt('INSERT INTO audit_log VALUES(?,?,?,?,?)', uid(), userId, 'password_changed', userId, now)
    ]);
  } catch (error) {
    if (isGuardFailure(error)) throw httpError(409, 'Your password changed in another session. Sign in again.', { code: 'PASSWORD_CHANGED_ELSEWHERE' });
    throw error;
  }
  return { token: s.token, csrf: s.csrf };
}

/** Admin: update a PT's branding (single statement; unique slug -> 409). */
export async function updatePtBranding(db, { userId, ptId, body }) {
  const user = await db.get('SELECT id,role FROM users WHERE id=? AND active=1', userId);
  if (user?.role !== 'admin') throw httpError(403, 'Your account does not have access to this action.');
  const b = branding(body);
  let r;
  try {
    [r] = await db.batch([
      db.stmt('UPDATE pts SET slug=?,brand_name=?,tagline=?,description=?,about=?,accent=?,background=?,foreground=?,features=?,published=? WHERE id=? AND deleted_at IS NULL', b.slug, b.name, b.tagline, b.description, b.about, b.accent, b.background, b.foreground, JSON.stringify(b.features), b.published, ptId),
      db.stmt('INSERT INTO audit_log VALUES(?,?,?,?,?)', uid(), user.id, 'pt_branding_updated', ptId, Date.now())
    ]);
  } catch (error) {
    if (isUniqueViolation(error, 'pts.slug')) throw httpError(409, 'That page address is already in use.');
    throw error;
  }
  if (!r.changes) throw httpError(404, 'Trainer not found.');
  return { ok: true, path: '/pt/' + b.slug };
}

/** POST /api/pt/stripe/status result: persist the full Connect snapshot for the PT owner or admin. */
export async function bindConnection(db, { userId, mode, accountId, routing, ready, charges_enabled, payouts_enabled, details_submitted, requirements, ptId = null, multiPt = false, now = Date.now() }) {
  const user = await db.get('SELECT id,role,pt_id FROM users WHERE id=? AND active=1', userId);
  const targetId = await resolveConnectPtId(db, user, ptId, { multiPt });
  const snap = {
    account_id: accountId, routing, ready,
    charges_enabled: Boolean(charges_enabled), payouts_enabled: Boolean(payouts_enabled),
    details_submitted: Boolean(details_submitted),
    // RC-33: null/absent means the Stripe response carried no requirements; keep the stored list.
    requirements: requirements == null ? null : parseRequirements(requirements)
  };
  await db.batch([
    db.stmt(
      'UPDATE stripe_connections SET ready=?,charges_enabled=?,payouts_enabled=?,details_submitted=?,requirements=COALESCE(?,requirements),updated_at=? WHERE pt_id=? AND mode=? AND account_id=? AND routing=?',
      snap.ready ? 1 : 0, snap.charges_enabled ? 1 : 0, snap.payouts_enabled ? 1 : 0, snap.details_submitted ? 1 : 0,
      snap.requirements ? JSON.stringify(snap.requirements) : null, now, targetId, mode, accountId, routing
    ),
    mode === 'stripe_test' && routing === 'connected' ? db.stmt('UPDATE pts SET stripe_ready=? WHERE id=? AND stripe_account=?', snap.ready ? 1 : 0, targetId, accountId) : null
  ]);
  if (!snap.requirements) {
    const stored = await db.get('SELECT requirements FROM stripe_connections WHERE pt_id=? AND mode=? AND account_id=? AND routing=?', targetId, mode, accountId, routing);
    snap.requirements = parseRequirements(stored?.requirements);
  }
  return connectStatusView(snap, { mode });
}

/** POST /api/bookings/:id/cancel for demo bookings (owner customer, owning PT or admin). */
export async function cancelDemoBooking(db, { userId, bookingId, now = Date.now() }) {
  const user = await db.get('SELECT id,role,pt_id FROM users WHERE id=? AND active=1', userId);
  if (!user) throw httpError(401, 'Please sign in to continue.');
  const booking = await scopeFor(db, user).booking(bookingId);
  if (!booking) throw httpError(404, 'Booking not found.');
  await db.batch([
    db.stmt("UPDATE bookings SET status='cancelled' WHERE id=? AND status IN ('paid','pending') AND mode='demo'", booking.id),
    db.stmt('INSERT INTO audit_log VALUES(?,?,?,?,?)', uid(), user.id, 'booking_cancelled', booking.id, now)
  ]);
  return { ok: true };
}
