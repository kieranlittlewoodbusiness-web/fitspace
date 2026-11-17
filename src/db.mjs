// Async data-access layer over a D1 binding. It replaces node:sqlite DatabaseSync
// (app/db.cjs) with the same SQLite SQL and `?` placeholders, so each of the ~109
// `db.prepare(sql).get|all|run(...args)` call sites ports mechanically to
// `await db.get|all|run(sql, ...args)`.
//
// There is deliberately no tx(): D1 has no interactive transactions (BEGIN and SAVEPOINT
// are rejected). Multi-step read-then-write flows run inside the Writer Durable Object
// (src/writer.mjs) and commit with ONE db.batch() of guarded statements.

export class DbError extends Error {}

const clean = args => args.map(value => (value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value));

export function createDb(d1) {
  if (!d1 || typeof d1.prepare !== 'function') throw new DbError('D1 binding DB is missing.');
  const stmt = (sql, ...args) => d1.prepare(sql).bind(...clean(args));
  return {
    d1,
    /** A bound statement for use in batch(). */
    stmt,
    /** First row or null (DatabaseSync .get() returned undefined). */
    async get(sql, ...args) { return (await stmt(sql, ...args).first()) ?? null; },
    /** All rows. */
    async all(sql, ...args) { return (await stmt(sql, ...args).all()).results; },
    /** Run a write. Returns { changes, lastRowId } like DatabaseSync .run(). */
    async run(sql, ...args) {
      const { meta } = await stmt(sql, ...args).run();
      return { changes: meta.changes, lastRowId: meta.last_row_id };
    },
    /**
     * Commit-time assertion for a batch (migrations/0003). Put it before the writes it
     * protects: if `condition` is false when the batch runs, the batch aborts with a
     * guard failure (see isGuardFailure) and nothing in it is applied.
     */
    guard(name, condition, ...args) {
      return stmt(`INSERT INTO batch_guards(name,ok) SELECT ?,0 WHERE NOT (${condition})`, name, ...args);
    },
    /**
     * Atomic: every statement commits, or none does (D1 runs a batch as one SQL
     * transaction). Returns one result per statement: { rows, changes }.
     */
    async batch(statements) {
      const results = await d1.batch(statements.filter(Boolean));
      return results.map(r => ({ rows: r.results || [], changes: r.meta?.changes ?? 0 }));
    }
  };
}

/** True when a D1 error is a UNIQUE/PRIMARY KEY violation, optionally on a given target. */
export function isUniqueViolation(error, target) {
  const message = String(error?.message || '') + String(error?.cause?.message || '');
  if (!/UNIQUE constraint failed|SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)/i.test(message)) return false;
  return target ? message.includes(target) : true;
}

/** True when a batch aborted because a db.guard() precondition was false at commit time. */
export function isGuardFailure(error) {
  return /batch_guard_failed|CHECK constraint failed: (batch_guard_failed|ok=1)/i.test(String(error?.message || '') + String(error?.cause?.message || ''));
}
