-- DOWN for 0004. NOT in migrations/. One step (run before 0003's down):
--   wrangler d1 execute DB --local|--remote --file migrations-down/0004_phase3.down.sql
-- create_key values are lost (they only matter for in-flight retries).
DROP INDEX IF EXISTS blocks_create_key;
ALTER TABLE blocks DROP COLUMN create_key;
DROP INDEX IF EXISTS pts_create_key;
ALTER TABLE pts DROP COLUMN create_key;
DROP INDEX IF EXISTS email_outbox_due;
ALTER TABLE auth_mail_jobs DROP COLUMN claimed_until;
DELETE FROM d1_migrations WHERE name='0004_phase3.sql';
