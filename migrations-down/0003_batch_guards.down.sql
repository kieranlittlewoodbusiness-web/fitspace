-- DOWN for 0003 (see docs/rc-4/RC-4-d1-port.md "Rollback"). Then:
-- DELETE FROM d1_migrations WHERE name='0003_batch_guards.sql';
DROP TABLE IF EXISTS batch_guards;
