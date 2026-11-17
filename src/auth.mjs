// Session lookup and request guards, ported from app/auth.cjs and app/server.cjs:34.
import { digest, httpError } from './util.mjs';

export function cookieToken(request) {
  const cookie = String(request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith('fit_session='));
  return cookie ? cookie.slice(12) : null;
}
export async function currentUser(db, request, { demo = false, now = Date.now() } = {}) {
  const token = cookieToken(request);
  if (!token) return null;
  const row = await db.get('SELECT u.*,s.csrf,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1', digest(token), now);
  if (!row || (!demo && row.demo)) return null;
  return row;
}
export function requireUser(user, roles) {
  if (!user) throw httpError(401, 'Please sign in to continue.');
  if (roles && !roles.includes(user.role)) throw httpError(403, 'Your account does not have access to this action.');
  return user;
}
/** Same-origin + CSRF checks for state-changing JSON routes (app/server.cjs:34). */
export function checkMutation(request, user, { origin, route, unauthenticatedRoutes = [] }) {
  if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') throw httpError(403, 'This request must come from the application.');
  if (!unauthenticatedRoutes.includes(route) && user && request.headers.get('x-csrf-token') !== user.csrf) throw httpError(403, 'Your session changed. Refresh the page and try again.');
  if (user?.must_change_password && !['/api/auth/password', '/api/auth/logout', '/api/auth/login', '/api/auth/forgot-password', '/api/auth/reset-password'].includes(route)) throw httpError(403, 'Change your temporary password before managing this account.');
}
