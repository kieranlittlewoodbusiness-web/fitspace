import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {databasePool,ensureSchema,withSnapshot} from '../lib/storage.mjs';
const {createHandler}=await import(process.env.FITSPACE_TEST_BUNDLED?'../.netlify/verified-functions/platform/netlify/functions/platform.mjs':'../netlify/functions/platform.mjs');
const require=createRequire(import.meta.url),{connect}=require('../app/db.cjs'),PT=require('../app/pt-stripe.cjs');
const origin='https://direct.example',keyA='rk_test_trainer_a_fixture_only',keyB='rk_test_trainer_b_fixture_only',keyLive='rk_live_trainer_a_fixture_only',keyRotated='rk_test_trainer_a_rotated_fixture',secretA='whsec_trainer_a_fixture_only',secretB='whsec_trainer_b_fixture_only',secretLive='whsec_live_a_fixture_only';
const keys=new Map([[keyA,{id:'acct_direct_a',live:false}],[keyB,{id:'acct_direct_b',live:false}],[keyLive,{id:'acct_direct_live_a',live:true}],[keyRotated,{id:'acct_direct_a',live:false}]]);
let db,server,pool,handler,ptAId,ptBId,accountA,accountB,accountLive,seq=0,loseResponse=false,failCommit=false,commitFailure=false,refundStatus='succeeded',permissionDenied=false;
const sessions=new Map(),events=new Map(),cache=new Map(),calls=[];const realFetch=globalThis.fetch;
function reply(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});}
before(async()=>{
 delete process.env.STRIPE_INTEGRATION;delete process.env.STRIPE_SECRET_KEY;delete process.env.STRIPE_WEBHOOK_SECRET;delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
 process.env.ADMIN_EMAIL='owner@example.com';process.env.ADMIN_PASSWORD='AdminDirectFixture123!';process.env.DATA_NAMESPACE='pt-direct-v8';process.env.PAYMENT_MODE='stripe_test';process.env.APP_URL=origin;
 db=await PGlite.create();server=new PGLiteSocketServer({db,port:0,maxConnections:1});await server.start();pool=databasePool('postgresql://postgres:postgres@'+server.getServerConn()+'/postgres?sslmode=disable');await ensureSchema(pool);
 handler=createHandler({getStorage:()=>({pool:{query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return {query:async(sql,args)=>{if(commitFailure&&String(sql).startsWith('UPDATE fitspace_preview_state SET snapshot')){commitFailure=false;throw new Error('Fixture failure after provider response');}return c.query(sql,args);},release:()=>c.release()};}},ready:Promise.resolve()})});
 globalThis.fetch=async(url,options={})=>{
  const u=new URL(url);assert.equal(u.origin,'https://api.stripe.com');assert.equal(options.headers['Stripe-Account'],undefined,'PT keys must never use Stripe-Account routing');
  const key=options.headers.Authorization?.slice(7),acct=keys.get(key),path=u.pathname,method=options.method;
  const data=Object.fromEntries(new URLSearchParams(options.body));const call={path,method,key,data};calls.push(call);
  if(!acct)return reply({error:{message:'Invalid fixture key'}},401);
  if(permissionDenied)return reply({error:{message:'Forbidden fixture secret_should_not_leak'}},403);
  if(path==='/v1/account')return reply({id:acct.id,charges_enabled:true,payouts_enabled:true});
  if(path.startsWith('/v1/events/')){const event=events.get(decodeURIComponent(path.split('/').at(-1)));if(!event||event.accountId!==acct.id)return reply({error:{message:'No such event'}},404);return reply(event.payload);}
  const idem=options.headers['Idempotency-Key'],cacheKey=acct.id+':'+idem;if(idem&&cache.has(cacheKey)){const prior=cache.get(cacheKey);assert.deepEqual(prior.data,data);return reply(prior.result);}
  let result;
  if(path==='/v1/checkout/sessions'){
   assert.equal(data.mode,'payment');assert.equal(data['payment_method_types[0]'],'card');const id=(acct.live?'cs_live_':'cs_test_')+'direct_'+(++seq);
   result={id,livemode:acct.live,status:'open',url:'https://checkout.stripe.com/c/pay/'+id,mode:'payment',payment_status:'unpaid',payment_intent:'pi_direct_'+seq,amount_total:Number(data['line_items[0][price_data][unit_amount]']),currency:'gbp',metadata:{booking_id:data['metadata[booking_id]'],pt_id:data['metadata[pt_id]']}};sessions.set(id,{result,accountId:acct.id});
  }else if(path.startsWith('/v1/checkout/sessions/')){
   const session=sessions.get(path.split('/')[4]);if(!session||session.accountId!==acct.id)return reply({error:{message:'No such session'}},404);result={...session.result};if(path.endsWith('/expire')){result.status='expired';session.result=result;}
  }else if(path==='/v1/refunds'){
   assert.ok([...sessions.values()].some(s=>s.accountId===acct.id&&s.result.payment_intent===data.payment_intent));result={id:'re_direct_'+(++seq),livemode:acct.live,payment_intent:data.payment_intent,amount:Number(data.amount),currency:'gbp',status:refundStatus};
  }else throw new Error('Unexpected provider path '+path);
  if(idem)cache.set(cacheKey,{data,result:structuredClone(result)});
  if(path==='/v1/checkout/sessions'&&loseResponse){loseResponse=false;throw new Error('Fixture network loss after creation');}
  if(failCommit){failCommit=false;commitFailure=true;}
  return reply(result);
 };
});
after(async()=>{globalThis.fetch=realFetch;await pool?.end();await server?.stop();await db?.close();});
let nextIp=0;
function client(){let cookie='',csrf='';const ip='198.18.0.'+(++nextIp);return {async request(path,method='GET',body,extra={}){const r=await handler(new Request(origin+path,{method,headers:{...(cookie?{cookie}:{}),...(method==='GET'?{}:{origin,'Content-Type':'application/json','X-CSRF-Token':csrf}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})}),{ip});const c=r.headers.get('set-cookie');if(c)cookie=c.split(';')[0];const data=await r.json();if(data.csrf)csrf=data.csrf;return {status:r.status,data};},async login(email,password){const r=await this.request('/api/auth/login','POST',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return r;},async signup(email){const r=await this.request('/api/auth/signup','POST',{email,name:'Direct Test Customer',password:'CustomerDirectFixture123!',demo_acknowledged:true});assert.equal(r.status,201);return r;}};}
const admin=client(),ptA=client(),ptB=client(),customer=client(),other=client();
async function inspect(fn){let result;await withSnapshot(pool,process.env.DATA_NAMESPACE,async file=>{const d=connect(file);try{result=fn(d);}finally{d.exec('PRAGMA wal_checkpoint(TRUNCATE)');d.close();}return new Response('fixture');});return result;}
async function createPt(c,slug,email){const r=await admin.request('/api/admin/pts','POST',{owner_name:slug+' Trainer',email,slug,brand_name:slug.toUpperCase(),tagline:'Train with purpose and confidence.',description:'Small groups with personalised fitness coaching.',about:'Consistent training and progress at your pace.',accent:'#ffd43b',background:'#ffffff',foreground:'#111111',features:['Coached training'],published:true});assert.equal(r.status,201);await c.login(email,r.data.temporary_password);assert.equal((await c.request('/api/auth/password','POST',{current_password:r.data.temporary_password,new_password:'TrainerDirectFixture123!'})).status,200);return r.data.pt_id;}
async function setup(c,key,wh,mode='stripe_test'){const r=await c.request('/api/pt/stripe/credentials','POST',{mode,api_key:key,webhook_secret:wh});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.accounts.find(a=>a.mode===mode);}
async function block(c=ptA,capacity=2,price=12345){const r=await c.request('/api/blocks','POST',{title:'Direct strength '+crypto.randomUUID().slice(0,6),description:'Coached training for your next step.',venue:'Direct Studio',price_pence:price,capacity,published:true,sessions:[{starts_at:new Date(Date.now()+20*86400000).toISOString().slice(0,10)+'T18:30',duration_minutes:60}]});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.block.id;}
async function reserve(id,c=customer,token=crypto.randomUUID()){return c.request('/api/bookings','POST',{block_id:id,checkout_token:token,price_pence:1});}
function session(r){return sessions.get(r.data.url?.split('/').at(-1))?.result;}
function event(type,obj,accountId='acct_direct_a',live=false){const payload={id:'evt_direct_'+crypto.randomUUID(),type,created:Math.floor(Date.now()/1000),livemode:live,data:{object:structuredClone(obj)}};events.set(payload.id,{accountId,payload:structuredClone(payload)});return payload;}
async function webhook(account,secret,e,good=true){const raw=JSON.stringify(e),t=Math.floor(Date.now()/1000),sig=crypto.createHmac('sha256',secret).update(t+'.'+raw).digest('hex');const response=await handler(new Request(account.webhook_url,{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':`t=${t},v1=${good?sig:'bad'}`},body:raw}),{ip:'198.18.1.1'});return {status:response.status,data:await response.json()};}
async function booking(id,c=customer){return (await c.request('/api/bookings/'+id)).data.booking;}
async function pay(s,account=accountA,secret=secretA,acct='acct_direct_a',live=false){const paid={...s,status:'complete',payment_status:'paid'};sessions.get(s.id).result=paid;const e=event('checkout.session.completed',paid,acct,live);const r=await webhook(account,secret,e);assert.equal(r.status,200,JSON.stringify(r.data));return e;}

test('no owner Stripe account is needed; secure setup rejects missing encryption, unrestricted/mismatched keys and unauthorized callers',async()=>{
 await admin.login('owner@example.com','AdminDirectFixture123!');ptAId=await createPt(ptA,'trainer-a','a@example.com');ptBId=await createPt(ptB,'trainer-b','b@example.com');await customer.signup('customer@example.com');await other.signup('other@example.com');
 assert.equal((await ptA.request('/api/pt/stripe/setup')).data.encryption_ready,false);
 assert.equal((await ptA.request('/api/pt/stripe/credentials','POST',{mode:'stripe_test',api_key:keyA})).status,503);assert.equal(calls.length,0);
 process.env.CREDENTIAL_ENCRYPTION_KEY='a'.repeat(64);
 assert.equal((await customer.request('/api/pt/stripe/credentials','POST',{mode:'stripe_test',api_key:keyA})).status,403);assert.equal((await admin.request('/api/pt/stripe/credentials','POST',{})).status,403);
 for(const api_key of ['sk_test_unrestricted_fixture','rk_live_wrong_mode_fixture'])assert.equal((await ptA.request('/api/pt/stripe/credentials','POST',{mode:'stripe_test',api_key})).status,400);
 assert.equal((await ptA.request('/api/pt/stripe/credentials','POST',{mode:'stripe_test',api_key:keyA},{origin:'https://attacker.example'})).status,403);
 accountA=await setup(ptA,keyA,secretA);accountB=await setup(ptB,keyB,secretB);assert.notEqual(accountA.id,accountB.id);assert.equal(accountA.enabled,false);
 const row=await inspect(d=>d.prepare('SELECT * FROM pt_stripe_credentials WHERE id=?').get(accountA.id));assert.ok(row.api_cipher);assert.ok(!JSON.stringify(row).includes(keyA));assert.equal(PT.open(row.api_cipher,row,'api'),keyA);assert.throws(()=>PT.open(row.api_cipher,{...row,pt_id:ptBId},'api'));
 for(const response of [await ptA.request('/api/pt/stripe/setup'),await admin.request('/api/admin/stripe/setup'),await admin.request('/api/dashboard'),await customer.request('/api/me')]){assert.ok(!JSON.stringify(response.data).includes(keyA));assert.ok(!JSON.stringify(response.data).includes(secretA));assert.ok(!JSON.stringify(response.data).includes('api_cipher'));}
 // An old owner key is ignored by the direct integration.
 process.env.STRIPE_SECRET_KEY='sk_live_unused_owner_fixture';assert.equal((await customer.request('/api/me')).status,200);
 assert.equal((await admin.request('/api/admin/stripe/link','POST',{pt_id:ptAId})).status,403);
});

test('PTs enable their sandbox accounts and checkout charges exactly the saved price using that PT key',async()=>{
 for(const c of [ptA,ptB])assert.equal((await c.request('/api/pt/stripe/enable','POST',{mode:'stripe_test'})).status,200);
 const id=await block(),r=await reserve(id);assert.equal(r.status,200,JSON.stringify(r.data));const s=session(r);assert.equal(s.amount_total,12345);assert.equal(calls.at(-1).key,keyA);assert.equal((await booking(s.metadata.booking_id)).status,'pending');
 assert.equal((await customer.request('/api/bookings/'+s.metadata.booking_id+'/pay','POST',{result:'success'})).status,403);
 const rb=await reserve(await block(ptB),other);assert.equal(rb.status,200);assert.equal(calls.at(-1).key,keyB);
 const job=await inspect(d=>d.prepare('SELECT payload FROM stripe_jobs WHERE id=?').get('checkout:'+s.metadata.booking_id));assert.ok(!job.payload.includes(keyA));assert.ok(job.payload.includes(accountA.id));
});

test('webhooks require the PT secret, account-owned event lookup and correct booking binding; duplicates cannot reconfirm',async()=>{
 const r=await reserve(await block()),s=session(r),bid=s.metadata.booking_id,e=event('checkout.session.completed',{...s,payment_status:'paid'});
 assert.equal((await webhook(accountA,secretA,e,false)).status,400);
 assert.equal((await webhook(accountA,secretB,e)).status,400);
 assert.equal((await webhook(accountB,secretB,e)).status,409,'event cannot be fetched from another account');
 const bEvent=event('checkout.session.completed',{...s,payment_status:'paid'},'acct_direct_b');assert.equal((await webhook(accountB,secretB,bEvent)).status,400,'B cannot confirm an A booking');
 const wrongAmount=event('checkout.session.completed',{...s,payment_status:'paid',amount_total:1});assert.equal((await webhook(accountA,secretA,wrongAmount)).status,400);
 assert.equal((await webhook(accountA,secretA,{...e,livemode:true})).status,403);
 assert.equal((await booking(bid)).status,'pending');const paid=await pay(s);assert.equal((await booking(bid)).status,'paid');assert.equal((await webhook(accountA,secretA,paid)).data.duplicate,true);
 assert.equal(await inspect(d=>d.prepare('SELECT count(*) n FROM email_outbox WHERE dedupe_key=?').get('confirmation:'+bid).n),1);
 const state=(await ptA.request('/api/pt/stripe/setup')).data;assert.ok(state.accounts[0].webhook_seen_at);
 // Signed body data is never trusted over the account-owned API event.
 const forged=event('checkout.session.expired',s);const body={...forged,data:{object:{...forged.data.object,amount_total:1}}};assert.equal((await webhook(accountA,secretA,body)).status,200);assert.equal((await booking(bid)).status,'paid');
});

test('refunds stay in the original PT account, reconcile partial amounts and release only a fully refunded place',async()=>{
 const r=await reserve(await block()),s=session(r),bid=s.metadata.booking_id;await pay(s);
 assert.equal((await ptB.request('/api/bookings/'+bid+'/refund','POST',{request_token:crypto.randomUUID()})).status,404);
 const partial={id:'re_external_direct',payment_intent:s.payment_intent,amount:2345,currency:'gbp',status:'succeeded'};assert.equal((await webhook(accountA,secretA,event('refund.updated',partial))).status,200);assert.equal((await booking(bid)).refunded_pence,2345);assert.equal((await booking(bid)).status,'paid');
 const full=await ptA.request('/api/bookings/'+bid+'/refund','POST',{request_token:crypto.randomUUID()});assert.equal(full.status,200,JSON.stringify(full.data));assert.equal(calls.at(-1).key,keyA);assert.equal(calls.at(-1).data.amount,'10000');assert.equal((await booking(bid)).status,'cancelled');assert.equal((await ptA.request('/api/pt/stripe/setup')).data.sandbox_passed,true);
});

test('lost provider responses and failed database commits replay one checkout without storing keys in operations',async()=>{
 const id=await block(),token=crypto.randomUUID();loseResponse=true;const first=await reserve(id,customer,token);assert.equal(first.status,503);const before=sessions.size;const retry=await reserve(id,customer,token);assert.equal(retry.status,200);assert.equal(sessions.size,before);
 const id2=await block(),token2=crypto.randomUUID();failCommit=true;assert.equal((await reserve(id2,customer,token2)).status,503);const n=sessions.size;assert.equal((await reserve(id2,customer,token2)).status,200);assert.equal(sessions.size,n);
 const serialized=await inspect(d=>JSON.stringify(d.prepare('SELECT * FROM stripe_jobs').all()));assert.ok(!serialized.includes(keyA));assert.ok(!serialized.includes(secretA));
});

test('cancellation, card failures, expiry and late payment retain the existing capacity rules with PT-owned keys',async()=>{
 const r=await reserve(await block()),s=session(r),bid=s.metadata.booking_id;
 assert.equal((await webhook(accountA,secretA,event('payment_intent.payment_failed',{id:s.payment_intent,amount:s.amount_total,currency:'gbp',metadata:s.metadata}))).status,200);assert.equal((await booking(bid)).status,'pending');
 assert.equal((await customer.request('/api/bookings/'+bid+'/cancel','POST',{})).status,200);assert.equal(calls.at(-1).key,keyA);assert.equal((await booking(bid)).status,'cancelled');
 const r2=await reserve(await block()),s2=session(r2);await inspect(d=>d.prepare('UPDATE bookings SET expires_at=? WHERE id=?').run(Date.now()-1,s2.metadata.booking_id));await booking(s2.metadata.booking_id);
 process.env.PAYMENT_MODE='demo';await pay(s2);assert.equal((await booking(s2.metadata.booking_id)).status,'review','original-mode signed success is handled after deployment mode changes');process.env.PAYMENT_MODE='stripe_test';
});

test('credential replacement, pause and removal cannot switch payment accounts or expose another PT credentials',async()=>{
 assert.equal((await ptB.request('/api/pt/stripe/credentials','POST',{mode:'stripe_test',api_key:keyA})).status,409);
 const rotate=await ptA.request('/api/pt/stripe/credentials','POST',{mode:'stripe_test',api_key:keyRotated});assert.equal(rotate.status,200);assert.equal(rotate.data.accounts.find(a=>a.mode==='stripe_test').enabled,false);
 assert.equal((await reserve(await block())).status,409);assert.equal((await ptA.request('/api/pt/stripe/enable','POST',{mode:'stripe_test'})).status,200);
 const r=await reserve(await block()),s=session(r);assert.equal(calls.at(-1).key,keyRotated);await pay(s);
 assert.equal((await ptA.request('/api/pt/stripe/disconnect','POST',{mode:'stripe_test'})).status,200);assert.equal((await reserve(await block())).status,409);
 assert.equal((await ptA.request('/api/bookings/'+s.metadata.booking_id+'/refund','POST',{request_token:crypto.randomUUID()})).status,200,'paused credentials still reconcile original payments');assert.equal(calls.at(-1).key,keyRotated);
 assert.equal((await ptA.request('/api/pt/stripe/credentials','POST',{mode:'stripe_test',api_key:keyB})).status,409);
 assert.equal((await ptA.request('/api/pt/stripe/disconnect','POST',{mode:'stripe_test',erase:true,confirm_account:'acct_wrong'})).status,400);
 assert.equal((await ptA.request('/api/pt/stripe/disconnect','POST',{mode:'stripe_test',erase:true,confirm_account:'acct_direct_a'})).status,409,'outstanding pending checkouts prevent erasure');
 const before=calls.length;process.env.CREDENTIAL_ENCRYPTION_KEY='b'.repeat(64);assert.equal((await ptA.request('/api/pt/stripe/check','POST',{mode:'stripe_test'})).status,503);assert.equal(calls.length,before);process.env.CREDENTIAL_ENCRYPTION_KEY='a'.repeat(64);
});

test('live enablement requires this PT sandbox payment/refund and acknowledgement; live checkouts and refunds use only live PT keys',async()=>{
 accountLive=await setup(ptA,keyLive,secretLive,'stripe_live');assert.equal((await ptA.request('/api/pt/stripe/enable','POST',{mode:'stripe_live'})).status,409);assert.equal((await ptA.request('/api/pt/stripe/enable','POST',{mode:'stripe_live',live_ack:true})).status,200);
 process.env.PAYMENT_MODE='stripe_live';const r=await reserve(await block(ptA,2,7654)),s=session(r);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(s.amount_total,7654);assert.equal(calls.at(-1).key,keyLive);assert.equal((await booking(s.metadata.booking_id)).mode,'stripe_live');
 assert.equal((await webhook(accountLive,secretA,event('checkout.session.completed',{...s,payment_status:'paid'},'acct_direct_live_a',true))).status,400);
 await pay(s,accountLive,secretLive,'acct_direct_live_a',true);assert.equal((await booking(s.metadata.booking_id)).status,'paid');const refund=await ptA.request('/api/bookings/'+s.metadata.booking_id+'/refund','POST',{request_token:crypto.randomUUID()});assert.equal(refund.status,200);assert.equal(calls.at(-1).key,keyLive);assert.equal((await booking(s.metadata.booking_id)).status,'cancelled');
 process.env.PAYMENT_MODE='stripe_test';await inspect(d=>d.prepare("UPDATE bookings SET status='expired' WHERE stripe_credential_id=? AND status='pending'").run(accountA.id));
 assert.equal((await ptA.request('/api/pt/stripe/disconnect','POST',{mode:'stripe_test',erase:true,confirm_account:'acct_direct_a'})).status,200);assert.equal(await inspect(d=>d.prepare('SELECT api_cipher FROM pt_stripe_credentials WHERE id=?').get(accountA.id).api_cipher),null);assert.equal((await reserve(await block())).status,409);
});
