// Builds a snapshot-format SQLite file from the app's own demo seed (app/db.cjs connect +
// seed): the same format the live app stores in Postgres. Test fixture only: demo data,
// demo users, no real customer data, no secrets.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/** Writes a demo snapshot to `file`. `mutate(db)` may add rows (node:sqlite, app schema). */
export function makeDemoSnapshot(file, mutate) {
  const { connect, seed } = require('../app/db.cjs');
  const db = connect(file);
  seed(db, true);
  if (mutate) mutate(db);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return file;
}
