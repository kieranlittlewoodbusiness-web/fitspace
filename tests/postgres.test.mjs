import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { databasePool, ensureSchema, withSnapshot } from '../lib/storage.mjs';
const { createHandler } = await import(process.env.FITSPACE_TEST_BUNDLED ? '../.netlify/verified-functions/platform/netlify/functions/platform.mjs' : '../netlify/functions/platform.mjs');
const require=createRequire(import.meta.url);
const {connect}=require('../app/db.cjs');
let db,server,pool,handler,ptId,blockId,bookingId,ptCredentials;
const base='https://public.example',adminPass='OwnedAdminFixturePassword123!',customerPass='CustomerFixturePassword123!';
const provider=()=>({pool,ready:Promise.resolve()});
before(async()=>{
 process.env.ADMIN_EMAIL='owner@example.com';process.env.ADMIN_PASSWORD=adminPass;
 process.env.DATA_NAMESPACE='public-test-v4';delete process.env.PREVIEW_PASSWORD;
 db=await PGlite.create();server=new PGLiteSocketServer({db,port:0,host:'127.0.0.1',maxConnections:1});await server.start();
 pool=databasePool('postgresql://postgres:postgres@'+server.getServerConn()+'/postgres?sslmode=disable');await ensureSchema(pool);
 handler=createHandler({getStorage:provider});
});
after(async()=>{await pool?.end();await server?.stop();await db?.close();});
let ip=0;
function client(){let cookie='',csrf='';const address=`198.51.100.${++ip}`;return {
 async request(path,method='GET',data,headers={}){const response=await handler(new Request(base+path,{method,headers:{...(cookie?{cookie}:{}),...(!['GET','HEAD'].includes(method)?{origin:base,'content-type':'application/json',...(csrf?{'x-csrf-token':csrf}:{})}:{}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})}),{ip:address});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const result=(response.headers.get('content-type')||'').includes('json')?await response.json():await response.text();if(result.csrf)csrf=result.csrf;return {status:response.status,data:result,headers:response.headers};},
 async login(email,password){const r=await this.request('/api/auth/login','POST',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return r;},
 async signup(email){const r=await this.request('/api/auth/signup','POST',{name:'Test Customer',email,password:customerPass,demo_acknowledged:true,role:'admin'});assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.user.role,'customer');}
};}
const admin=client(),pt=client(),customer=client();
const future=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10)+'T18:30';
const classData=(extra={})=>({title:'Six-week strength block',description:'Supportive coaching and progress every week.',venue:'Training Studio',capacity:15,price_pence:9000,published:true,sessions:Array.from({length:6},(_,i)=>({starts_at:future(7+i*7),duration_minutes:60})),...extra});

test('public browsing requires no preview cookie; dashboards and fixture accounts remain protected',async()=>{
 const anon=client();const home=await anon.request('/');assert.equal(home.status,200);assert.ok(!home.data.includes('Preview password'));assert.ok(!home.data.includes('noindex'));
 const script=await anon.request('/app.js');assert.equal(script.status,200);assert.ok(!script.data.includes('TrainTogether123!'));assert.ok(!script.data.includes('demo-login'));
 assert.equal((await anon.request('/api/me')).data.demo,false);
 assert.equal((await anon.request('/api/public/pts')).status,200);
 assert.equal((await anon.request('/api/dashboard')).status,401);
 assert.equal((await anon.request('/api/auth/login','POST',{email:'admin@example.com',password:'TrainTogether123!'})).status,401);
 await admin.login('owner@example.com',adminPass);
 const dashboard=await admin.request('/api/dashboard');assert.equal(dashboard.data.stats.pts,0);assert.equal(dashboard.data.stats.customers,0);
});

