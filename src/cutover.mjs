// Cutover duplicate-live-booking handling (PM ruling, 17 Nov 2026).
//  - Never auto-delete, never auto-refund.
//  - The import gate STOPS if any customer has more than one live (pending/paid) booking
//    on a block, and returns a report: booking id, customer id, block id, payment status
//    (status, paid_at, refund_status), created time. No card data, no secrets, no emails.
//  - Opt-in only (explicit confirm phrase): keep the earliest PAID booking of each group
//    live (or the earliest booking if none is paid) and set the others to status 'review'
//    (the app's existing "needs a manual payment decision" state; no schema change, so it
//    works on the schema-0001 scratch database), recording each in audit_log with action
//    'cutover_duplicate_review' for the manual refund decision. Payments are not touched.
// Runs against the scratch copy of the source data (schema 0001), never in a request path.

export const CONFIRM_PHRASE = 'mark-duplicates-for-review';

export const DUPLICATE_REPORT_SQL = `SELECT b.id AS booking_id, b.customer_id, b.block_id, b.status AS payment_status,
  b.paid_at, b.refund_status, b.created_at
FROM bookings b JOIN (SELECT block_id, customer_id FROM bookings WHERE status IN ('pending','paid')
  GROUP BY block_id, customer_id HAVING count(*) > 1) d ON d.block_id = b.block_id AND d.customer_id = b.customer_id
WHERE b.status IN ('pending','paid')
ORDER BY b.block_id, b.customer_id, b.created_at, b.id`;

// Rank 1 = the booking kept live: paid before pending, then earliest paid_at/created_at.
const RANKED = `SELECT id, ROW_NUMBER() OVER (PARTITION BY block_id, customer_id
  ORDER BY CASE status WHEN 'paid' THEN 0 ELSE 1 END, coalesce(paid_at, created_at), created_at, id) AS rn
  FROM bookings WHERE status IN ('pending','paid')`;

export const MARK_SQL = (now, actor) => [
  `INSERT INTO audit_log(id,user_id,action,target_id,created_at)
   SELECT 'cutover-review-' || id, ${actor ? `'${String(actor).replaceAll("'", "''")}'` : 'NULL'}, 'cutover_duplicate_review', id, ${Number(now)} FROM (${RANKED}) WHERE rn > 1`,
  `UPDATE bookings SET status='review' WHERE id IN (SELECT id FROM (${RANKED}) WHERE rn > 1)`
];

/** The gate: { halted, report } — report rows are safe to write to a file. */
export async function importGate(db) {
  const report = await db.all(DUPLICATE_REPORT_SQL);
  const groups = new Set(report.map(r => r.block_id + '|' + r.customer_id)).size;
  return { halted: report.length > 0, groups, report };
}

/** Opt-in resolution. Throws unless `confirm` is the exact phrase. One atomic batch. */
export async function markDuplicatesForReview(db, { confirm, now = Date.now(), actor = null } = {}) {
  if (confirm !== CONFIRM_PHRASE) throw Object.assign(new Error(`Refusing to change bookings: pass confirm='${CONFIRM_PHRASE}'.`), { status: 400 });
  const before = await importGate(db);
  if (!before.halted) return { marked: [] };
  await db.batch(MARK_SQL(now, actor).map(sql => db.stmt(sql)));
  const marked = await db.all("SELECT target_id AS booking_id FROM audit_log WHERE action='cutover_duplicate_review' AND created_at=? ORDER BY target_id", Number(now));
  return { marked: marked.map(r => r.booking_id) };
}
