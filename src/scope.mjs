// Tenant scoping: the D1 equivalent of row-level security. D1 has no RLS, so every read
// or write of PT-owned rows goes through these helpers, which put the tenant predicate IN
// THE SQL (never as a post-filter in JavaScript):
//   pt       -> rows whose owning PT is user.pt_id (blocks.pt_id, or via bookings.block_id)
//   customer -> only their own bookings; no PT-owned management reads
//   admin    -> unscoped
// A missing row and a row owned by someone else are indistinguishable (both null -> 404).
import { httpError } from './util.mjs';

const BOOKING_VIEW = 'SELECT b.*,c.title,c.venue,c.description,c.pt_id,p.slug,p.brand_name,u.name customer_name,u.email customer_email FROM bookings b JOIN blocks c ON c.id=b.block_id JOIN pts p ON p.id=c.pt_id JOIN users u ON u.id=b.customer_id';

export function scopeFor(db, user) {
  if (!user) throw httpError(401, 'Please sign in to continue.');
  const role = user.role;
  if (role === 'pt' && !user.pt_id) throw httpError(403, 'Your account does not have access to this action.');
  const ptOnly = () => { if (role !== 'pt' && role !== 'admin') throw httpError(403, 'Your account does not have access to this action.'); };
  // [sql fragment, ...args] restricting rows to the caller, for a table aliased `alias`
  // that has a pt_id column (blocks c, email_outbox, stripe_connections, ...).
  const ptClause = alias => (role === 'admin' ? ['1=1'] : [`${alias}.pt_id=?`, user.pt_id]);

  return {
    role,
    ptId: role === 'pt' ? user.pt_id : null,
    /** One block the caller manages, or null. */
    async block(id) {
      ptOnly();
      const [clause, ...args] = ptClause('c');
      return db.get(`SELECT c.* FROM blocks c WHERE c.id=? AND ${clause}`, id, ...args);
    },
    /** Blocks the caller manages. Admins may pass a ptId to narrow. */
    async blocks({ ptId } = {}) {
      ptOnly();
      if (role === 'admin') return ptId ? db.all('SELECT * FROM blocks WHERE pt_id=? ORDER BY created_at DESC', ptId) : db.all('SELECT * FROM blocks ORDER BY created_at DESC');
      return db.all('SELECT * FROM blocks WHERE pt_id=? ORDER BY created_at DESC', user.pt_id);
    },
    /** One booking the caller may see (customer: own; pt: on their blocks; admin: any), or null. */
    async booking(id) {
      if (role === 'customer') return db.get(`${BOOKING_VIEW} WHERE b.id=? AND b.customer_id=?`, id, user.id);
      const [clause, ...args] = ptClause('c');
      return db.get(`${BOOKING_VIEW} WHERE b.id=? AND ${clause}`, id, ...args);
    },
    /** Bookings the caller may see, newest first. */
    async bookings() {
      if (role === 'customer') return db.all(`${BOOKING_VIEW} WHERE b.customer_id=? ORDER BY b.created_at DESC`, user.id);
      const [clause, ...args] = ptClause('c');
      return db.all(`${BOOKING_VIEW} WHERE ${clause} ORDER BY b.created_at DESC`, ...args);
    },
    /** The PT's email outbox (app/server.cjs:44). */
    async outbox(limit = 100) {
      ptOnly();
      const [clause, ...args] = ptClause('o');
      return db.all(`SELECT o.* FROM email_outbox o WHERE ${clause} ORDER BY o.created_at DESC LIMIT ?`, ...args, limit);
    },
    /** A guarded statement that only updates a block the caller manages (for batches). */
    updateBlockStmt(id, sets, ...setArgs) {
      ptOnly();
      if (role === 'admin') return db.stmt(`UPDATE blocks SET ${sets} WHERE id=?`, ...setArgs, id);
      return db.stmt(`UPDATE blocks SET ${sets} WHERE id=? AND pt_id=?`, ...setArgs, id, user.pt_id);
    }
  };
}

/** Booking view with sessions + attendance, scoped. Throws 404 when not visible. */
export async function viewBooking(db, user, id) {
  const booking = await scopeFor(db, user).booking(id);
  if (!booking) throw httpError(404, 'Booking not found.');
  delete booking.checkout_token;
  delete booking.checkout_url;
  booking.sessions = await db.all("SELECT s.*,coalesce(a.status,'unmarked') attendance_status FROM class_sessions s LEFT JOIN attendance a ON a.session_id=s.id AND a.booking_id=? WHERE s.block_id=? ORDER BY s.starts_epoch", id, booking.block_id);
  return booking;
}
