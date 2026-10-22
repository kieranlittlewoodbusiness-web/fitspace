'use strict';
const {uid}=require('./db.cjs');
const crypto=require('node:crypto');
const MOTIVATIONS=Object.freeze([
'One missed session does not erase your progress. Your next step still matters.',
'Progress grows from showing up again, not from getting every week perfect.',
'A fresh start can be as simple as your next workout.',
'Small steps, repeated, build stronger habits.',
'You do not need a perfect week to make a positive change.',
'Your fitness journey is yours. Keep moving at a pace you can build on.',
'Consistency is built one return at a time.',
'The next session is another chance to invest in yourself.',
'Strength begins with the decision to try again.',
'Give yourself some grace, then take your next small step.',
'Keep your focus on progress you can repeat.',
'Every session is an opportunity to learn something about yourself.',
'Momentum can start again today.',
'Make room for the next positive choice.',
'Your effort matters, even when progress feels slow.',
'A strong routine leaves space to begin again.',
'You have not lost your place on the journey. Keep going.',
'The most useful workout is the next one you show up for.',
'Build confidence through the small promises you keep to yourself.',
'A little movement and a little encouragement can be a good place to restart.'
]);
function enqueue(db,{ptId,customerId,key,to,subject,body,kind,quoteIndex=null}){const status=process.env.EMAIL_MODE==='send'?'queued':'preview';const id=uid();db.prepare('INSERT OR IGNORE INTO email_outbox(id,pt_id,customer_id,dedupe_key,recipient,subject,body,kind,quote_index,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,ptId,customerId,key,to,subject,body,kind,quoteIndex,status,Date.now());return db.prepare('SELECT * FROM email_outbox WHERE dedupe_key=?').get(key);}
function noShow(db,booking,session,customer,pt){const index=crypto.randomInt(MOTIVATIONS.length);const dateLabel=new Date(session.starts_at+'Z').toLocaleDateString('en-GB',{timeZone:'UTC',weekday:'long',day:'numeric',month:'long'});const body=`Hi ${customer.name.split(' ')[0]},\n\nSorry we missed you at class! We hope you are doing well.\n\nWe missed you at ${booking.block_title} on ${dateLabel} at ${session.starts_at.slice(11)} (UK time).\n\n${MOTIVATIONS[index]}\n\nWe would love to see you at your next session. If you need support getting back into your routine, just reply and let us know.\n\n${pt.brand_name}`;
return enqueue(db,{ptId:pt.id,customerId:customer.id,key:`noshow:${booking.id}:${session.id}`,to:customer.email,subject:'Sorry we missed you at class!',body,kind:'no_show',quoteIndex:index});}
function confirmation(db,booking){const customer=db.prepare('SELECT name,email FROM users WHERE id=?').get(booking.customer_id);const block=db.prepare('SELECT * FROM blocks WHERE id=?').get(booking.block_id);const pt=db.prepare('SELECT * FROM pts WHERE id=?').get(block.pt_id);const sessions=db.prepare('SELECT starts_at FROM class_sessions WHERE block_id=? ORDER BY starts_epoch').all(block.id);const amount=(booking.amount_pence/100).toFixed(2);return enqueue(db,{ptId:pt.id,customerId:booking.customer_id,key:`confirmation:${booking.id}`,to:customer.email,subject:`Your booking with ${pt.brand_name} is confirmed`,body:`Hi ${customer.name},\n\nYour ${booking.mode==='demo'?'test ':''}booking is confirmed.\n\n${block.title}\nReference: ${booking.reference}\nVenue: ${block.venue}\nSessions (UK time):\n${sessions.map(s=>s.starts_at.replace('T',' at ')).join('\n')}\n\n${booking.mode==='demo'?'Simulated':'Stripe sandbox'} payment: £${amount}\nNo real money was taken in this test version.\n\nSee you at class!\n${pt.brand_name}`,kind:'confirmation'});}
let sending=false;
async function deliver(db){if(sending||process.env.EMAIL_MODE!=='send'||!process.env.RESEND_API_KEY||!process.env.MAIL_FROM)return;sending=true;try{const rows=db.prepare("SELECT * FROM email_outbox WHERE status IN ('queued','failed') AND attempts<5 AND next_attempt_at<=? ORDER BY created_at LIMIT 10").all(Date.now());for(const row of rows){if(row.recipient.endsWith('@example.com')){db.prepare("UPDATE email_outbox SET status='preview',last_error='Demo example.com recipient: delivery suppressed' WHERE id=?").run(row.id);continue;}try{const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':row.dedupe_key},body:JSON.stringify({from:process.env.MAIL_FROM,to:[row.recipient],subject:row.subject,text:row.body,...(row.pt_id?{reply_to:db.prepare("SELECT email FROM users WHERE pt_id=? AND role='pt' LIMIT 1").get(row.pt_id)?.email}:{} )}),signal:AbortSignal.timeout(15000)});const result=await response.json();if(!response.ok)throw new Error(result.message||'Email provider rejected the request.');db.prepare("UPDATE email_outbox SET status='sent',provider_id=?,sent_at=?,last_error=NULL,attempts=attempts+1 WHERE id=?").run(result.id,Date.now(),row.id);}catch(error){db.prepare("UPDATE email_outbox SET status='failed',attempts=attempts+1,last_error=?,next_attempt_at=? WHERE id=?").run(String(error.message).slice(0,500),Date.now()+Math.min(3600000,60000*2**row.attempts),row.id);}}}finally{sending=false;}}
module.exports={MOTIVATIONS,enqueue,noShow,confirmation,deliver};
