// PT-owned profile update (GET/PATCH /api/pt/profile). Kept in its own module so
// it merges cleanly with later PT settings work. Admin branding stays on updatePtBranding.
import { httpError, uid } from '../util.mjs';
import { applyProfilePatch, profilePatch, ptProfile } from '../profile.mjs';

export async function updatePtProfile(db, { userId, body, now = Date.now() }) {
  const user = await db.get('SELECT id,role,pt_id FROM users WHERE id=? AND active=1', userId);
  if (user?.role !== 'pt' || !user.pt_id) throw httpError(403, 'Your account does not have access to this action.');
  const patch = profilePatch(body);
  const current = await db.get('SELECT * FROM pts WHERE id=?', user.pt_id);
  if (!current) throw httpError(404, 'Trainer not found.');
  if (!Object.keys(patch).length) return { pt: ptProfile(current) };
  const next = applyProfilePatch(current, patch);
  const [r] = await db.batch([
    db.stmt(
      'UPDATE pts SET brand_name=?,about=?,business_name=?,contact_email=?,contact_phone=?,reply_to_email=?,reply_to_name=?,venue_name=?,venue_address=?,cancellation_window_hours=?,photo_url=?,published=? WHERE id=?',
      next.brand_name, next.about, next.business_name, next.contact_email, next.contact_phone,
      next.reply_to_email, next.reply_to_name, next.venue_name, next.venue_address,
      next.cancellation_window_hours, next.photo_url, next.published, user.pt_id
    ),
    db.stmt('INSERT INTO audit_log VALUES(?,?,?,?,?)', uid(), user.id, 'pt_profile_updated', user.pt_id, now)
  ]);
  if (!r.changes) throw httpError(404, 'Trainer not found.');
  const pt = await db.get('SELECT * FROM pts WHERE id=?', user.pt_id);
  return { pt: ptProfile(pt) };
}
