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
