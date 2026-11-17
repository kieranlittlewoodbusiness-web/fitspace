-- DOWN for 0002. NOT in migrations/ so `wrangler d1 migrations apply` never runs it.
-- Use only to undo 0002's schema while KEEPING data written since (otherwise prefer a
-- D1 Time Travel restore; see docs/rc-4/RC-4-d1-port.md "Rollback").
-- Run: wrangler d1 execute DB --local|--remote --file migrations-down/0002_locks_and_rc5_rc9_foundation.down.sql
--      then: DELETE FROM d1_migrations WHERE name='0002_locks_and_rc5_rc9_foundation.sql';
-- Data in the dropped tables/columns (subscriptions, codes, waitlist, rate limits) is lost:
-- export it first with `wrangler d1 export`.
DROP TABLE IF EXISTS rate_limits;
DROP INDEX IF EXISTS waitlist_queue;
DROP INDEX IF EXISTS waitlist_one_live_per_customer;
DROP TABLE IF EXISTS waitlist_entries;
ALTER TABLE blocks DROP COLUMN updated_at;
ALTER TABLE blocks DROP COLUMN cancellation_policy;
ALTER TABLE blocks DROP COLUMN online_url;
ALTER TABLE blocks DROP COLUMN location_type;
ALTER TABLE blocks DROP COLUMN duration_minutes;
ALTER TABLE blocks DROP COLUMN weeks;
ALTER TABLE blocks DROP COLUMN kind;
ALTER TABLE bookings DROP COLUMN discount_code_id;
ALTER TABLE bookings DROP COLUMN discount_pence;
ALTER TABLE bookings DROP COLUMN list_price_pence;
DROP TABLE IF EXISTS discount_redemptions;
DROP INDEX IF EXISTS discount_codes_unique;
DROP TABLE IF EXISTS discount_codes;
DROP TABLE IF EXISTS pt_subscriptions;
ALTER TABLE stripe_connections DROP COLUMN updated_at;
ALTER TABLE stripe_connections DROP COLUMN requirements;
ALTER TABLE stripe_connections DROP COLUMN details_submitted;
ALTER TABLE stripe_connections DROP COLUMN payouts_enabled;
ALTER TABLE stripe_connections DROP COLUMN charges_enabled;
ALTER TABLE webhook_events DROP COLUMN account;
ALTER TABLE webhook_events DROP COLUMN type;
DROP INDEX IF EXISTS bookings_one_live_per_customer;
