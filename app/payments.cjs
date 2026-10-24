'use strict';
const crypto=require('node:crypto');
const SM=require('./stripe-mode.cjs');
const PT=require('./pt-stripe.cjs');
const {uid,tx}=require('./db.cjs');
const {error}=require('./auth.cjs');
const {confirmation}=require('./emails.cjs');
function expire(db){db.prepare("UPDATE bookings SET status='expired' WHERE status='pending' AND expires_at<=?").run(Date.now());}
function available(db,block){expire(db);const used=db.prepare("SELECT count(*) n FROM bookings WHERE block_id=? AND status IN ('paid','pending')").get(block.id).n;return Math.max(0,block.capacity-used);}
function reserve(db,user,blockId,token,mode){if(!/^[a-zA-Z0-9-]{12,80}$/.test(token||''))throw error(400,'Refresh the booking page and try again.');return tx(db,()=>{expire(db);const prior=db.prepare('SELECT * FROM bookings WHERE checkout_token=?').get(token);if(prior){if(prior.customer_id!==user.id||prior.block_id!==blockId)throw error(409,'Booking token already used.');return prior;}const block=db.prepare('SELECT b.*,p.published pt_published FROM blocks b JOIN pts p ON p.id=b.pt_id WHERE b.id=?').get(blockId);const first=db.prepare('SELECT min(starts_epoch) starts FROM class_sessions WHERE block_id=?').get(blockId);if(!block||!block.published||!block.pt_published||block.closed||!first.starts||first.starts<=Date.now())throw error(409,'This class is no longer open for bookings.');if(db.prepare("SELECT id FROM bookings WHERE block_id=? AND customer_id=? AND status IN ('paid','pending')").get(blockId,user.id))throw error(409,'You already have a booking or checkout in progress for this block.');if(!available(db,block))throw error(409,'This block is full. Please choose another class.');if(SM.isStripe(mode)){SM.validate(mode);const c=SM.connection(db,block.pt_id,mode);if(!c?.ready)throw error(409,'This trainer has not finished Stripe setup for this payment mode.');}const id=uid();db.prepare("INSERT INTO bookings(id,block_id,customer_id,reference,status,amount_pence,mode,checkout_token,expires_at,created_at) VALUES(?,?,?,?,'pending',?,?,?,?,?)").run(id,blockId,user.id,'FIT-'+crypto.randomBytes(4).toString('hex').toUpperCase(),block.price_pence,mode,token,Date.now()+(SM.isStripe(mode)?35:31)*60000,Date.now());if(SM.isStripe(mode)){const c=SM.connection(db,block.pt_id,mode);db.prepare('UPDATE bookings SET stripe_account_id=?,stripe_routing=?,stripe_credential_id=? WHERE id=?').run(c.account_id,c.routing,c.credential_id||null,id);}return db.prepare('SELECT * FROM bookings WHERE id=?').get(id);});}
function completeDemo(db,id,user,result){return tx(db,()=>{expire(db);const booking=db.prepare('SELECT * FROM bookings WHERE id=?').get(id);if(!booking||booking.customer_id!==user.id)throw error(404,'Booking not found.');if(booking.mode!=='demo')throw error(403,'This booking must be confirmed by Stripe.');if(booking.status==='paid')return booking;if(booking.status!=='pending')throw error(409,'This checkout is no longer active. Book a new place to try again.');if(result!=='success'){db.prepare("UPDATE bookings SET status='failed' WHERE id=?").run(id);return db.prepare('SELECT * FROM bookings WHERE id=?').get(id);}db.prepare("UPDATE bookings SET status='paid',paid_at=? WHERE id=?").run(Date.now(),id);const paid=db.prepare('SELECT * FROM bookings WHERE id=?').get(id);confirmation(db,paid);return paid;});}

