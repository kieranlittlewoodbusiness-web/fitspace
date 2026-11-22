-- DOWN for 0007. NOT in migrations/. One step (run before 0006's down):
--   wrangler d1 execute DB --local|--remote --file migrations-down/0007_soft_delete.down.sql
-- Drops only the columns this migration added. Booking, payment and webhook rows are left in place.
ALTER TABLE users DROP COLUMN deleted_at;
ALTER TABLE pts DROP COLUMN deleted_at;
DELETE FROM d1_migrations WHERE name='0007_soft_delete.sql';
