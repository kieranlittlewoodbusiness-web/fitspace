// RC-4: generates the two Cloudflare-connector `execute` scripts used for the 17 Nov 2026 D1
// rehearsal (apply 0001-0005 + d1_migrations rows + synthetic data; down 0005->0002, re-apply,
// schema compare). Run from the repo root. Only ever point it at a throwaway rehearsal database.
// Kept under docs/ (not scripts/) on purpose: it is rehearsal evidence that runs unscoped DDL and
// synthetic inserts, not app or ops code, so it sits outside the per-query scope lint.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
const DB = process.argv[2]; if (!DB) throw new Error('usage: node docs/rc-4/d1-rehearsal/generate.mjs <rehearsal-database-uuid> [outdir]');
// CR 5941600057: never the production database (step2 runs DOWN migrations).
export const PRODUCTION_DB = 'fd8a613f-4dd4-462b-83e0-d7673031a6fc';
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(DB)) throw new Error('refusing: not a database uuid');
if (DB.toLowerCase() === PRODUCTION_DB || DB.toLowerCase().startsWith(PRODUCTION_DB.slice(0, 8))) throw new Error('refusing: that is the production database');
const OUT = process.argv[3] || '/tmp/rc4-remote';
mkdirSync(OUT, { recursive: true });
const statements = sql => { const out = []; let cur = '', i = 0, inStr = false;
  while (i < sql.length) { const c = sql[i];
    if (inStr) { cur += c; if (c === "'") { if (sql[i + 1] === "'") { cur += "'"; i++; } else inStr = false; } i++; continue; }
    if (c === "'") { inStr = true; cur += c; i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === ';') { out.push(cur); cur = ''; i++; continue; }
    cur += c; i++; }
  out.push(cur); return out.map(s => s.trim()).filter(Boolean); };