async function stripe(path,data,{account,idempotency,method='POST',v2=false,key:ownKey,mode:expectedMode=SM.mode()}={}){
 const key=ownKey||(!PT.direct()?process.env.STRIPE_SECRET_KEY:null);
 if(!SM.isStripe(expectedMode))throw error(503,'Select sandbox or live Stripe mode.');if(ownKey){if(!PT.keyMatches(ownKey,expectedMode))throw error(503,'Stored Stripe key does not match the payment mode.');if(account)throw error(403,'PT-owned credentials cannot route to another account.');}else{if(PT.direct())throw error(503,'This PT must configure their own Stripe account.');SM.validate(expectedMode);}
 const headers={Authorization:`Bearer ${key}`,'Stripe-Version':process.env.STRIPE_API_VERSION||'2026-09-30.endive'};
 if(account)headers['Stripe-Account']=account;if(idempotency)headers['Idempotency-Key']=idempotency;
 let body;if(method!=='GET'){headers['Content-Type']=v2?'application/json':'application/x-www-form-urlencoded';body=v2?JSON.stringify(data):new URLSearchParams(data).toString();}
 let response,result;
 try{response=await fetch('https://api.stripe.com'+path,{method,headers,body,signal:AbortSignal.timeout(12000)});result=await response.json();}catch{throw Object.assign(error(503,'Stripe did not respond. Retry this action; its payment-operation key is preserved.'),{retryable:true});}
 if(!response.ok){const retryable=response.status>=500||[409,429].includes(response.status);throw Object.assign(error(retryable?503:409,'Stripe could not complete this action. '+(response.status===401?'Check this account’s key.':response.status===403?'Check this key’s permissions.':'Check the Stripe account setup and retry.')),{retryable});}
 if(typeof result.livemode==='boolean'&&result.livemode!==SM.live(expectedMode))throw error(403,'Stripe response payment mode mismatch.');
 return result;
}
function job(db,id,kind,target,actor,payload){db.prepare('INSERT OR IGNORE INTO stripe_jobs(id,kind,target_id,actor_id,payload,created_at) VALUES(?,?,?,?,?,?)').run(id,kind,target,actor,JSON.stringify({mode:SM.mode(),...payload}),Date.now());return id;}
function prepareConnect(db,pt,user,origin){
 if(PT.direct())throw error(409,'Use Payments setup to save your own restricted key and webhook secret.');
 const c=SM.connection(db,pt.id);if(c){if(c.routing==='platform')throw error(409,'The admin has linked the platform Stripe account. Check its status instead.');return prepareOnboard(db,pt.id,user.id,c.account_id,origin);}
 return job(db,'account:'+(SM.live()?'live:':'')+pt.id,'account',pt.id,user.id,{origin,path:'/v2/core/accounts',v2:true,data:{contact_email:user.email,display_name:pt.brand_name,dashboard:'full',identity:{country:'gb'},configuration:{merchant:{capabilities:{card_payments:{requested:true}}}},defaults:{currency:'gbp',responsibilities:{fees_collector:'stripe',losses_collector:'stripe'},locales:['en-GB']},include:['configuration.merchant']}});
}
function prepareOnboard(db,ptId,actor,account,origin){return job(db,'onboard:'+uid(),'onboard',ptId,actor,{path:'/v2/core/account_links',v2:true,data:{account,use_case:{type:'account_onboarding',account_onboarding:{configurations:['merchant'],refresh_url:origin+'/dashboard?tab=payments&connect=refresh',return_url:origin+'/dashboard?tab=payments&connect=return',collection_options:{fields:'eventually_due'}}}}});}
async function merchantAccount(){const a=await stripe('/v1/account',null,{method:'GET'});if(!/^acct_/.test(a.id||''))throw error(409,'Stripe returned an invalid account.');return {id:a.id,name:a.business_profile?.name||a.settings?.dashboard?.display_name||null,email:a.email||null,charges_enabled:Boolean(a.charges_enabled),payouts_enabled:Boolean(a.payouts_enabled),details_submitted:Boolean(a.details_submitted),mode:SM.mode()};}
function setupStatus(db){if(PT.direct())return {integration:'pt_direct',mode:process.env.PAYMENT_MODE||'demo',encryption_ready:PT.configured(),app_url_ready:/^https:\/\/[^/]+\/?$/.test(process.env.APP_URL||''),connections:db.prepare('SELECT id,pt_id,mode,account_id,enabled,charges_ready,webhook_seen_at FROM pt_stripe_credentials').all()};let keyReady=true;try{SM.validate();}catch{keyReady=false;}return {mode:process.env.PAYMENT_MODE||'demo',key_ready:keyReady,webhook_ready:Boolean(process.env.STRIPE_WEBHOOK_SECRET),connect_webhook_ready:Boolean(process.env.STRIPE_CONNECT_WEBHOOK_SECRET),app_url_ready:/^https:\/\/[^/]+\/?$/.test(process.env.APP_URL||''),connections:db.prepare('SELECT c.*,p.brand_name FROM stripe_connections c JOIN pts p ON p.id=c.pt_id').all()};}
function prepareLink(db,ptId,user){if(PT.direct())throw error(403,'Owner account linking is disabled. Each PT must configure their own account.');SM.validate();if(!db.prepare('SELECT id FROM pts WHERE id=?').get(ptId))throw error(404,'Trainer not found.');return job(db,'link:'+uid(),'link_platform',ptId,user.id,{path:'/v1/account',method:'GET'});}
async function syncPt(db,pt){if(PT.direct())return PT.check(db,pt.id,SM.mode(),stripe);const c=SM.connection(db,pt.id);if(!c)return {ready:false};let ready;if(c.routing==='platform'){const result=await merchantAccount();if(result.id!==c.account_id)throw error(409,'The server key belongs to a different Stripe account.');ready=result.charges_enabled;}else{const result=await stripe('/v2/core/accounts/'+encodeURIComponent(c.account_id)+'?include[]=configuration.merchant',null,{method:'GET',v2:true});if(result.id!==c.account_id||result.livemode!==SM.live())throw error(409,'Unexpected Stripe account or payment mode.');ready=result.configuration?.merchant?.capabilities?.card_payments?.status==='active';}SM.bind(db,pt.id,SM.mode(),c.account_id,c.routing,ready);return {ready,account_id:c.account_id,routing:c.routing,mode:SM.mode()};}
function prepareCheckout(db,booking,user,origin){
 expire(db);booking=db.prepare('SELECT * FROM bookings WHERE id=?').get(booking.id);
 if(!booking||(!SM.isStripe(booking.mode)||booking.mode!==SM.mode())||booking.customer_id!==user.id)throw error(404,'Checkout not found.');
 if(booking.status!=='pending')throw error(409,'This checkout is no longer active.');
 const prior=db.prepare('SELECT id FROM stripe_jobs WHERE id=?').get('checkout:'+booking.id);if(prior)return prior.id;
 const block=db.prepare('SELECT * FROM blocks WHERE id=?').get(booking.block_id),pt=db.prepare('SELECT * FROM pts WHERE id=?').get(block.pt_id);
 const c=SM.connection(db,pt.id);if(!c?.ready||booking.stripe_account_id!==c.account_id||booking.stripe_routing!==c.routing||booking.stripe_credential_id!==(c.credential_id||null))throw error(409,'This trainer is not ready for payments in this mode.');
 const params={mode:'payment','payment_method_types[0]':'card','line_items[0][price_data][currency]':'gbp','line_items[0][price_data][unit_amount]':String(booking.amount_pence),'line_items[0][price_data][product_data][name]':block.title,'line_items[0][quantity]':'1',customer_email:user.email,client_reference_id:booking.id,'metadata[booking_id]':booking.id,'metadata[pt_id]':pt.id,'payment_intent_data[metadata][booking_id]':booking.id,'payment_intent_data[metadata][pt_id]':pt.id,success_url:origin+'/booking/'+booking.id+'?stripe=return',cancel_url:origin+'/checkout/'+booking.id+'?stripe=cancel',expires_at:String(Math.floor(booking.expires_at/1000))};
 return job(db,'checkout:'+booking.id,'checkout',booking.id,user.id,{credential_id:booking.stripe_credential_id||undefined,path:'/v1/checkout/sessions',account:booking.stripe_routing==='platform'?undefined:booking.stripe_account_id,data:params});
}
function prepareCancel(db,booking,user){
 if((!SM.isStripe(booking.mode)||booking.mode!==SM.mode())||booking.status!=='pending')throw error(409,'Only an active unpaid Stripe checkout can be cancelled.');
 // A prior creation call may have reached Stripe before its result was saved.
 // Replay that committed job first to recover the Session, then expire it.
 return job(db,'cancel:'+booking.id,'cancel',booking.id,user.id,{credential_id:booking.stripe_credential_id||undefined});
}
function prepareRefund(db,booking,user,token){
 if(!['pt','admin'].includes(user.role))throw error(403,'Only the trainer or admin can refund a payment.');
 if(!/^[a-zA-Z0-9-]{12,80}$/.test(token||''))throw error(400,'Refresh the page before requesting a refund.');
 if((!SM.isStripe(booking.mode)||booking.mode!==SM.mode())||!booking.payment_intent||!['paid','review'].includes(booking.status)||booking.refunded_pence>=booking.amount_pence)throw error(409,'There is no refundable Stripe payment in the current mode on this booking.');
 const active=db.prepare("SELECT id FROM stripe_jobs WHERE target_id=? AND kind='refund' AND status IN ('pending','retry') ORDER BY created_at DESC LIMIT 1").get(booking.id);if(active)return active.id;
 if(booking.refund_status==='pending')throw error(409,'Stripe is still processing a refund. Wait for its notification before retrying.');
 const id='refund:'+booking.id+':'+token;
 const prior=db.prepare('SELECT id FROM stripe_jobs WHERE id=?').get(id);if(prior)return prior.id;
 db.prepare("UPDATE bookings SET refund_status='requested',refund_error=NULL WHERE id=?").run(booking.id);
 return job(db,id,'refund',booking.id,user.id,{credential_id:booking.stripe_credential_id||undefined,path:'/v1/refunds',account:booking.stripe_routing==='platform'?undefined:booking.stripe_account_id,data:{payment_intent:booking.payment_intent,amount:String(booking.amount_pence-booking.refunded_pence),'metadata[booking_id]':booking.id}});
}
function validRedirect(value,hosts){try{const url=new URL(value);return url.protocol==='https:'&&hosts.includes(url.hostname);}catch{return false;}}
function applyRefund(db,row,refund,eventTime){
 db.exec('SAVEPOINT apply_refund');
 try{const result=applyRefundDetails(db,row,refund,eventTime);db.exec('RELEASE apply_refund');return result;}
 catch(error){db.exec('ROLLBACK TO apply_refund');db.exec('RELEASE apply_refund');throw error;}
}
function applyRefundDetails(db,row,refund,eventTime){
 const paymentId=typeof refund.payment_intent==='object'?refund.payment_intent?.id:refund.payment_intent;
 if(paymentId!==row.payment_intent||refund.currency!=='gbp'||!Number.isInteger(refund.amount)||refund.amount<1||refund.amount>row.amount_pence||!/^re_/.test(refund.id||''))throw error(400,'Refund payment or amount mismatch.');
 const previous=db.prepare('SELECT * FROM stripe_refunds WHERE id=?').get(refund.id);
 if(previous&&(previous.booking_id!==row.id||previous.amount_pence!==refund.amount))throw error(400,'Refund booking mismatch.');
 if(previous&&(previous.event_time>eventTime||previous.status==='succeeded'))return;
 const status=['succeeded','failed','canceled','pending','requires_action'].includes(refund.status)?refund.status:'pending';
 db.prepare('INSERT INTO stripe_refunds VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,event_time=excluded.event_time').run(refund.id,row.id,refund.amount,status,eventTime);
 const total=Math.max(db.prepare("SELECT coalesce(sum(amount_pence),0) n FROM stripe_refunds WHERE booking_id=? AND status='succeeded'").get(row.id).n,row.charge_refunded_pence||0);
 if(total>row.amount_pence)throw error(400,'Refund total exceeds the booking payment.');
 const pending=db.prepare("SELECT count(*) n FROM stripe_refunds WHERE booking_id=? AND status IN ('pending','requires_action')").get(row.id).n;
 const refundStatus=total>=row.amount_pence?'succeeded':pending?'pending':['failed','canceled'].includes(status)?'failed':total?'partial':'none';
 db.prepare('UPDATE bookings SET refunded_pence=?,refund_status=?,refund_error=?,status=CASE WHEN ?>=amount_pence THEN \'cancelled\' ELSE status END WHERE id=?').run(total,refundStatus,['failed','canceled'].includes(status)?'Stripe could not complete the refund. The booking remains active.':null,total,row.id);
}
async function executeJob(db,id){
 const row=db.prepare('SELECT * FROM stripe_jobs WHERE id=?').get(id);if(!row)throw error(404,'Payment operation not found.');
 if((JSON.parse(row.payload).mode||'stripe_test')!==SM.mode())throw error(409,'Switch to the original payment mode to retry this operation.');
 if(row.status==='done')return {status:200,body:JSON.parse(row.result)};
 if(row.status==='failed')return {status:409,body:{error:row.last_error||'This payment operation failed. Start a fresh action.'}};
 if(Date.now()-row.created_at>23*3600000)return {status:409,body:{error:'This payment operation is over 23 hours old. Reconcile it in Stripe before starting another request.'}};
 const p=JSON.parse(row.payload);if((p.mode||'stripe_test')!==SM.mode())throw error(409,'Switch to the original payment mode to retry this operation.');SM.validate();
 const credential=p.credential_id?PT.load(db,p.credential_id):null;if(PT.direct()&&!credential)throw error(409,'This historical payment requires its original Connect setup. It cannot use a PT-owned key.');if(credential){const bound=db.prepare('SELECT b.stripe_credential_id,b.stripe_account_id,c.pt_id FROM bookings b JOIN blocks c ON c.id=b.block_id WHERE b.id=?').get(row.target_id);if(!bound||bound.stripe_credential_id!==credential.id||bound.stripe_account_id!==credential.account_id||bound.pt_id!==credential.pt_id||credential.mode!==p.mode)throw error(403,'Payment credential ownership mismatch.');}
 const ownOptions=credential?{key:credential.key,mode:credential.mode}:{};
 try{
  let result,out;
  if(row.kind==='cancel'){
   const booking=db.prepare('SELECT * FROM bookings WHERE id=?').get(row.target_id);
   if(booking.status!=='pending')return finish({ok:booking.status==='cancelled',status:booking.status});
   const creation=db.prepare('SELECT id FROM stripe_jobs WHERE id=?').get('checkout:'+booking.id);
   if(creation&&!booking.checkout_session){const replay=await executeJob(db,creation.id);if(replay.status>=400)return replay;}
   const refreshed=db.prepare('SELECT * FROM bookings WHERE id=?').get(booking.id);
   if(refreshed.checkout_session){result=await stripe('/v1/checkout/sessions/'+encodeURIComponent(refreshed.checkout_session),null,{...ownOptions,account:refreshed.stripe_routing==='platform'?undefined:refreshed.stripe_account_id,method:'GET'});if(result.livemode!==SM.live())throw error(403,'Session payment mode mismatch.');if(result.status==='complete')throw error(409,'Stripe has completed this checkout. Wait for its signed payment notification; the place has not been released.');if(result.status==='open')await stripe('/v1/checkout/sessions/'+encodeURIComponent(refreshed.checkout_session)+'/expire',{}, {...ownOptions,account:refreshed.stripe_routing==='platform'?undefined:refreshed.stripe_account_id,idempotency:id});}
   db.prepare("UPDATE bookings SET status='cancelled' WHERE id=? AND status='pending'").run(booking.id);out={ok:true};
  }else{
   result=await stripe(p.path,p.data,{...ownOptions,account:p.account,idempotency:id,v2:p.v2,method:p.method||'POST'});
   if(row.kind==='link_platform'){if(!/^acct_/.test(result.id||''))throw error(409,'Stripe returned an invalid account.');SM.bind(db,row.target_id,SM.mode(),result.id,'platform',Boolean(result.charges_enabled));out={ok:true,account_id:result.id,ready:Boolean(result.charges_enabled),mode:SM.mode()};
   }else if(row.kind==='account'){
    if(!/^acct_/.test(result.id||'')||result.livemode!==SM.live())throw error(409,'Stripe account payment mode mismatch.');
    SM.bind(db,row.target_id,SM.mode(),result.id,'connected',false);
    out={stripe_next:prepareOnboard(db,row.target_id,row.actor_id,result.id,p.origin)};
   }else if(row.kind==='onboard'){
    if(!validRedirect(result.url,['connect.stripe.com']))throw error(409,'Stripe did not return a valid onboarding link.');out={url:result.url};
   }else if(row.kind==='checkout'){
    if(result.livemode!==SM.live()||!(SM.live()?/^cs_live_/:/^cs_test_/).test(result.id||'')||!validRedirect(result.url,['checkout.stripe.com']))throw error(409,'Stripe did not return a matching Checkout Session.');
    const b=db.prepare('SELECT * FROM bookings WHERE id=?').get(row.target_id);
    if(b.checkout_session&&b.checkout_session!==result.id)throw error(409,'Checkout Session mismatch.');
    db.prepare('UPDATE bookings SET checkout_session=?,checkout_url=? WHERE id=?').run(result.id,result.url,row.target_id);out={url:result.url,booking_id:row.target_id};
   }else if(row.kind==='refund'){
    applyRefund(db,db.prepare('SELECT * FROM bookings WHERE id=?').get(row.target_id),result,0);out={ok:true,refund_id:result.id,refund_status:result.status};
   }else throw error(400,'Unknown Stripe operation.');
  }
  return finish(out);
 }catch(e){
  db.prepare('UPDATE stripe_jobs SET status=?,last_error=? WHERE id=?').run(e.retryable?'retry':'failed',String(e.message).slice(0,500),id);
  if(row.kind==='checkout'&&!e.retryable){db.prepare("UPDATE bookings SET status='failed',payment_error=? WHERE id=? AND status='pending'").run('Stripe could not create this checkout. Please book a fresh place.',row.target_id);}
  if(row.kind==='refund'&&!e.retryable)db.prepare("UPDATE bookings SET refund_status='failed',refund_error=? WHERE id=?").run('Stripe could not start the refund. Retry with a new refund request.',row.target_id);
  return {status:e.status||503,body:{error:e.message||'Payment operation failed. Please retry.'}};
 }
 function finish(body){db.prepare("UPDATE stripe_jobs SET status='done',result=?,last_error=NULL WHERE id=?").run(JSON.stringify(body),id);return {status:200,body};}
}
function verifyWebhook(raw,header,secret,mode=SM.mode()){
 const secrets=Array.isArray(secret)?secret:[secret];if(!secrets.length||!secrets.some(Boolean))throw error(503,'Stripe webhook is not configured.');
 const parts=String(header||'').split(',').map(p=>p.split('=')),timestamp=parts.find(p=>p[0]==='t')?.[1];
 if(!/^\d+$/.test(timestamp||'')||!Number.isFinite(Number(timestamp))||Math.abs(Date.now()/1000-Number(timestamp))>300)throw error(400,'Invalid webhook timestamp.');
 if(!secrets.filter(Boolean).some(value=>{const expected=crypto.createHmac('sha256',value).update(timestamp+'.'+raw).digest();return parts.filter(p=>p[0]==='v1').some(p=>{try{const sig=Buffer.from(p[1],'hex');return sig.length===expected.length&&crypto.timingSafeEqual(sig,expected);}catch{return false;}});}))throw error(400,'Invalid webhook signature.');
 let event;try{event=JSON.parse(raw);}catch{throw error(400,'Invalid webhook data.');}
 if(event.livemode!==SM.live(mode)||(typeof event.data?.object?.livemode==='boolean'&&event.data.object.livemode!==SM.live(mode)))throw error(403,'Webhook payment mode mismatch.');return event;
}
function handleWebhook(db,event,{credentialId=null,mode=SM.mode()}={}){return tx(db,()=>{
 const eventKey=credentialId?credentialId+':'+event.id:event.id;
 const matches=row=>credentialId?row.stripe_credential_id===credentialId&&!event.account:!row.stripe_credential_id&&SM.accountMatches(row,event.account);
 if(event.livemode!==SM.live(mode)||(typeof event.data?.object?.livemode==='boolean'&&event.data.object.livemode!==SM.live(mode)))throw error(403,'Webhook payment mode mismatch.');
 if(db.prepare('SELECT id FROM webhook_events WHERE id=?').get(eventKey))return {duplicate:true};
 const obj=event.data?.object;if(typeof event.id!=='string'||typeof event.type!=='string'||!obj)throw error(400,'Invalid Stripe event.');
 const account=event.account;
 if(event.type.startsWith('checkout.session.')){
  let row=db.prepare('SELECT b.*,c.pt_id FROM bookings b JOIN blocks c ON c.id=b.block_id WHERE b.checkout_session=? OR b.id=?').get(obj.id,obj.metadata?.booking_id||'');
  if(row){
   if(!row.checkout_session&&!db.prepare('SELECT id FROM stripe_jobs WHERE id=?').get('checkout:'+row.id))throw error(400,'No persisted checkout operation matches this event.');
   const bound=row.stripe_account_id||db.prepare('SELECT stripe_account FROM pts WHERE id=?').get(row.pt_id)?.stripe_account;
   if(row.mode!==mode||!matches({...row,stripe_account_id:bound})||obj.metadata?.booking_id!==row.id||obj.metadata?.pt_id!==row.pt_id||obj.mode!=='payment'||(row.checkout_session&&row.checkout_session!==obj.id))throw error(400,'Payment account or booking mismatch.');
   if(obj.amount_total!==row.amount_pence||obj.currency!=='gbp')throw error(400,'Payment amount mismatch.');
   db.prepare('UPDATE bookings SET checkout_session=coalesce(checkout_session,?),stripe_account_id=coalesce(stripe_account_id,?) WHERE id=?').run(obj.id,bound,row.id);
   if(['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)&&obj.payment_status==='paid'){
    const pi=typeof obj.payment_intent==='object'?obj.payment_intent?.id:obj.payment_intent;if(!/^pi_/.test(pi||''))throw error(400,'Missing payment reference.');
    if(row.payment_intent&&row.payment_intent!==pi)throw error(400,'Payment reference mismatch.');
    db.prepare('UPDATE bookings SET payment_intent=?,paid_at=coalesce(paid_at,?),payment_error=NULL WHERE id=?').run(pi,Date.now(),row.id);
    if(!row.paid_at){
     // A delayed success after the hold was released is not silently confirmed.
     const status=row.status==='pending'&&row.expires_at>Date.now()?'paid':'review';
     db.prepare('UPDATE bookings SET status=? WHERE id=?').run(status,row.id);
     if(status==='paid')confirmation(db,db.prepare('SELECT * FROM bookings WHERE id=?').get(row.id));
    }
   }else if(['checkout.session.expired','checkout.session.async_payment_failed'].includes(event.type)&&!row.paid_at&&row.status==='pending'){
    db.prepare('UPDATE bookings SET status=?,payment_error=? WHERE id=?').run(event.type.endsWith('expired')?'expired':'failed',event.type.endsWith('expired')?'Checkout expired. Please choose a new place.':'Stripe reported a failed payment. No booking was confirmed.',row.id);
   }
  }
 }else if(event.type==='payment_intent.payment_failed'){
  const row=db.prepare('SELECT b.* FROM bookings b WHERE b.id=?').get(obj.metadata?.booking_id||'');
  if(row){if(row.mode!==mode||!matches(row)||obj.amount!==row.amount_pence||obj.currency!=='gbp'||(row.payment_intent&&row.payment_intent!==obj.id))throw error(400,'Payment failure does not match this booking.');if(!row.paid_at)db.prepare('UPDATE bookings SET payment_error=? WHERE id=?').run('The card payment failed. Retry in Stripe Checkout or cancel the checkout.',row.id);}
 }else if(['refund.created','refund.updated','refund.failed','charge.refunded'].includes(event.type)){
  const pi=typeof obj.payment_intent==='object'?obj.payment_intent?.id:obj.payment_intent;
  const row=db.prepare("SELECT * FROM bookings WHERE payment_intent=? AND mode=?").get(pi||'',mode);if(row&&!matches(row))throw error(400,'Refund account mismatch.');
  if(row){
   if(event.type==='charge.refunded'){
    if(obj.currency!=='gbp'||obj.amount!==row.amount_pence||!Number.isInteger(obj.amount_refunded)||obj.amount_refunded<0||obj.amount_refunded>row.amount_pence)throw error(400,'Refund amount mismatch.');
    const total=Math.max(row.refunded_pence,obj.amount_refunded);db.prepare('UPDATE bookings SET charge_refunded_pence=max(charge_refunded_pence,?),refunded_pence=?,refund_status=?,status=CASE WHEN ?>=amount_pence THEN \'cancelled\' ELSE status END WHERE id=?').run(total,total,total===row.amount_pence?'succeeded':total?'partial':'none',total,row.id);
   }else applyRefund(db,row,obj,Number(event.created)||0);
  }
 }else if(event.type==='account.updated'){
  if(credentialId){const c=PT.load(db,credentialId);if(obj.id!==c.account_id||account)throw error(400,'Account update mismatch.');db.prepare('UPDATE pt_stripe_credentials SET charges_ready=?,payouts_ready=?,enabled=CASE WHEN ?=0 THEN 0 ELSE enabled END WHERE id=?').run(obj.charges_enabled?1:0,obj.payouts_enabled?1:0,obj.charges_enabled?1:0,c.id);db.prepare('INSERT INTO webhook_events VALUES(?,?)').run(eventKey,Date.now());return {received:true};}
  if(account&&account!==obj.id)throw error(400,'Account update mismatch.');db.prepare('UPDATE stripe_connections SET ready=? WHERE account_id=? AND mode=? AND routing=?').run(obj.charges_enabled?1:0,obj.id,SM.mode(),account?'connected':'platform');if(SM.mode()==='stripe_test'&&account)db.prepare('UPDATE pts SET stripe_ready=? WHERE stripe_account=?').run(obj.charges_enabled?1:0,obj.id);
 }
 db.prepare('INSERT INTO webhook_events VALUES(?,?)').run(eventKey,Date.now());return {received:true};
});}
module.exports={merchantAccount,setupStatus,prepareLink,available,reserve,completeDemo,stripe,prepareConnect,prepareCheckout,prepareCancel,prepareRefund,syncPt,executeJob,verifyWebhook,handleWebhook,expire};
