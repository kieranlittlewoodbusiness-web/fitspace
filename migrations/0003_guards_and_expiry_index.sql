-- RC-4: commit-time assertions for D1 batches. D1 has no interactive transactions, so a
-- multi-statement batch cannot "SELECT ... then decide". Instead a batch starts with
--   INSERT INTO batch_guards(name,ok) SELECT ?,0 WHERE NOT (<precondition>)
-- If the precondition is false at commit time the row violates CHECK(ok=1), the statement
-- fails and D1 rolls back the whole batch. When it holds, nothing is inserted, so this
-- table is always empty. See src/db.mjs guard().
CREATE TABLE batch_guards(name TEXT NOT NULL, ok INTEGER NOT NULL CONSTRAINT batch_guard_failed CHECK(ok=1));

-- The expiry sweep `UPDATE bookings SET status='expired' WHERE status='pending' AND
-- expires_at<=?` runs on every reserve, pay, block update and booking GET; without this it
-- is a full table scan (bookings_block_status leads with block_id). CR 5940135102 minor 2.
CREATE INDEX bookings_pending_expiry ON bookings(status, expires_at);
