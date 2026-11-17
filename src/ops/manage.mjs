// The app/server.cjs tx() callers, as Writer operations: admin create PT (:48), create
// block (:50), update block (:51) and attendance (:58). Every PT-owned read and write goes
// through scopeFor(); each commits with one guarded batch.
import crypto from 'node:crypto';
import { scopeFor } from '../scope.mjs';
import { isGuardFailure, isUniqueViolation } from '../db.mjs';
import { hashPassword, httpError, uid } from '../util.mjs';
import { blockData, branding, email as validEmail, text, MOTIVATIONS } from '../validate.mjs';
import { noShowInsert } from '../emails.mjs';

/** Re-read the acting user inside the Writer (never trust a stale role or pt_id). */
async function actor(db, userId) {
  const user = await db.get('SELECT id,role,pt_id,active,must_change_password FROM users WHERE id=? AND active=1', userId);
  if (!user) throw httpError(401, 'Please sign in to continue.');
  return user;
}
const requireRole = (user, roles) => { if (!roles.includes(user.role)) throw httpError(403, 'Your account does not have access to this action.'); };
const sessionRows = (db, blockId, sessions) => sessions.map(s => db.stmt('INSERT INTO class_sessions VALUES(?,?,?,?,?)', s.id, blockId, s.starts_at, s.starts_epoch, s.duration_minutes));
const audit = (db, userId, action, target, now) => db.stmt('INSERT INTO audit_log VALUES(?,?,?,?,?)', uid(), userId, action, target, now);

