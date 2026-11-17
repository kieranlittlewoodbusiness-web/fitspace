// RC-4 phase 4: snapshot (live app SQLite format) -> D1 import, verified against a SQLite
// database built from migrations 0001-0004 (D1 is SQLite). Demo data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { makeDemoSnapshot } from '../scripts/demo-snapshot.mjs';
import { prepareImport, TABLE_ORDER } from '../scripts/snapshot-import.mjs';
import { CONFIRM_PHRASE } from '../src/cutover.mjs';

const root = path.join(import.meta.dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc4-snap-test-'));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function d1Like() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const f of fs.readdirSync(path.join(root, 'migrations')).sort()) db.exec(fs.readFileSync(path.join(root, 'migrations', f), 'utf8'));
  return db;
}
const load = (db, statements) => { db.exec('BEGIN'); for (const s of statements) db.exec(s); db.exec('COMMIT'); };

test('demo snapshot imports into the 0001-0004 schema with identical rows; the source file is untouched', async () => {
  const dir = tmp(), file = makeDemoSnapshot(path.join(dir, 'demo.sqlite'), db => {
    db.prepare("UPDATE pts SET about=? WHERE id='pt-six'").run("It's \"quoted\";\nnew line, emoji 💪, back\\slash, -- not a comment");
  });
  const before = sha(file);
  const r = await prepareImport(file);
  assert.equal(r.status, 'ok');
  assert.equal(sha(file), before);
  const target = d1Like();
  load(target, r.statements);
  const src = new DatabaseSync(file, { readOnly: true });
  for (const t of TABLE_ORDER) {
    const cols = src.prepare(`PRAGMA table_info("${t}")`).all().map(c => `"${c.name}"`).join(',');
    assert.deepEqual(target.prepare(`SELECT ${cols} FROM "${t}" ORDER BY rowid`).all(), src.prepare(`SELECT ${cols} FROM "${t}" ORDER BY rowid`).all(), t);
  }
  assert.equal(target.prepare("SELECT about FROM pts WHERE id='pt-six'").get().about, "It's \"quoted\";\nnew line, emoji 💪, back\\slash, -- not a comment");
  assert.deepEqual(target.prepare('PRAGMA foreign_key_check').all(), []);
  // Columns added by 0002/0004 take their defaults.
  assert.equal(target.prepare("SELECT discount_pence FROM bookings WHERE id='booking-demo'").get().discount_pence, 0);
  assert.equal(target.prepare("SELECT create_key FROM blocks WHERE id='block-six'").get().create_key, null);
  console.log('snapshot import:', r.statements.length, 'rows', JSON.stringify(Object.fromEntries(Object.entries(r.counts).filter(([, n]) => n))));
  src.close(); fs.rmSync(dir, { recursive: true });
});

test('duplicate live bookings halt the import; opt-in needs the phrase and records duplicate_import:kept=<id>', async () => {
  const dir = tmp(), file = makeDemoSnapshot(path.join(dir, 'dup.sqlite'), db => {
    const add = db.prepare("INSERT INTO bookings(id,block_id,customer_id,reference,status,amount_pence,mode,checkout_token,expires_at,paid_at,created_at) VALUES(?,?,?,?,?,1500,'demo',?,?,?,?)");
    add.run('dup-pending', 'block-six', 'customer-demo', 'FIT-DUP1', 'pending', 'tok-dup-1', Date.now() + 60000, null, 1000);
    add.run('dup-paid-late', 'block-six', 'customer-demo', 'FIT-DUP2', 'paid', 'tok-dup-2', Date.now(), 5000, 2000);
    add.run('dup-paid-early', 'block-six', 'customer-demo', 'FIT-DUP3', 'paid', 'tok-dup-3', Date.now(), 3000, 3000);
  });
  const halted = await prepareImport(file);
  assert.equal(halted.status, 'halted');
  assert.deepEqual(halted.report.map(r => r.booking_id).sort(), ['dup-paid-early', 'dup-paid-late', 'dup-pending']);
  assert.deepEqual(Object.keys(halted.report[0]).sort(), ['block_id', 'booking_id', 'created_at', 'customer_id', 'paid_at', 'payment_status', 'refund_status']);
  await assert.rejects(prepareImport(file, { markDuplicates: true }), /Refusing/);
  const r = await prepareImport(file, { markDuplicates: true, confirm: CONFIRM_PHRASE, now: 42 });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.marked.map(m => [m.booking_id, m.action]).sort(), [['dup-paid-late', 'duplicate_import:kept=dup-paid-early'], ['dup-pending', 'duplicate_import:kept=dup-paid-early']]);
  const target = d1Like();
  load(target, r.statements); // 0002's one-live-booking index accepts the data now
  assert.deepEqual(target.prepare("SELECT id,status FROM bookings WHERE id LIKE 'dup-%' ORDER BY id").all().map(x => ({ ...x })), [{ id: 'dup-paid-early', status: 'paid' }, { id: 'dup-paid-late', status: 'review' }, { id: 'dup-pending', status: 'review' }]);
  console.log('snapshot duplicates: halted', halted.report.length, 'rows; opt-in marked', r.marked.length, 'kept dup-paid-early');
  fs.rmSync(dir, { recursive: true });
});

test('a snapshot whose schema differs from 0001 stops the import', async () => {
  const dir = tmp(), file = makeDemoSnapshot(path.join(dir, 'odd.sqlite'), db => db.exec('CREATE TABLE surprise(id TEXT)'));
  const r = await prepareImport(file);
  assert.equal(r.status, 'schema');
  assert.deepEqual(r.problems, ['unexpected table surprise']);
  fs.rmSync(dir, { recursive: true });
});
