-- DOWN for 0003 (see docs/rc-4/RC-4-d1-port.md "Rollback"). NOT in migrations/.
-- One step: wrangler d1 execute DB --local|--remote --file migrations-down/0003_guards_and_expiry_index.down.sql
-- The last statement removes the migration record so `migrations apply` can re-apply 0003.
DROP INDEX IF EXISTS bookings_pending_expiry;
DROP TABLE IF EXISTS batch_guards;
DELETE FROM d1_migrations WHERE name='0003_guards_and_expiry_index.sql';
