-- DOWN for 0005. NOT in migrations/. One step (run before 0004's down):
--   wrangler d1 execute DB --local|--remote --file migrations-down/0005_create_hash.down.sql
ALTER TABLE blocks DROP COLUMN create_hash;
ALTER TABLE pts DROP COLUMN create_hash;
DELETE FROM d1_migrations WHERE name='0005_create_hash.sql';
