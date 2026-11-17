// RC-4: generates the connector `execute` script that applies migrations 0001-0005 (recorded in
// d1_migrations, wrangler's table shape) to the PREVIEW database and seeds synthetic data only:
// one published PT, its trainer login (example.com, scrypt hash of a generated password read from
// the git-ignored 0600 file .secrets/preview.json), one block and one future session.
// Usage: node docs/rc-4/d1-rehearsal/preview-apply.mjs <preview-database-uuid> <out.js>
// Never point it at the production database.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { safeDatabaseId } from './guard.mjs';
const [RAW_DB, OUT] = process.argv.slice(2);
if (!RAW_DB || !OUT) throw new Error('usage: preview-apply.mjs <preview-database-uuid> <out.js>');
// CR 5943169048 C2: the shared, normalised guard (upper case / whitespace no longer get past).
const DB = safeDatabaseId(RAW_DB);
const statements = sql => { const out = []; let cur = '', i = 0, inStr = false;
  while (i < sql.length) { const c = sql[i];
    if (inStr) { cur += c; if (c === "'") { if (sql[i + 1] === "'") { cur += "'"; i++; } else inStr = false; } i++; continue; }
    if (c === "'") { inStr = true; cur += c; i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === ';') { out.push(cur); cur = ''; i++; continue; }
    cur += c; i++; }
  out.push(cur); return out.map(s => s.trim()).filter(Boolean); };
const ups = readdirSync('migrations').filter(f => f.endsWith('.sql')).sort().map(f => ({ name: f, stmts: statements(readFileSync('migrations/' + f, 'utf8')) }));
const s = JSON.parse(readFileSync('.secrets/preview.json', 'utf8'));
const seed = { email: s.SEED_PT_EMAIL, hash: s.SEED_PT_PASSWORD_HASH };
writeFileSync(OUT, `async () => {
const DB = ${JSON.stringify(DB)};
const q = async batch => (await cloudflare.request({ method: 'POST', path: \`/accounts/\${accountId}/d1/database/\${DB}/query\`, body: { batch } })).result;
const one = async (sql, params) => (await q([{ sql, ...(params ? { params } : {}) }]))[0].results;
const recorded = async () => (await one("SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'")).length ? (await one('SELECT name FROM d1_migrations ORDER BY id')).map(r => r.name) : [];
const UPS = ${JSON.stringify(ups)};
const SEED = ${JSON.stringify(seed)};
const before = await recorded(); const applied = [];
for (const m of UPS) { if (before.includes(m.name)) continue;
  await q([{ sql: "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)" }, ...m.stmts.map(sql => ({ sql })), { sql: 'INSERT INTO d1_migrations(name) VALUES(?)', params: [m.name] }]);
  applied.push(m.name); }
const now = Date.now(); const start = new Date(now + 14 * 86400000); start.setUTCHours(18, 30, 0, 0);
if (!(await one("SELECT count(*) n FROM pts WHERE id='preview-pt'"))[0].n) await q([
  { sql: "INSERT INTO pts(id,slug,brand_name,tagline,description,about,created_at) VALUES('preview-pt','preview-trainer','Preview Trainer (synthetic)','Synthetic preview data','Synthetic preview data, not a real trainer.','Synthetic preview data.',?)", params: [now] },
  { sql: "INSERT INTO users(id,name,email,password_hash,role,pt_id,created_at) VALUES('preview-pt-user','Preview Trainer',?,?,'pt','preview-pt',?)", params: [SEED.email, SEED.hash, now] },
  { sql: "INSERT INTO blocks(id,pt_id,title,description,venue,price_pence,capacity,created_at) VALUES('preview-block','preview-pt','Preview class (synthetic)','Synthetic preview data.','Example venue',1000,8,?)", params: [now] },
  { sql: "INSERT INTO class_sessions VALUES('preview-session','preview-block',?,?,60)", params: [start.toISOString().slice(0, 16), start.getTime()] }
]);
return { applied, recorded: await recorded(),
  tables: (await one("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name<>'d1_migrations'"))[0].n,
  seed: (await one("SELECT (SELECT count(*) FROM pts) pts,(SELECT count(*) FROM users) users,(SELECT count(*) FROM blocks) blocks,(SELECT count(*) FROM class_sessions) sessions,(SELECT count(*) FROM bookings) bookings"))[0] };
}`);
