import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {databasePool,ensureSchema,withSnapshot} from '../lib/storage.mjs';
const {createHandler}=await import(process.env.FITSPACE_TEST_BUNDLED?'../.netlify/verified-functions/platform/netlify/functions/platform.mjs':'../netlify/functions/platform.mjs');
const require=createRequire(import.meta.url),{connect}=require('../app/db.cjs');
const origin='https://sandbox.example',secret='whsec_public_test_fixture_only';
let db,server,pool,handler,ptId,customerId,accountId='acct_sandbox_fixture',sequence=0,ready=false,loseCheckoutResponse=false,refundState='succeeded',failCommitAfterProvider=false,injectCommitFailure=false;
const sessions=new Map(),refunds=new Map(),cache=new Map(),calls=[];
const realFetch=globalThis.fetch;
function reply(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});}
function count(path){return calls.filter(c=>c.path===path&&c.created).length;}
before(async()=>{
 process.env.ADMIN_EMAIL='owner@example.com';process.env.ADMIN_PASSWORD='AdminSandboxFixture123!';process.env.DATA_NAMESPACE='stripe-sandbox-test';process.env.PAYMENT_MODE='stripe_test';process.env.STRIPE_SECRET_KEY='sk_test_fixture_only';process.env.STRIPE_WEBHOOK_SECRET=secret;process.env.APP_URL=origin;
 db=await PGlite.create();server=new PGLiteSocketServer({db,port:0,maxConnections:1});await server.start();pool=databasePool('postgresql://postgres:postgres@'+server.getServerConn()+'/postgres?sslmode=disable');await ensureSchema(pool);
 const getStorage=()=>({pool:{query:pool.query.bind(pool),connect:async()=>{const c=await pool.connect();return {query:async(sql,args)=>{if(injectCommitFailure&&String(sql).startsWith('UPDATE fitspace_preview_state SET snapshot')){injectCommitFailure=false;throw new Error('Fixture commit failure after Stripe response');}return c.query(sql,args);},release:()=>c.release()};}},ready:Promise.resolve()});
 handler=createHandler({getStorage});
 globalThis.fetch=async(url,options={})=>{
  const parsed=new URL(url);assert.equal(parsed.origin,'https://api.stripe.com');assert.equal(options.headers.Authorization,'Bearer '+process.env.STRIPE_SECRET_KEY);
  const path=parsed.pathname,key=options.headers['Idempotency-Key'],account=options.headers['Stripe-Account'],method=options.method||'GET';
  const params=options.headers['Content-Type']==='application/json'?JSON.parse(options.body):Object.fromEntries(new URLSearchParams(options.body));
  const call={path,key,account,method,params,created:false};calls.push(call);
  const cacheKey=key&&account+':'+key;
  if(cacheKey&&cache.has(cacheKey)){assert.deepEqual(cache.get(cacheKey).params,params,'idempotent request parameters changed');return reply(cache.get(cacheKey).result);}
  const live=process.env.PAYMENT_MODE==='stripe_live';let result;
  if(path==='/v1/account')result={id:'acct_owner_fixture',email:'owner@example.com',business_profile:{name:'Owner Training'},charges_enabled:true,payouts_enabled:true,details_submitted:true};
  else if(path==='/v2/core/accounts'&&method==='POST')result={id:accountId,livemode:process.env.PAYMENT_MODE==='stripe_live'};
  else if(path==='/v2/core/account_links')result={url:'https://connect.stripe.com/setup/sandbox-fixture'};
  else if(path==='/v2/core/accounts/'+accountId)result={id:accountId,livemode:process.env.PAYMENT_MODE==='stripe_live',configuration:{merchant:{capabilities:{card_payments:{status:ready?'active':'pending'}}}}};
  else if(path==='/v1/checkout/sessions'){
   assert.equal(account,process.env.FIXTURE_PLATFORM==='yes'?undefined:accountId);assert.equal(params.mode,'payment');assert.equal(params['payment_method_types[0]'],'card');assert.ok(Number(params.expires_at)*1000>Date.now()+30*60000);
   const id=(live?'cs_live_':'cs_test_')+(++sequence);result={id,livemode:process.env.PAYMENT_MODE==='stripe_live',url:'https://checkout.stripe.com/c/pay/'+id,status:'open',mode:'payment',payment_status:'unpaid',payment_intent:'pi_test_'+sequence,amount_total:Number(params['line_items[0][price_data][unit_amount]']),currency:'gbp',metadata:{booking_id:params['metadata[booking_id]'],pt_id:params['metadata[pt_id]']}};sessions.set(id,result);
  }else if(path.startsWith('/v1/checkout/sessions/')){
   assert.equal(account,accountId);const id=path.split('/')[4];result=sessions.get(id);assert.ok(result);
   if(path.endsWith('/expire')){if(result.status!=='open')return reply({error:{message:'Session is not open'}},400);result={...result,status:'expired'};sessions.set(id,result);}
  }else if(path==='/v1/refunds'){
   assert.equal(account,process.env.FIXTURE_PLATFORM==='yes'?undefined:accountId);assert.match(params.payment_intent,/^pi_test_/);result={id:'re_test_'+(++sequence),payment_intent:params.payment_intent,amount:Number(params.amount),currency:'gbp',status:refundState};refunds.set(result.id,result);
  }else throw new Error('Unexpected Stripe path '+path);
  call.created=true;
  if(cacheKey)cache.set(cacheKey,{params,result:structuredClone(result)});
  if(path==='/v1/checkout/sessions'&&loseCheckoutResponse){loseCheckoutResponse=false;throw new Error('Fixture network disconnect after provider created checkout');}
  if(failCommitAfterProvider){failCommitAfterProvider=false;injectCommitFailure=true;}
  return reply(result);
 };
});
after(async()=>{globalThis.fetch=realFetch;await pool?.end();await server?.stop();await db?.close();});
let ip=0;
function client(){let cookie='',csrf='';const address='192.0.2.'+(++ip);return {
 async request(path,method='GET',data,extra={}){const response=await handler(new Request(origin+path,{method,headers:{...(cookie?{cookie}:{}),...(!['GET','HEAD'].includes(method)?{origin,'content-type':'application/json',...(csrf?{'x-csrf-token':csrf}:{})}:{}),...extra},...(data===undefined?{}:{body:JSON.stringify(data)})}),{ip:address});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];const result=(response.headers.get('content-type')||'').includes('json')?await response.json():await response.text();if(result.csrf)csrf=result.csrf;return {status:response.status,data:result};},
 async login(email,password){const r=await this.request('/api/auth/login','POST',{email,password});assert.equal(r.status,200,JSON.stringify(r.data));return r;},
 async signup(email){const r=await this.request('/api/auth/signup','POST',{name:'Test Customer',email,password:'CustomerSandboxFixture123!',demo_acknowledged:true});assert.equal(r.status,201,JSON.stringify(r.data));return r;}
};}
const admin=client(),pt=client(),customer=client();
const future=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10)+'T18:30';
async function block(capacity=1){const r=await pt.request('/api/blocks','POST',{title:'Sandbox strength block '+crypto.randomUUID().slice(0,6),description:'Coached weekly strength sessions.',venue:'Sandbox Studio',capacity,price_pence:9000,published:true,sessions:[{starts_at:future(20),duration_minutes:60}]});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.block.id;}
async function reserve(blockId,token=crypto.randomUUID()){const r=await customer.request('/api/bookings','POST',{block_id:blockId,checkout_token:token,price_pence:1});return {...r,token,session:r.data.url?.startsWith('https://checkout.stripe.com/')?sessions.get(r.data.url.split('/').at(-1)):null};}
function event(type,obj,extra={}){return {id:'evt_'+crypto.randomUUID(),created:Math.floor(Date.now()/1000),livemode:process.env.PAYMENT_MODE==='stripe_live',account:accountId,type,data:{object:structuredClone(obj)},...extra};}
async function webhook(evt,signature=true){const raw=JSON.stringify(evt),stamp=Math.floor(Date.now()/1000),hash=crypto.createHmac('sha256',secret).update(stamp+'.'+raw).digest('hex');const response=await handler(new Request(origin+'/api/stripe/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':`t=${stamp},v1=${signature?hash:'bad'}`},body:raw}),{ip:'192.0.2.250'});return {status:response.status,data:await response.json()};}
async function inspect(fn){let result;await withSnapshot(pool,process.env.DATA_NAMESPACE,async path=>{const sqlite=connect(path);try{result=fn(sqlite);}finally{sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');sqlite.close();}return new Response('test');});return result;}
async function pay(session){session.status='complete';session.payment_status='paid';const e=event('checkout.session.completed',session);const r=await webhook(e);assert.equal(r.status,200,JSON.stringify(r.data));return e;}
async function booking(id){return (await customer.request('/api/bookings/'+id)).data.booking;}

test('sandbox onboarding persists account, returns a Stripe link and verifies capabilities',async()=>{
 await admin.login('owner@example.com','AdminSandboxFixture123!');const created=await admin.request('/api/admin/pts','POST',{owner_name:'Sandbox Trainer',email:'trainer@example.com',brand_name:'STRENGTH CLUB',slug:'strength-club',tagline:'Get stronger, one session at a time.',description:'Small supportive groups and personal coaching.',about:'Build confidence through consistent movement.',accent:'#ffd43b',background:'#ffffff',foreground:'#111111',features:['Small groups'],published:true});assert.equal(created.status,201);ptId=created.data.pt_id;
 await pt.login(created.data.email,created.data.temporary_password);assert.equal((await pt.request('/api/auth/password','POST',{current_password:created.data.temporary_password,new_password:'TrainerSandboxFixture123!'})).status,200);
 const connected=await pt.request('/api/pt/stripe/connect','POST',{});assert.equal(connected.status,200,JSON.stringify(connected.data));assert.match(connected.data.url,/^https:\/\/connect.stripe.com/);assert.equal(count('/v2/core/accounts'),1);
 assert.equal((await pt.request('/api/pt/stripe/status','POST',{})).data.ready,false);ready=true;assert.equal((await pt.request('/api/pt/stripe/status','POST',{})).data.ready,true);
 const dashboard=(await pt.request('/api/dashboard')).data;assert.equal(dashboard.pt.stripe_connected,true);assert.equal(dashboard.pt.stripe_ready,true);
 const user=await customer.signup('customer@example.com');customerId=user.data.user.id;
 assert.equal((await customer.request('/api/pt/stripe/connect','POST',{})).status,403);
});

test('checkout uses server price and stays pending until a valid, matching, signed success notification',async()=>{
 const id=await block(),r=await reserve(id);assert.equal(r.status,200,JSON.stringify(r.data));const s=r.session;assert.ok(s);assert.equal(s.amount_total,9000);assert.equal((await booking(s.metadata.booking_id)).status,'pending');
 assert.equal((await customer.request('/api/bookings/'+s.metadata.booking_id+'/pay','POST',{result:'success'})).status,403);
 assert.equal((await customer.request('/booking/'+s.metadata.booking_id+'?stripe=return')).status,200);assert.equal((await booking(s.metadata.booking_id)).status,'pending');
 assert.equal((await webhook(event('checkout.session.completed',{...s,payment_status:'paid'}),false)).status,400);
 assert.equal((await webhook(event('checkout.session.completed',{...s,payment_status:'paid',amount_total:1}))).status,400);
 assert.equal((await webhook(event('checkout.session.completed',{...s,payment_status:'paid'},{account:'acct_wrong'}))).status,400);
 assert.equal((await webhook(event('checkout.session.completed',{...s,payment_status:'paid'},{livemode:true}))).status,403);
 const e=await pay(s);assert.equal((await booking(s.metadata.booking_id)).status,'paid');assert.equal((await webhook(e)).data.duplicate,true);
 assert.equal(await inspect(d=>d.prepare("SELECT count(*) n FROM email_outbox WHERE dedupe_key=?").get('confirmation:'+s.metadata.booking_id).n),1);
 assert.equal((await webhook(event('checkout.session.expired',s))).status,200);assert.equal((await booking(s.metadata.booking_id)).status,'paid');
});

test('lost checkout responses and failed persistence recover one provider session with its original operation key',async()=>{
 const id=await block(),token=crypto.randomUUID(),before=count('/v1/checkout/sessions');loseCheckoutResponse=true;
 const first=await reserve(id,token);assert.equal(first.status,503);const pending=await inspect(d=>d.prepare('SELECT * FROM bookings WHERE checkout_token=?').get(token));assert.equal(pending.status,'pending');assert.equal(await inspect(d=>d.prepare('SELECT status FROM stripe_jobs WHERE id=?').get('checkout:'+pending.id).status),'retry');
 const retry=await reserve(id,token);assert.equal(retry.status,200);assert.equal(count('/v1/checkout/sessions'),before+1);assert.equal(retry.session.metadata.booking_id,pending.id);
 const secondId=await block(),secondToken=crypto.randomUUID();failCommitAfterProvider=true;const failedCommit=await reserve(secondId,secondToken);assert.equal(failedCommit.status,503);
 const prepared=await inspect(d=>d.prepare('SELECT * FROM bookings WHERE checkout_token=?').get(secondToken));assert.equal(prepared.checkout_session,null);
 const remote=[...sessions.values()].find(s=>s.metadata.booking_id===prepared.id);await pay(remote);assert.equal((await booking(prepared.id)).status,'paid');
 const recovered=await reserve(secondId,secondToken);assert.equal(recovered.status,201);assert.equal(recovered.data.booking.id,prepared.id);
});

test('expired and terminally failed checkouts release capacity; a retryable card decline does not confirm or release it',async()=>{
 const id=await block(),r=await reserve(id),s=r.session;
 const failedAttempt=event('payment_intent.payment_failed',{id:s.payment_intent,metadata:s.metadata,amount:9000,currency:'gbp',livemode:process.env.PAYMENT_MODE==='stripe_live'});assert.equal((await webhook(failedAttempt)).status,200);assert.equal((await booking(s.metadata.booking_id)).status,'pending');assert.match((await booking(s.metadata.booking_id)).payment_error,/card payment failed/);
 assert.equal((await webhook(event('checkout.session.async_payment_failed',s))).status,200);assert.equal((await booking(s.metadata.booking_id)).status,'failed');
 const again=await reserve(id);assert.equal(again.status,200);assert.equal((await webhook(event('checkout.session.expired',again.session))).status,200);assert.equal((await booking(again.session.metadata.booking_id)).status,'expired');
 const cancel=await reserve(id);assert.equal((await customer.request('/api/bookings/'+cancel.session.metadata.booking_id+'/cancel','POST',{})).status,200);assert.equal(sessions.get(cancel.session.id).status,'expired');assert.equal((await booking(cancel.session.metadata.booking_id)).status,'cancelled');
});

test('only PT/admin can refund; pending and failed refunds preserve the place; success releases it and updates net revenue',async()=>{
 const id=await block(),r=await reserve(id),s=r.session;await pay(s);const bookingId=s.metadata.booking_id;
 assert.equal((await customer.request('/api/bookings/'+bookingId+'/refund','POST',{request_token:crypto.randomUUID()})).status,403);
 refundState='pending';const token=crypto.randomUUID(),before=count('/v1/refunds');const pending=await pt.request('/api/bookings/'+bookingId+'/refund','POST',{request_token:token});assert.equal(pending.status,200,JSON.stringify(pending.data));assert.equal((await booking(bookingId)).status,'paid');assert.equal((await booking(bookingId)).refund_status,'pending');
 assert.equal((await pt.request('/api/bookings/'+bookingId+'/refund','POST',{request_token:crypto.randomUUID()})).status,409);assert.equal(count('/v1/refunds'),before+1);
 const pendingObject=refunds.get(pending.data.refund_id);assert.equal((await webhook(event('refund.failed',{...pendingObject,status:'failed'}))).status,200);assert.equal((await booking(bookingId)).status,'paid');assert.equal((await booking(bookingId)).refund_status,'failed');
 refundState='succeeded';failCommitAfterProvider=true;const retryToken=crypto.randomUUID();assert.equal((await pt.request('/api/bookings/'+bookingId+'/refund','POST',{request_token:retryToken})).status,503);
 const refunded=await pt.request('/api/bookings/'+bookingId+'/refund','POST',{request_token:retryToken});assert.equal(refunded.status,200);assert.equal(count('/v1/refunds'),before+2);assert.equal((await booking(bookingId)).refund_status,'succeeded');assert.equal((await booking(bookingId)).status,'cancelled');assert.equal((await booking(bookingId)).refunded_pence,9000);
 const refund=refunds.get(refunded.data.refund_id);await webhook(event('refund.updated',{...refund,status:'pending'},{created:1}));assert.equal((await booking(bookingId)).refund_status,'succeeded');
 const dashboard=(await pt.request('/api/dashboard')).data;assert.ok(dashboard.stats.refunds_pence>=9000);assert.ok(dashboard.bookings.some(b=>b.id===bookingId&&b.refunded_pence===9000));
 const newBooking=await reserve(id);assert.equal(newBooking.status,200);
});

test('late success needs review rather than overselling; external partial/full refunds reconcile without duplicate totals',async()=>{
 const id=await block(),r=await reserve(id),s=r.session,bookingId=s.metadata.booking_id;
 await inspect(d=>d.prepare('UPDATE bookings SET expires_at=? WHERE id=?').run(Date.now()-1,bookingId));assert.equal((await booking(bookingId)).status,'expired');
 await pay(s);assert.equal((await booking(bookingId)).status,'review');assert.equal(await inspect(d=>d.prepare('SELECT count(*) n FROM email_outbox WHERE dedupe_key=?').get('confirmation:'+bookingId).n),0);
 const partial={id:'re_external_partial',payment_intent:s.payment_intent,amount:3000,currency:'gbp',status:'succeeded'};const notification=event('refund.updated',partial);assert.equal((await webhook(notification)).status,200);assert.equal((await booking(bookingId)).refunded_pence,3000);await webhook(notification);assert.equal((await booking(bookingId)).refunded_pence,3000);
 await webhook(event('charge.refunded',{id:'ch_fixture',payment_intent:s.payment_intent,amount:9000,amount_refunded:3000,currency:'gbp',livemode:process.env.PAYMENT_MODE==='stripe_live'}));assert.equal((await booking(bookingId)).refunded_pence,3000);
 refundState='succeeded';const remaining=await pt.request('/api/bookings/'+bookingId+'/refund','POST',{request_token:crypto.randomUUID()});assert.equal(remaining.status,200);assert.equal(refunds.get(remaining.data.refund_id).amount,6000);assert.equal((await booking(bookingId)).refunded_pence,9000);assert.equal((await booking(bookingId)).status,'cancelled');
});

test('competing Stripe reservations cannot oversell and another trainer cannot refund the winner',async()=>{
 const id=await block(),otherCustomer=client();await otherCustomer.signup('capacity-sandbox@example.com');
 const results=await Promise.all([reserve(id),otherCustomer.request('/api/bookings','POST',{block_id:id,checkout_token:crypto.randomUUID()})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const winner=results.find(r=>r.status===200),session=sessions.get(winner.data.url.split('/').at(-1));await pay(session);
 const created=await admin.request('/api/admin/pts','POST',{owner_name:'Other Trainer',email:'other-trainer@example.com',brand_name:'OTHER CLUB',slug:'other-club',tagline:'Another trainer, separate bookings.',description:'Independent coaching and training classes.',about:'A separate coaching business for access tests.',accent:'#ffd43b',background:'#ffffff',foreground:'#111111',features:['Coaching'],published:true});assert.equal(created.status,201);
 const otherPt=client();await otherPt.login(created.data.email,created.data.temporary_password);await otherPt.request('/api/auth/password','POST',{current_password:created.data.temporary_password,new_password:'OtherTrainerFixture123!'});
 assert.equal((await otherPt.request('/api/bookings/'+session.metadata.booking_id+'/refund','POST',{request_token:crypto.randomUUID()})).status,404);
});

test('invalid modes and mismatched keys are rejected; setup remains accessible without webhook credentials',async()=>{
 const before=calls.length;process.env.PAYMENT_MODE='live';assert.equal((await customer.request('/api/me')).status,503);process.env.PAYMENT_MODE='stripe_test';process.env.STRIPE_SECRET_KEY='sk_live_fixture';assert.equal((await customer.request('/api/me')).status,503);process.env.STRIPE_SECRET_KEY='sk_test_fixture_only';delete process.env.STRIPE_WEBHOOK_SECRET;assert.equal((await customer.request('/api/me')).status,200);process.env.STRIPE_WEBHOOK_SECRET=secret;assert.equal(calls.length,before);
});


test('live connected payments use the PT price and account, preserve test records, and require matching signed live success',async()=>{
 process.env.PAYMENT_MODE='stripe_live';process.env.STRIPE_SECRET_KEY='sk_live_fixture_only';accountId='acct_live_pt_fixture';
 assert.equal((await pt.request('/api/dashboard')).data.pt.stripe_connected,false,'test account must not be reused live');
 const id=await block();assert.equal((await reserve(id)).status,409);
 assert.equal((await pt.request('/api/pt/stripe/connect','POST',{})).status,200);assert.equal((await pt.request('/api/pt/stripe/status','POST',{})).data.ready,true);
 const ownBlock=(await pt.request('/api/dashboard')).data.blocks.find(b=>b.id===id);
 assert.equal((await pt.request('/api/blocks/'+id,'PUT',{...ownBlock,price_pence:12345})).status,200);
 const r=await reserve(id);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.session.amount_total,12345);assert.equal(calls.at(-1).account,accountId);
 const bid=r.session.metadata.booking_id;assert.equal((await booking(bid)).mode,'stripe_live');assert.equal((await booking(bid)).status,'pending');
 // A later class-price edit cannot change an existing checkout's agreed price.
 assert.equal((await pt.request('/api/blocks/'+id,'PUT',{...ownBlock,price_pence:15000})).status,200);
 const again=await customer.request('/api/bookings/'+bid+'/checkout','POST',{});assert.equal(again.status,200);assert.equal(r.session.amount_total,12345);
 assert.equal((await webhook(event('checkout.session.completed',{...r.session,payment_status:'paid'},{livemode:false}))).status,403);
 assert.equal((await webhook(event('checkout.session.completed',{...r.session,payment_status:'paid',amount_total:15000}))).status,400);
 assert.equal((await webhook(event('checkout.session.completed',{...r.session,payment_status:'paid'},{account:'acct_someone_else'}))).status,400);
 const e=await pay(r.session);assert.equal((await booking(bid)).status,'paid');assert.equal((await webhook(e)).data.duplicate,true);
 const body=await inspect(d=>d.prepare('SELECT body FROM email_outbox WHERE dedupe_key=?').get('confirmation:'+bid).body);assert.match(body,/Card payment: £123.45/);assert.doesNotMatch(body,/No real money/);
 assert.ok(await inspect(d=>d.prepare("SELECT count(*) n FROM bookings WHERE mode='stripe_test'").get().n));
 const refund=await pt.request('/api/bookings/'+bid+'/refund','POST',{request_token:crypto.randomUUID()});assert.equal(refund.status,200,JSON.stringify(refund.data));assert.equal(calls.at(-1).params.amount,'12345');assert.equal(calls.at(-1).account,accountId);assert.equal((await booking(bid)).status,'cancelled');
});

test('only admin can link server Stripe account; platform charges/refunds omit connected header and webhook must match routing',async()=>{
 assert.equal((await pt.request('/api/admin/stripe/setup')).status,403);
 assert.equal((await pt.request('/api/admin/stripe/link','POST',{pt_id:ptId})).status,403);
 const status=await admin.request('/api/admin/stripe/setup');assert.equal(status.status,200);assert.equal(status.data.key_ready,true);assert.doesNotMatch(JSON.stringify(status.data),/sk_live_fixture/);
 const check=await admin.request('/api/admin/stripe/check','POST',{});assert.equal(check.status,200);assert.equal(check.data.id,'acct_owner_fixture');
 assert.equal((await admin.request('/api/admin/stripe/link','POST',{pt_id:ptId})).status,200);process.env.FIXTURE_PLATFORM='yes';
 const id=await block(),r=await reserve(id);assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(calls.at(-1).account,undefined);const bid=r.session.metadata.booking_id;
 assert.equal((await webhook(event('checkout.session.completed',{...r.session,payment_status:'paid'}))).status,400);
 r.session.status='complete';r.session.payment_status='paid';assert.equal((await webhook(event('checkout.session.completed',r.session,{account:undefined}))).status,200);assert.equal((await booking(bid)).status,'paid');
 assert.equal((await pt.request('/api/bookings/'+bid+'/refund','POST',{request_token:crypto.randomUUID()})).status,200);assert.equal(calls.at(-1).account,undefined);assert.equal((await booking(bid)).status,'cancelled');
 const old=await inspect(d=>d.prepare("SELECT id FROM bookings WHERE mode='stripe_test' AND status='paid' AND refunded_pence=0 LIMIT 1").get());if(old)assert.equal((await pt.request('/api/bookings/'+old.id+'/refund','POST',{request_token:crypto.randomUUID()})).status,409);
 delete process.env.FIXTURE_PLATFORM;
});
