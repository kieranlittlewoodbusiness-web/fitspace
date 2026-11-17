-- RC-4 cutover pre-check (CR 5940135102 minor 4). Run against the SOURCE data loaded into a
-- scratch D1/SQLite database (schema 0001 only, i.e. before 0002 creates the partial unique
-- index), BEFORE importing to the real D1. Every query must return ZERO rows; otherwise
-- `CREATE UNIQUE INDEX bookings_one_live_per_customer` in 0002 fails and the import stops.
--   wrangler d1 execute DB --local --file scripts/cutover-precheck.sql
-- Resolution for duplicates is a product decision (keep the paid one, expire the other
-- pending holds) and must be agreed before cutover; this script only reports.

-- 1. More than one live (pending/paid) booking per customer per block.
SELECT 'duplicate_live_booking' AS problem, block_id, customer_id, count(*) AS n,
       group_concat(id || ':' || status, ',') AS bookings
FROM bookings WHERE status IN ('pending','paid')
GROUP BY block_id, customer_id HAVING count(*) > 1;

-- 2. Duplicate discount codes per owner (0002 discount_codes_unique), if codes are imported.
-- (No source table yet at 7cebef2; kept for RC-8 imports.)
