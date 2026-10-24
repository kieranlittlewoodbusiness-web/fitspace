'use strict';
const fail=message=>Object.assign(new Error(message),{status:503});
function mode(){return process.env.PAYMENT_MODE||'stripe_test';}
function isStripe(value){return ['stripe_test','stripe_live'].includes(value);}
function live(value=mode()){return value==='stripe_live';}
function validate(value=mode()){
 if(!['demo','stripe_test','stripe_live'].includes(value))throw fail('Use PAYMENT_MODE=demo, stripe_test or stripe_live.');
 const key=process.env.STRIPE_SECRET_KEY||'';
 if(value==='demo'){if(/^(sk|rk)_live_/.test(key))throw fail('A live key cannot be used in demo mode.');return;}
 if(!new RegExp('^(sk|rk)_'+(live(value)?'live':'test')+'_').test(key))throw fail('The Stripe secret key does not match the selected payment mode.');
}
function connection(db,ptId,value=mode()){
 const saved=db.prepare('SELECT account_id,routing,ready FROM stripe_connections WHERE pt_id=? AND mode=?').get(ptId,value);
 if(saved)return saved;
 if(value==='stripe_test'){const old=db.prepare('SELECT stripe_account,stripe_ready FROM pts WHERE id=?').get(ptId);if(old?.stripe_account)return {account_id:old.stripe_account,routing:'connected',ready:old.stripe_ready};}
 return null;
}
function bind(db,ptId,value,account,routing,ready){
 const other=db.prepare('SELECT pt_id FROM stripe_connections WHERE mode=? AND account_id=? AND pt_id<>?').get(value,account,ptId);
 if(other)throw Object.assign(new Error('This Stripe account is already assigned to another trainer in this payment mode.'),{status:409});
 db.prepare('INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready) VALUES(?,?,?,?,?) ON CONFLICT(pt_id,mode) DO UPDATE SET account_id=excluded.account_id,routing=excluded.routing,ready=excluded.ready').run(ptId,value,account,routing,ready?1:0);
 if(value==='stripe_test'&&routing==='connected')db.prepare('UPDATE pts SET stripe_account=?,stripe_ready=? WHERE id=?').run(account,ready?1:0,ptId);
}
function accountMatches(booking,eventAccount){return booking.stripe_routing==='platform'?!eventAccount:eventAccount===booking.stripe_account_id;}
module.exports={mode,live,isStripe,validate,connection,bind,accountMatches};
