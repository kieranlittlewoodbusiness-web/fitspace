// Booking confirmation text, ported from app/emails.cjs confirmation(). Reads happen before
// the batch; the INSERT is guarded so it only lands if the booking is 'paid' at commit time
// and dedupe_key keeps it to one row per booking.
import { uid } from './util.mjs';

export async function confirmationInsert(db, bookingId, { emailMode = 'preview', now = Date.now() } = {}) {
  const booking = await db.get('SELECT * FROM bookings WHERE id=?', bookingId);
  if (!booking) return null;
  const customer = await db.get('SELECT name,email FROM users WHERE id=?', booking.customer_id);
  const block = await db.get('SELECT * FROM blocks WHERE id=?', booking.block_id);
  const pt = await db.get('SELECT * FROM pts WHERE id=?', block.pt_id);
  const sessions = await db.all('SELECT starts_at FROM class_sessions WHERE block_id=? ORDER BY starts_epoch', block.id);
  const amount = (booking.amount_pence / 100).toFixed(2);
  const body = `Hi ${customer.name},\n\nYour ${booking.mode === 'demo' ? 'test ' : ''}booking is confirmed.\n\n${block.title}\nReference: ${booking.reference}\nVenue: ${block.venue}\nSessions (UK time):\n${sessions.map(s => s.starts_at.replace('T', ' at ')).join('\n')}\n\n${booking.mode === 'stripe_live' ? 'Card' : booking.mode === 'demo' ? 'Simulated' : 'Stripe sandbox'} payment: £${amount}\n${booking.mode === 'stripe_live' ? 'Your payment was received.' : 'No real money was taken in this test version.'}\n\nSee you at class!\n${pt.brand_name}`;
  return db.stmt(
    `INSERT OR IGNORE INTO email_outbox(id,pt_id,customer_id,dedupe_key,recipient,subject,body,kind,quote_index,status,created_at)
     SELECT ?,?,?,?,?,?,?,'confirmation',NULL,?,? WHERE EXISTS(SELECT 1 FROM bookings WHERE id=? AND status='paid')`,
    uid(), pt.id, booking.customer_id, `confirmation:${booking.id}`, customer.email,
    `Your booking with ${pt.brand_name} is confirmed`, body, emailMode === 'send' ? 'queued' : 'preview', now, booking.id
  );
}

// No-show email, ported from app/emails.cjs noShow(). Returns the guarded INSERT (dedupe
// per booking+session) and the preview fields the API returns.
export function noShowInsert(db, { booking, session, customer, pt, motivations, emailMode = 'preview', now = Date.now(), index }) {
  const dateLabel = new Date(session.starts_at + 'Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  const body = `Hi ${customer.name.split(' ')[0]},\n\nSorry we missed you at class! We hope you are doing well.\n\nWe missed you at ${booking.title} on ${dateLabel} at ${session.starts_at.slice(11)} (UK time).\n\n${motivations[index]}\n\nWe would love to see you at your next session. If you need support getting back into your routine, just reply and let us know.\n\n${pt.brand_name}`;
  const key = `noshow:${booking.id}:${session.id}`;
  const status = emailMode === 'send' ? 'queued' : 'preview';
  return {
    key,
    stmt: db.stmt(
      "INSERT OR IGNORE INTO email_outbox(id,pt_id,customer_id,dedupe_key,recipient,subject,body,kind,quote_index,status,created_at) VALUES(?,?,?,?,?,'Sorry we missed you at class!',?,'no_show',?,?,?)",
      uid(), pt.id, customer.id, key, customer.email, body, index, status, now
    )
  };
}
