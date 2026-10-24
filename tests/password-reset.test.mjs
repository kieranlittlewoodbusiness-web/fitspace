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
const sent=[];let providerFails=false;const realFetch=globalThis.fetch;
const base='https://public.example',adminPass='OwnedAdminFixturePassword123!',customerPass='CustomerFixturePassword123!';
const provider=()=>({pool,ready:Promise.resolve()});
before(async()=>{
 process.env.ADMIN_EMAIL='owner@example.com';process.env.ADMIN_PASSWORD=adminPass;
 process.env.DATA_NAMESPACE='reset-test-v7';process.env.PAYMENT_MODE='demo';process.env.RESET_EMAIL_MODE='send';process.env.RESEND_API_KEY='re_fixture_only';process.env.MAIL_FROM='FITSPACE <help@example.com>';process.env.AUTH_RESET_SECRET='fixture_only_not_a_real_reset_secret_123456789';process.env.APP_URL=base;delete process.env.PREVIEW_PASSWORD;
 db=await PGlite.create();server=new PGLiteSocketServer({db,port:0,host:'127.0.0.1',maxConnections:1});await server.start();
 pool=databasePool('postgresql://postgres:postgres@'+server.getServerConn()+'/postgres?sslmode=disable');await ensureSchema(pool);
 handler=createHandler({getStorage:provider});
 globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');assert.equal(options.headers.Authorization,'Bearer re_fixture_only');assert.match(options.headers['Idempotency-Key'],/^fitspace-auth:/);const body=JSON.parse(options.body);sent.push(body);return new Response(JSON.stringify(providerFails?{error:'fixture'}:{id:'mail_fixture_'+sent.length}),{status:providerFails?503:200});};
});
after(async()=>{globalThis.fetch=realFetch;await pool?.end();await server?.stop();await db?.close();});
let ip=0;
function client(){let cookie='',csrf='';const address=`198.51.100.${++ip}`;return {
 async request(path,method='GET',data,headers={}){const response=await handler(new Request(base+path,{method,headers:{...(cookie?{cookie}:{}),...(!['GET','HEAD'].includes(method)?{origin:base,'content-type':'application/json',...(csrf?{'x-csrf-token':csrf}:{})}:{}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})}),{ip:address});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const result=(response.headers.get('content-type')||'').includes('json')?await response.json():await response.text();if(result.csrf)csrf=result.csrf;return {status:response.status,data:result,headers:response.headers};},
 async login(email,password){const r=await this.request('/api/auth/login','POST',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return r;},
 async signup(email){const r=await this.request('/api/auth/signup','POST',{name:'Test Customer',email,password:customerPass,demo_acknowledged:true,role:'admin'});assert.equal(r.status,201,JSON.stringify(r.data));assert.equal(r.data.user.role,'customer');}
};}
const admin=client(),pt=client(),customer=client();
const future=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10)+'T18:30';
const classData=(extra={})=>({title:'Six-week strength block',description:'Supportive coaching and progress every week.',venue:'Training Studio',capacity:15,price_pence:9000,published:true,sessions:Array.from({length:6},(_,i)=>({starts_at:future(7+i*7),duration_minutes:60})),...extra});


