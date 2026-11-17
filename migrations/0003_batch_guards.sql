-- RC-4: commit-time assertions for D1 batches. D1 has no interactive transactions, so a
-- multi-statement batch cannot "SELECT ... then decide". Instead a batch starts with
--   INSERT INTO batch_guards(name,ok) SELECT ?,0 WHERE NOT (<precondition>)
-- If the precondition is false at commit time the row violates CHECK(ok=1), the statement
-- fails and D1 rolls back the whole batch. When it holds, nothing is inserted, so this
-- table is always empty. See src/db.mjs guard().
CREATE TABLE batch_guards(name TEXT NOT NULL, ok INTEGER NOT NULL CONSTRAINT batch_guard_failed CHECK(ok=1));
