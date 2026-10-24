import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{DatabaseSync}=require('node:sqlite'),{connect,seed}=require('../app/db.cjs');
test('v5 booking constraint migration retains attendance, refund references and test binding while allowing live bookings',()=>{
 const dir=mkdtempSync(join(tmpdir(),'fitspace-migrate-')),file=join(dir,'db.sqlite');let db=connect(file);seed(db,true);
 db.prepare("UPDATE pts SET stripe_account='acct_old',stripe_ready=1 WHERE id='pt-six'").run();
 db.prepare("INSERT INTO attendance VALUES('booking-demo','block-attendance-session-0','attended','pt-demo',?)").run(Date.now());
 db.prepare("INSERT INTO stripe_refunds VALUES('re_old','booking-demo',100,'succeeded',1)").run();
 const columns=db.prepare('PRAGMA table_info(bookings)').all().map(c=>'"'+c.name+'"').join(',');
 const schema=db.prepare("SELECT sql FROM sqlite_master WHERE name='bookings'").get().sql;
 db.exec('PRAGMA foreign_keys=OFF; BEGIN');db.exec(schema.replace('CREATE TABLE bookings','CREATE TABLE old_bookings').replace(",'stripe_live'",''));db.exec(`INSERT INTO old_bookings (${columns}) SELECT ${columns} FROM bookings; DROP TABLE bookings; ALTER TABLE old_bookings RENAME TO bookings; COMMIT`);db.close();
 db=connect(file);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(db.prepare("SELECT status FROM attendance WHERE booking_id='booking-demo'").get().status,'attended');assert.equal(db.prepare("SELECT booking_id FROM stripe_refunds WHERE id='re_old'").get().booking_id,'booking-demo');assert.equal(db.prepare("SELECT account_id FROM stripe_connections WHERE pt_id='pt-six' AND mode='stripe_test'").get().account_id,'acct_old');
 db.prepare("UPDATE bookings SET mode='stripe_live' WHERE id='booking-sam'").run();assert.equal(db.prepare("SELECT mode FROM bookings WHERE id='booking-sam'").get().mode,'stripe_live');db.close();rmSync(dir,{recursive:true});
});