const ups = readdirSync('migrations').filter(f => f.endsWith('.sql')).sort().map(f => ({ name: f, stmts: statements(readFileSync('migrations/' + f, 'utf8')) }));
const downs = ['0005_create_hash', '0004_phase3', '0003_guards_and_expiry_index', '0002_locks_and_rc5_rc9_foundation'].map(n => ({ name: n, stmts: statements(readFileSync(`migrations-down/${n}.down.sql`, 'utf8')) }));
const appSchema = JSON.parse(readFileSync('workers-test/fixtures/app-schema-7cebef2.json', 'utf8'));
const common = `
const DB = ${JSON.stringify(DB)};
const q = async (batch) => { const r = await cloudflare.request({ method: 'POST', path: \`/accounts/\${accountId}/d1/database/\${DB}/query\`, body: { batch: batch.map(sql => (typeof sql === 'string' ? { sql } : sql)) } }); return r.result; };
const one = async (sql, params) => (await q([{ sql, ...(params ? { params } : {}) }]))[0].results;
const recorded = async () => { const t = await one("SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'"); return t.length ? (await one('SELECT name FROM d1_migrations ORDER BY id')).map(r => r.name) : []; };
const schema = async () => (await one("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'d1_migrations' ORDER BY type,name"));
const fp = rows => { let h = 0x811c9dc5; for (const ch of JSON.stringify(rows)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
const UPS = ${JSON.stringify(ups)};
const DOWNS = ${JSON.stringify(downs)};
const applyUp = async m => q(["CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)", ...m.stmts, { sql: 'INSERT INTO d1_migrations(name) VALUES(?)', params: [m.name] }]);
`;
// Step 1: apply 0001..0005 (skips any already recorded), check tables, insert synthetic data.
writeFileSync(OUT + '/step1.js', `async () => {${common}
  const before = await recorded();
  const applied = [];
  for (const m of UPS) { if (before.includes(m.name)) continue; await applyUp(m); applied.push(m.name + ' (' + m.stmts.length + ' statements)'); }
  const s = await schema();
  const tables = s.filter(r => r.type === 'table').map(r => r.name);
  const indexes = s.filter(r => r.type === 'index').length;
  const now = Date.now();
  const have = await one("SELECT count(*) n FROM pts WHERE id='rehearsal-pt'");
  if (!have[0].n) await q([
    { sql: "INSERT INTO pts(id,slug,brand_name,tagline,description,about,created_at,create_key,create_hash) VALUES('rehearsal-pt','rehearsal-pt','REHEARSAL PT','Synthetic','Synthetic test data','Synthetic test data only',?,'rehearsal-create-key-0001','synthetic')", params: [String(now)] },
    { sql: "INSERT INTO users(id,name,email,password_hash,role,pt_id,created_at) VALUES('rehearsal-pt-user','Rehearsal Trainer','rehearsal-pt@example.com','x','pt','rehearsal-pt',?)", params: [String(now)] },
    { sql: "INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('rehearsal-customer','Rehearsal Customer','rehearsal-customer@example.com','x','customer',?)", params: [String(now)] },
    { sql: "INSERT INTO blocks(id,pt_id,title,description,venue,price_pence,capacity,created_at) VALUES('rehearsal-block','rehearsal-pt','Rehearsal block','Synthetic','Nowhere',1500,5,?)", params: [String(now)] },
    { sql: "INSERT INTO class_sessions VALUES('rehearsal-session','rehearsal-block','2099-01-05T18:30',4071407400000,60)" },
    { sql: "INSERT INTO bookings(id,block_id,customer_id,reference,status,amount_pence,mode,checkout_token,expires_at,created_at) VALUES('rehearsal-booking','rehearsal-block','rehearsal-customer','FIT-REHEARSAL','paid',1500,'demo','rehearsal-token-0001',?,?)", params: [String(now + 1800000), String(now)] }
  ]);
  const counts = (await one("SELECT (SELECT count(*) FROM pts) pts,(SELECT count(*) FROM users) users,(SELECT count(*) FROM blocks) blocks,(SELECT count(*) FROM class_sessions) class_sessions,(SELECT count(*) FROM bookings) bookings"))[0];
  // Guard table works remotely (CHECK(ok=1) rejects a failed guard).
  let guard;
  try { await q([{ sql: "INSERT INTO batch_guards(name,ok) SELECT 'rehearsal',0 WHERE NOT (1=0)" }]); guard = 'NOT rejected (unexpected)'; } catch (e) { guard = 'rejected: ' + String(e.message).match(/CHECK constraint failed[^"]*/)?.[0]; }
  return { recordedBefore: before, applied, recorded: await recorded(), tableCount: tables.length, tables, indexes, schemaFingerprint: fp(s), syntheticCounts: counts, guardCheck: guard };
}`);
// Step 2: down 0005 -> 0002 (each only if recorded), check 0001 parity + data kept, then re-apply, compare.
writeFileSync(OUT + '/step2.js', `async () => {${common}
  const APP = ${JSON.stringify(appSchema)};
  const fullBefore = await schema();
  const out = { fingerprintBefore: fp(fullBefore), recordedBefore: await recorded(), down: [] };
  for (const d of DOWNS) {
    const rec = await recorded();
    if (!rec.some(n => n.startsWith(d.name.slice(0, 4)))) { out.down.push(d.name + ': not recorded, skipped'); continue; }
    await q(d.stmts);
    out.down.push(d.name + '.down.sql (' + d.stmts.length + ' statements) -> recorded: ' + (await recorded()).join(','));
  }
  const mismatches = [];
  for (const [table, cols] of Object.entries(APP)) {
    const got = (await one(\`SELECT name,type,"notnull",dflt_value,pk FROM pragma_table_info('\${table}') ORDER BY cid\`)).map(c => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }));
    if (JSON.stringify(got) !== JSON.stringify(cols)) mismatches.push(table);
  }
  const atBase = await schema();
  out.afterDown = { tables: atBase.filter(r => r.type === 'table').length, appSchemaTables: Object.keys(APP).length, columnParityMismatches: mismatches, syntheticCounts: (await one("SELECT (SELECT count(*) FROM pts) pts,(SELECT count(*) FROM users) users,(SELECT count(*) FROM blocks) blocks,(SELECT count(*) FROM bookings) bookings"))[0] };
  const re = [];
  for (const m of UPS.slice(1)) { if ((await recorded()).includes(m.name)) continue; await applyUp(m); re.push(m.name); }
  const fullAfter = await schema();
  const diff = fullBefore.filter(r => !fullAfter.some(x => JSON.stringify(x) === JSON.stringify(r))).map(r => r.type + ':' + r.name).concat(fullAfter.filter(r => !fullBefore.some(x => JSON.stringify(x) === JSON.stringify(r))).map(r => '+' + r.type + ':' + r.name));
  return { ...out, reapplied: re, recordedAfter: await recorded(), fingerprintAfter: fp(fullAfter), schemaIdentical: diff.length === 0, diff, syntheticCountsAfter: (await one("SELECT (SELECT count(*) FROM pts) pts,(SELECT count(*) FROM bookings) bookings"))[0] };
}`);