async function inspect(fn){let out;await withSnapshot(pool,process.env.DATA_NAMESPACE,async filename=>{const d=connect(filename);try{out=fn(d);}finally{d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close();}return new Response('fixture');});return out;}
function latestToken(address){const email=sent.filter(x=>x.to.includes(address)&&x.subject==='Reset your FITSPACE password').at(-1);assert.ok(email);const link=email.text.match(/https:\/\/[^\s]+\/reset-password#[^\s]+/)[0];assert.ok(link.startsWith(base+'/reset-password#'));return new URL(link).hash.slice(1);}
async function ask(address,c=client()){return c.request('/api/auth/forgot-password','POST',{email:address});}
async function reset(token,password='NewPasswordFixture123!',c=client()){return c.request('/api/auth/reset-password','POST',{token,new_password:password});}

test('customer reset requests use generic responses and send only a private canonical email link',async()=>{
 await customer.signup('client@example.com');await admin.login('owner@example.com',adminPass);
 const before=sent.length,existing=await ask('client@example.com'),missing=await ask('missing@example.com');assert.equal(existing.status,200);assert.deepEqual(existing.data,missing.data);assert.equal(sent.length,before+1);assert.doesNotMatch(JSON.stringify(existing.data),/token|reset_delivery|reset-password#/);
 const token=latestToken('client@example.com');assert.equal(await inspect(d=>d.prepare('SELECT count(*) n FROM email_outbox').get().n),0);assert.doesNotMatch(JSON.stringify((await admin.request('/api/dashboard')).data),new RegExp(token));
 assert.equal((await client().request('/api/auth/forgot-password','POST',{email:'client@example.com'},{origin:'https://attacker.example'})).status,403);
 const stored=await inspect(d=>d.prepare('SELECT * FROM password_resets').get());assert.equal(stored.token_hash,crypto.createHash('sha256').update(token).digest('hex'));assert.doesNotMatch(JSON.stringify(stored),new RegExp(token));
});

test('customer reset is single-use, revokes all sessions and keeps the role; old password stops working',async()=>{
 const second=client();await second.login('client@example.com',customerPass);const token=latestToken('client@example.com');
 assert.equal((await reset(token)).status,200);assert.equal((await customer.request('/api/dashboard')).status,401);assert.equal((await second.request('/api/dashboard')).status,401);
 assert.equal((await client().request('/api/auth/login','POST',{email:'client@example.com',password:customerPass})).status,401);
 const next=client();const login=await next.login('client@example.com','NewPasswordFixture123!');assert.equal(login.data.user.role,'customer');assert.equal((await next.request('/api/admin/pts','POST',{})).status,403);
 assert.equal((await reset(token)).status,400);assert.ok(sent.some(m=>m.to.includes('client@example.com')&&m.subject==='Your FITSPACE password has changed'));
});

test('PT can reset a temporary password without changing role, trainer ownership, prices or bookings',async()=>{
 const result=await admin.request('/api/admin/pts','POST',{owner_name:'Alex Trainer',email:'coach@example.com',brand_name:'RESET TRAINING',slug:'reset-training',tagline:'Train with purpose and confidence.',description:'Supportive fitness sessions for all abilities.',about:'Small groups and personalised training support.',accent:'#ffd43b',background:'#ffffff',foreground:'#111111',features:['Coached training'],published:true});assert.equal(result.status,201);ptId=result.data.pt_id;
 await pt.login(result.data.email,result.data.temporary_password);await ask('coach@example.com');const token=latestToken('coach@example.com');assert.equal((await reset(token,'NewTrainerPassword123!')).status,200);assert.equal((await pt.request('/api/dashboard')).status,401);
 const fresh=client(),login=await fresh.login('coach@example.com','NewTrainerPassword123!');assert.equal(login.data.user.role,'pt');assert.equal(login.data.user.pt_id,ptId);assert.equal(login.data.user.must_change_password,false);
 const block=await fresh.request('/api/blocks','POST',classData({capacity:7}));assert.equal(block.status,201);assert.equal(block.data.block.price_pence,9000);assert.equal(block.data.block.capacity,7);
 assert.equal((await fresh.request('/api/admin/pts','POST',{})).status,403);
});

test('expired, tampered and rotated-secret reset links fail; GET does not consume a valid link',async()=>{
 const c=client();await c.signup('expiry@example.com');await ask('expiry@example.com');const token=latestToken('expiry@example.com');const id=token.split('.')[0];
 assert.equal((await reset(token.slice(0,-1)+(token.endsWith('A')?'B':'A'))).status,400);
 const secret=process.env.AUTH_RESET_SECRET;process.env.AUTH_RESET_SECRET='changed_fixture_secret_1234567890000';assert.equal((await reset(token)).status,400);process.env.AUTH_RESET_SECRET=secret;
 await inspect(d=>d.prepare('UPDATE password_resets SET expires_at=? WHERE id=?').run(Date.now()-1,id));assert.equal((await reset(token)).status,400);
 await ask('expiry@example.com');const valid=latestToken('expiry@example.com');assert.equal((await client().request('/reset-password')).status,200);assert.equal((await reset(valid,'short')).status,400);assert.equal((await reset(valid)).status,200);
});

test('normal password changes invalidate reset links; successful reset invalidates all outstanding links',async()=>{
 const c=client();await c.signup('change@example.com');await ask('change@example.com');const old=latestToken('change@example.com');
 assert.equal((await c.request('/api/auth/password','POST',{current_password:customerPass,new_password:'ChangedPasswordFixture123!'})).status,200);assert.equal((await reset(old)).status,400);
 await ask('change@example.com');const first=latestToken('change@example.com');await ask('change@example.com');const second=latestToken('change@example.com');assert.notEqual(first,second);assert.equal((await reset(second)).status,200);assert.equal((await reset(first)).status,400);
});

test('email failures remain private and account request limits persist; unavailable configuration is explicit',async()=>{
 const c=client();await c.signup('delivery@example.com');providerFails=true;const first=await ask('delivery@example.com');assert.equal(first.status,200);assert.doesNotMatch(JSON.stringify(first.data),/fixture|retry|token|delivery/);assert.equal(await inspect(d=>d.prepare("SELECT count(*) n FROM auth_mail_jobs WHERE status='retry'").get().n),1);providerFails=false;
 await ask('delivery@example.com');await ask('delivery@example.com');const before=sent.length;const limited=await ask('delivery@example.com');assert.deepEqual(limited.data,first.data);assert.equal(sent.length,before);
 process.env.RESET_EMAIL_MODE='off';assert.equal((await c.request('/api/me')).data.password_reset_available,false);assert.equal((await ask('coach@example.com')).status,200);assert.equal(sent.length,before);process.env.RESET_EMAIL_MODE='send';assert.equal((await c.request('/api/me')).data.password_reset_available,true);
});
