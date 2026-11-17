'use strict';
// Writes the column dump of app/db.cjs (node:sqlite) used by the D1 schema-parity test.
// Run with Node 24: node scripts/dump-app-schema.cjs
const fs = require('node:fs');
const { connect } = require('../app/db.cjs');
const db = connect(':memory:');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
const out = {};
for (const name of tables) out[name] = db.prepare('SELECT name,type,"notnull",dflt_value,pk FROM pragma_table_info(?) ORDER BY cid').all(name).map(c => ({ ...c }));
fs.writeFileSync(require('node:path').join(__dirname, '../workers-test/fixtures/app-schema-7cebef2.json'), JSON.stringify(out, null, 1) + '\n');
console.log(tables.length, 'tables');
