-- DOWN for 0006. NOT in migrations/. One step (run before 0005's down):
--   wrangler d1 execute DB --local|--remote --file migrations-down/0006_pt_profile.down.sql
-- Drops only the columns this migration added. brand_name, about and other existing
-- columns are left in place, so prior branding data is preserved.
ALTER TABLE pts DROP COLUMN business_name;
ALTER TABLE pts DROP COLUMN contact_email;
ALTER TABLE pts DROP COLUMN contact_phone;
ALTER TABLE pts DROP COLUMN reply_to_email;
ALTER TABLE pts DROP COLUMN reply_to_name;
ALTER TABLE pts DROP COLUMN venue_name;
ALTER TABLE pts DROP COLUMN venue_address;
ALTER TABLE pts DROP COLUMN cancellation_window_hours;
ALTER TABLE pts DROP COLUMN photo_url;
DELETE FROM d1_migrations WHERE name='0006_pt_profile.sql';
