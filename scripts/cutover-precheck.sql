-- RC-4 cutover pre-check (CR 5940135102 minor 4; PM ruling 17 Nov 2026). Run against the
-- SOURCE data in a scratch D1 at schema 0001, before 0002 creates the partial unique index.
-- Must return ZERO rows. Any row means the import STOPS (scripts/cutover-import.mjs writes
-- the report). Never auto-delete or auto-refund; the only resolution is the explicit opt-in
-- step in scripts/cutover-import.mjs (see docs/rc-4/RC-4-d1-port.md §4).
-- Kept identical to DUPLICATE_REPORT_SQL in src/cutover.mjs (tested).
SELECT b.id AS booking_id, b.customer_id, b.block_id, b.status AS payment_status,
  b.paid_at, b.refund_status, b.created_at
FROM bookings b JOIN (SELECT block_id, customer_id FROM bookings WHERE status IN ('pending','paid')
  GROUP BY block_id, customer_id HAVING count(*) > 1) d ON d.block_id = b.block_id AND d.customer_id = b.customer_id
WHERE b.status IN ('pending','paid')
ORDER BY b.block_id, b.customer_id, b.created_at, b.id;
