-- DOWN for 0008. NOT in migrations/. One step (run before 0007's down):
--   wrangler d1 execute DB --local --file migrations-down/0008_instalments.down.sql
-- PREVIEW/LOCAL ONLY (0008 is not applied to production). Drops only what 0008 added:
-- instalment rows and block plan options are discarded; bookings keep amount_pence and status.
DROP INDEX IF EXISTS booking_instalments_status;
DROP INDEX IF EXISTS booking_instalments_invoice;
DROP TABLE IF EXISTS booking_instalments;
DROP INDEX IF EXISTS bookings_subscription;
ALTER TABLE bookings DROP COLUMN stripe_schedule_id;
ALTER TABLE bookings DROP COLUMN stripe_subscription_id;
ALTER TABLE bookings DROP COLUMN stripe_customer_id;
ALTER TABLE bookings DROP COLUMN plan_anchor;
ALTER TABLE bookings DROP COLUMN plan_status;
ALTER TABLE bookings DROP COLUMN total_pence;
ALTER TABLE bookings DROP COLUMN plan_count;
ALTER TABLE bookings DROP COLUMN plan;
ALTER TABLE blocks DROP COLUMN upfront_enabled;
DROP TABLE IF EXISTS block_payment_plans;
DELETE FROM d1_migrations WHERE name='0008_instalments.sql';
