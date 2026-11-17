// Login, signup and logout, ported from app/server.cjs:36,39,40 and app/auth.cjs.
// Single-batch flows with no read-then-write decisions (unique email gives 409), so they
// run in the Worker, not the Writer; scrypt also stays out of the Writer's queue.
import { digest, hashPassword, httpError, uid, verifyPassword } from './util.mjs';
import { email as validEmail, password as validPassword, text } from './validate.mjs';
import { isUniqueViolation } from './db.mjs';
import { newSession } from './ops/accounts.mjs';
import { cookieToken } from './auth.mjs';

export const safeUser = row => row ? { id: row.id, name: row.name, email: row.email, role: row.role, pt_id: row.pt_id, must_change_password: Boolean(row.must_change_password) } : null;
export const sessionCookie = (token, secure) => `fit_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure ? '; Secure' : ''}`;
export const clearCookie = secure => `fit_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
// For unknown emails verify against a fixed dummy so a miss costs the same scrypt CPU as a
// hit (no account enumeration by timing). Fixed salt; never matches any real password.
const DUMMY_HASH = '00000000000000000000000000000000:' + '0'.repeat(128);

export async function login(db, request, body, { demo }) {
  const address = validEmail(body.email);
  const row = await db.get('SELECT * FROM users WHERE email=?', address);
  const ok = verifyPassword(String(body.password || ''), row?.password_hash || DUMMY_HASH);
  if (!row || !row.active || (!demo && row.demo) || !ok) throw httpError(401, 'Email or password is incorrect.');
  const s = newSession(db, row.id);
  const old = cookieToken(request);
  await db.batch([old ? db.stmt('DELETE FROM sessions WHERE token_hash=?', digest(old)) : null, s.stmt]);
  return { user: safeUser(row), csrf: s.csrf, token: s.token };
}

export async function signup(db, body) {
  if (!body.demo_acknowledged) throw httpError(400, 'Accept the booking terms before creating an account.');
  const id = uid(), name = text(body.name, 'Name', 80, 2), address = validEmail(body.email), hash = hashPassword(validPassword(body.password)), now = Date.now();
  const s = newSession(db, id, now);
  try {
    await db.batch([db.stmt("INSERT INTO users(id,name,email,password_hash,role,pt_id,must_change_password,created_at) VALUES(?,?,?,?,'customer',NULL,0,?)", id, name, address, hash, now), s.stmt]);
  } catch (error) {
    if (isUniqueViolation(error, 'users.email')) throw httpError(409, 'An account already exists for this email.');
    throw error;
  }
  return { user: safeUser({ id, name, email: address, role: 'customer', pt_id: null, must_change_password: 0 }), csrf: s.csrf, token: s.token };
}

export async function logout(db, request) {
  const token = cookieToken(request);
  if (token) await db.run('DELETE FROM sessions WHERE token_hash=?', digest(token));
}
