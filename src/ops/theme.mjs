// PT-owned theme update (PUT /api/pt/theme). Self-contained: does not go through the
// profile or admin branding ops. Stores the chosen preset's colours in existing pts columns.
import { httpError, uid } from '../util.mjs';
import { presetById, presetColours, resolveThemeId, themeIdFromBody } from '../theme-presets.mjs';

export function themeView(pt) {
  return { id: resolveThemeId(pt) };
}

export async function readPtTheme(db, user) {
  if (user?.role !== 'pt' || !user.pt_id) throw httpError(403, 'Your account does not have access to this action.');
  const pt = await db.get('SELECT accent,background,foreground FROM pts WHERE id=? AND deleted_at IS NULL', user.pt_id);
  if (!pt) throw httpError(404, 'Trainer not found.');
  return themeView(pt);
}

export async function updatePtTheme(db, { userId, body, now = Date.now() }) {
  const user = await db.get('SELECT id,role,pt_id FROM users WHERE id=? AND active=1', userId);
  if (user?.role !== 'pt' || !user.pt_id) throw httpError(403, 'Your account does not have access to this action.');
  const id = themeIdFromBody(body);
  const colours = presetColours(presetById(id));
  const current = await db.get('SELECT id FROM pts WHERE id=? AND deleted_at IS NULL', user.pt_id);
  if (!current) throw httpError(404, 'Trainer not found.');
  const [r] = await db.batch([
    db.stmt(
      'UPDATE pts SET accent=?,background=?,foreground=? WHERE id=? AND deleted_at IS NULL',
      colours.accent, colours.background, colours.foreground, user.pt_id
    ),
    db.stmt('INSERT INTO audit_log VALUES(?,?,?,?,?)', uid(), user.id, 'pt_theme_updated', user.pt_id, now)
  ]);
  if (!r.changes) throw httpError(404, 'Trainer not found.');
  return { id };
}