export async function createPt(db, { userId, body, now = Date.now() }) {
  const user = await actor(db, userId);
  requireRole(user, ['admin']);
  const b = branding(body), address = validEmail(body.email), name = text(body.owner_name, 'PT name', 80, 2);
  const id = uid(), temporary = crypto.randomBytes(12).toString('base64url') + '!';
  try {
    await db.batch([
      db.stmt('INSERT INTO pts(id,slug,brand_name,tagline,description,about,accent,background,foreground,features,published,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, b.slug, b.name, b.tagline, b.description, b.about, b.accent, b.background, b.foreground, JSON.stringify(b.features), b.published, now),
      db.stmt("INSERT INTO users(id,name,email,password_hash,role,pt_id,must_change_password,created_at) VALUES(?,?,?,?,'pt',?,1,?)", uid(), name, address, hashPassword(temporary), id, now),
      audit(db, user.id, 'pt_created', id, now)
    ]);
  } catch (error) {
    if (isUniqueViolation(error, 'pts.slug')) throw httpError(409, 'That page address is already in use.');
    if (isUniqueViolation(error, 'users.email')) throw httpError(409, 'An account already exists for this email.');
    throw error;
  }
  // As today, the temporary password is returned once to the admin (RC-10 replaces this with invite emails).
  return { pt_id: id, email: address, temporary_password: temporary, path: '/pt/' + b.slug };
}

export async function createBlock(db, { userId, body, now = Date.now() }) {
  const user = await actor(db, userId);
  requireRole(user, ['pt', 'admin']);
  if (user.must_change_password) throw httpError(403, 'Change your temporary password before managing classes.');
  // A PT always creates for their own pt_id; body.pt_id is honoured for admins only.
  const ptId = user.role === 'pt' ? user.pt_id : text(body.pt_id, 'PT', 80);
  if (!(await db.get('SELECT id FROM pts WHERE id=?', ptId))) throw httpError(404, 'Trainer not found.');
  const d = blockData(body), id = uid();
  await db.batch([
    db.stmt('INSERT INTO blocks(id,pt_id,title,description,venue,price_pence,capacity,published,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, ptId, d.title, d.description, d.venue, d.price, d.capacity, d.published, now),
    ...sessionRows(db, id, d.sessions),
    audit(db, user.id, 'block_created', id, now)
  ]);
  return scopeFor(db, user).block(id);
}

export async function updateBlock(db, { userId, blockId, body, now = Date.now() }) {
  const user = await actor(db, userId);
  requireRole(user, ['pt', 'admin']);
  if (user.must_change_password) throw httpError(403, 'Change your temporary password before managing classes.');
  const scope = scopeFor(db, user);
  const block = await scope.block(blockId);
  if (!block) throw httpError(404, 'Class not found.');
  const d = blockData(body);
  const hasBookings = (await db.get('SELECT count(*) n FROM bookings WHERE block_id=?', block.id)).n;
  const old = await db.all('SELECT starts_at,duration_minutes FROM class_sessions WHERE block_id=? ORDER BY starts_epoch', block.id);
  if (hasBookings && JSON.stringify(old) !== JSON.stringify(d.sessions.map(s => ({ starts_at: s.starts_at, duration_minutes: s.duration_minutes })))) throw httpError(409, 'Dates are locked once bookings exist. Create a new block for a different schedule.');
  const used = (await db.get("SELECT count(*) n FROM bookings WHERE block_id=? AND (status='paid' OR (status='pending' AND expires_at>?))", block.id, now)).n;
  if (d.capacity < used) throw httpError(409, 'Capacity cannot be lower than paid or reserved places.');
  const writes = [
    db.stmt("UPDATE bookings SET status='expired' WHERE status='pending' AND expires_at<=?", now),
    // Commit-time: a reservation that landed after the read cannot push holds above the new capacity.
    db.guard('capacity_not_below_holds', "(SELECT count(*) FROM bookings WHERE block_id=? AND status IN ('paid','pending'))<=?", block.id, d.capacity)
  ];
  if (!hasBookings) writes.push(db.guard('dates_unlocked', 'NOT EXISTS(SELECT 1 FROM bookings WHERE block_id=?)', block.id));
  writes.push(scope.updateBlockStmt(block.id, 'title=?,description=?,venue=?,price_pence=?,capacity=?,published=?,closed=?,updated_at=?', d.title, d.description, d.venue, d.price, d.capacity, d.published, body.closed ? 1 : 0, now));
  if (!hasBookings) writes.push(db.stmt('DELETE FROM class_sessions WHERE block_id=?', block.id), ...sessionRows(db, block.id, d.sessions));
  writes.push(audit(db, user.id, 'block_updated', block.id, now));
  try {
    await db.batch(writes);
  } catch (error) {
    if (isGuardFailure(error)) throw httpError(409, 'Bookings changed while you were editing. Refresh and try again.');
    throw error;
  }
  return { ok: true };
}

export async function markAttendance(db, { userId, bookingId, sessionId, status, emailMode = 'preview', now = Date.now() }) {
  const user = await actor(db, userId);
  requireRole(user, ['pt', 'admin']);
  if (!['attended', 'no_show', 'unmarked'].includes(status)) throw httpError(400, 'Choose a valid attendance status.');
  const booking = await scopeFor(db, user).booking(bookingId);
  if (!booking) throw httpError(404, 'Booking not found.');
  if (booking.status !== 'paid') throw httpError(409, 'Only confirmed bookings can have attendance recorded.');
  const session = await db.get('SELECT * FROM class_sessions WHERE id=? AND block_id=?', sessionId, booking.block_id);
  if (!session) throw httpError(404, 'Session not found.');
  if (session.starts_epoch + session.duration_minutes * 60000 > now) throw httpError(409, 'Mark attendance after this session has finished.');
  const writes = [
    db.guard('booking_still_paid', "EXISTS(SELECT 1 FROM bookings WHERE id=? AND status='paid')", booking.id),
    db.stmt('INSERT INTO attendance VALUES(?,?,?,?,?) ON CONFLICT(booking_id,session_id) DO UPDATE SET status=excluded.status,marked_by=excluded.marked_by,marked_at=excluded.marked_at', booking.id, session.id, status, user.id, now)
  ];
  let mailKey = null;
  if (status === 'no_show') {
    const pt = await db.get('SELECT * FROM pts WHERE id=?', booking.pt_id);
    const customer = await db.get('SELECT * FROM users WHERE id=?', booking.customer_id);
    const mail = noShowInsert(db, { booking, session, customer, pt, motivations: MOTIVATIONS, emailMode, now, index: crypto.randomInt(MOTIVATIONS.length) });
    mailKey = mail.key;
    writes.push(mail.stmt);
  }
  writes.push(audit(db, user.id, 'attendance_' + status, booking.id + ':' + session.id, now));
  try {
    await db.batch(writes);
  } catch (error) {
    if (isGuardFailure(error)) throw httpError(409, 'Only confirmed bookings can have attendance recorded.');
    throw error;
  }
  const result = mailKey ? await db.get('SELECT id,status,subject,body FROM email_outbox WHERE dedupe_key=?', mailKey) : null;
  return { ok: true, email: result };
}