test('admin creates the PT; public pages, signup, checkout and attendance work without a site password',async()=>{
 const result=await admin.request('/api/admin/pts','POST',{owner_name:'Alex Trainer',email:'coach@example.com',brand_name:'SIX WEEK CLUB',slug:'six-week-club',tagline:'Six weeks. Get stronger.',description:'Build strength, fitness and confidence with focused coaching.',about:'Train well and build a routine you can keep.',accent:'#ffd43b',background:'#ffffff',foreground:'#111111',features:['Strength coaching','Small supportive groups'],published:true});
 assert.equal(result.status,201,JSON.stringify(result.data));ptId=result.data.pt_id;ptCredentials=result.data;
 await pt.login(result.data.email,result.data.temporary_password);
 assert.equal((await pt.request('/api/auth/password','POST',{current_password:result.data.temporary_password,new_password:'OwnedPTFixturePassword123!'})).status,200);
 const created=await pt.request('/api/blocks','POST',classData());assert.equal(created.status,201,JSON.stringify(created.data));blockId=created.data.block.id;
 const anon=client();assert.equal((await anon.request('/api/public/pts/six-week-club')).data.blocks[0].available,15);
 await customer.signup('client@example.com');
 const booking=await customer.request('/api/bookings','POST',{block_id:blockId,checkout_token:crypto.randomUUID(),amount_pence:1});assert.equal(booking.status,201,JSON.stringify(booking.data));bookingId=booking.data.booking.id;assert.equal(booking.data.booking.amount_pence,9000);
 const paid=await customer.request('/api/bookings/'+bookingId+'/pay','POST',{result:'success'});assert.equal(paid.data.booking.status,'paid');
 assert.equal((await anon.request('/api/public/pts/six-week-club')).data.blocks[0].available,14);
 assert.equal((await customer.request('/api/admin/pts','POST',{})).status,403);
 assert.equal((await pt.request('/api/admin/pts','POST',{})).status,403);
 assert.equal((await anon.request('/api/bookings/'+bookingId)).status,401);
 // Shift a fixture session into the past to test attendance; no public mutation endpoint bypasses date checks.
 const sessionId=paid.data.booking.sessions[0].id;
 await withSnapshot(pool,process.env.DATA_NAMESPACE,async filename=>{const sqlite=connect(filename);sqlite.prepare('UPDATE class_sessions SET starts_epoch=? WHERE id=?').run(Date.now()-86400000,sessionId);sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');sqlite.close();return new Response('fixture');});
 const missed=await pt.request('/api/attendance','POST',{booking_id:bookingId,session_id:sessionId,status:'no_show'});assert.equal(missed.status,200,JSON.stringify(missed.data));assert.equal(missed.data.email.subject,'Sorry we missed you at class!');assert.equal(missed.data.email.status,'preview');
 const again=await pt.request('/api/attendance','POST',{booking_id:bookingId,session_id:sessionId,status:'no_show'});assert.equal(again.data.email.id,missed.data.email.id);
 assert.equal((await admin.request('/api/dashboard')).data.quotes.length,20);
 await pool.end();await server.stop();server=new PGLiteSocketServer({db,port:0,host:'127.0.0.1',maxConnections:1});await server.start();pool=databasePool('postgresql://postgres:postgres@'+server.getServerConn()+'/postgres?sslmode=disable');handler=createHandler({getStorage:provider});
 assert.equal((await customer.request('/api/bookings/'+bookingId)).data.booking.status,'paid');
});

test('public capacity, idempotency, failed checkout and cross-origin checks remain enforced',async()=>{
 const created=await pt.request('/api/blocks','POST',classData({title:'One-place class',capacity:1,sessions:[{starts_at:future(50),duration_minutes:60}]}));assert.equal(created.status,201);
 const a=client(),b=client();await a.signup('a@example.com');await b.signup('b@example.com');const tokens=[crypto.randomUUID(),crypto.randomUUID()];
 const results=await Promise.all([a,b].map((c,i)=>c.request('/api/bookings','POST',{block_id:created.data.block.id,checkout_token:tokens[i]})));assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
 const winner=results.findIndex(x=>x.status===201),c=[a,b][winner],id=results[winner].data.booking.id;
 assert.equal((await c.request('/api/bookings','POST',{block_id:created.data.block.id,checkout_token:tokens[winner]})).data.booking.id,id);
 assert.equal((await c.request('/api/bookings/'+id+'/pay','POST',{result:'declined'})).data.booking.status,'failed');
 assert.equal((await pt.request('/api/blocks','POST',classData(),{origin:'https://other.example'})).status,403);
 assert.equal((await pt.request('/api/pt/stripe/connect','POST',{})).status,503);
});

test('old demo databases and missing owner setup fail safely; storage failures do not acknowledge writes',async()=>{
 const old=process.env.DATA_NAMESPACE;
 process.env.DATA_NAMESPACE='public-empty-unconfigured';const password=process.env.ADMIN_PASSWORD;delete process.env.ADMIN_PASSWORD;
 assert.equal((await client().request('/api/me')).status,503);process.env.ADMIN_PASSWORD=password;
 // Deliberately put a legacy fixture account into a separate namespace; the public wrapper must reject it.
 await withSnapshot(pool,'legacy-demo',async filename=>{const sqlite=connect(filename);require('../app/db.cjs').seed(sqlite,true);sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');sqlite.close();return new Response('fixture');});
 process.env.DATA_NAMESPACE='legacy-demo';const response=await client().request('/api/me');assert.equal(response.status,503);assert.match(response.data.error,/demo accounts/);process.env.DATA_NAMESPACE=old;
 const before=await pool.query('SELECT snapshot FROM fitspace_preview_state WHERE namespace=$1',[old]);await assert.rejects(withSnapshot(pool,old,async()=>{throw new Error('fixture failure');}));const after=await pool.query('SELECT snapshot FROM fitspace_preview_state WHERE namespace=$1',[old]);assert.deepEqual(after.rows[0].snapshot,before.rows[0].snapshot);
});


test('custom nine-week block with seven participants cannot oversell; lowering below occupied places is rejected',async()=>{
 const details=classData({title:'Nine weeks, seven participants',capacity:7,sessions:Array.from({length:9},(_,i)=>({starts_at:future(10+i*7),duration_minutes:60}))});
 const created=await pt.request('/api/blocks','POST',details);assert.equal(created.status,201);const id=created.data.block.id;assert.equal(created.data.block.sessions.length,9);assert.equal(created.data.block.capacity,7);
 const people=Array.from({length:10},()=>client());for(let i=0;i<people.length;i++)await people[i].signup('capacity-'+i+'@example.com');
 const results=await Promise.all(people.map(c=>c.request('/api/bookings','POST',{block_id:id,checkout_token:crypto.randomUUID()})));assert.equal(results.filter(r=>r.status===201).length,7);assert.equal(results.filter(r=>r.status===409).length,3);
 const get=async()=>(await client().request('/api/public/pts/six-week-club')).data.blocks.find(b=>b.id===id);
 assert.equal((await get()).available,0);assert.equal((await pt.request('/api/blocks/'+id,'PUT',{...details,capacity:6})).status,409);
 const winner=results.findIndex(r=>r.status===201);const paidId=results[winner].data.booking.id;assert.equal((await people[winner].request('/api/bookings/'+paidId+'/pay','POST',{result:'success'})).status,200);
 assert.equal((await pt.request('/api/blocks/'+id,'PUT',{...details,capacity:8})).status,200);assert.equal((await get()).available,1);
 const loser=results.findIndex(r=>r.status===409);assert.equal((await people[loser].request('/api/bookings','POST',{block_id:id,checkout_token:crypto.randomUUID()})).status,201);assert.equal((await get()).available,0);
 await withSnapshot(pool,process.env.DATA_NAMESPACE,async filename=>{const d=connect(filename);d.prepare("UPDATE bookings SET expires_at=? WHERE block_id=? AND status='pending'").run(Date.now()-1,id);d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close();return new Response('fixture');});assert.equal((await get()).available,7);assert.equal((await get()).paid_count,1);
 for(const capacity of [0,101,2.5])assert.equal((await pt.request('/api/blocks','POST',{...details,capacity})).status,400);
});
