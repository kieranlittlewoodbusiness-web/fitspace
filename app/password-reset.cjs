'use strict';
const crypto=require('node:crypto');
const auth=require('./auth.cjs');
const {uid,tx}=require('./db.cjs');
const MESSAGE='If an eligible account uses that email address, a password reset link will be emailed. Check your inbox and spam folder. You can request another link later if it does not arrive.';
function configured(){return process.env.RESET_EMAIL_MODE==='send'&&Boolean(process.env.RESEND_API_KEY&&process.env.MAIL_FROM)&&(process.env.AUTH_RESET_SECRET||'').length>=32&&/^https:\/\/[^/]+\/?$/.test(process.env.APP_URL||'');}
function token(id){return id+'.'+crypto.createHmac('sha256',process.env.AUTH_RESET_SECRET||'').update('fitspace-password-reset:'+id).digest('base64url');}
function mail(db,user,kind,resetId=null){const id=uid();db.prepare('INSERT INTO auth_mail_jobs(id,user_id,reset_id,kind,recipient,sender,origin,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,user.id,resetId,kind,user.email,process.env.MAIL_FROM,new URL(process.env.APP_URL).origin,Date.now());return id;}
function requestReset(db,value){const address=auth.email(value),now=Date.now(),key=auth.digest(address);
 return tx(db,()=>{
  db.prepare('DELETE FROM password_reset_limits WHERE created_at<?').run(now-3600000);
  db.prepare('DELETE FROM auth_mail_jobs WHERE created_at<?').run(now-7*86400000);
  db.prepare('DELETE FROM password_resets WHERE expires_at<?').run(now-86400000);
  const n=db.prepare('SELECT count(*) n FROM password_reset_limits WHERE email_hash=?').get(key).n;if(n>=3)return null;
  db.prepare('INSERT INTO password_reset_limits VALUES(?,?,?)').run(uid(),key,now);
  const user=db.prepare("SELECT * FROM users WHERE email=? AND active=1 AND demo=0 AND role IN ('customer','pt')").get(address);
  if(!configured()||!user)return null;
  const id=uid();db.prepare('INSERT INTO password_resets(id,user_id,token_hash,password_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)').run(id,user.id,auth.digest(token(id)),user.password_hash,now+30*60000,now);
  return mail(db,user,'link',id);
 });
}
function resetPassword(db,value,newPassword){
 if(!configured())throw auth.error(503,'Password reset email is not configured. Contact your trainer or platform owner.');
 if(typeof value!=='string'||!/^[-a-f0-9]{36}\.[A-Za-z0-9_-]{43}$/.test(value))throw auth.error(400,'This reset link is invalid or expired. Request a new link.');
 const pass=auth.password(newPassword);
 return tx(db,()=>{
  const row=db.prepare('SELECT r.*,u.email,u.role,u.active,u.demo,u.password_hash current_hash FROM password_resets r JOIN users u ON u.id=r.user_id WHERE r.token_hash=?').get(auth.digest(value));
  if(!row||row.used_at||row.expires_at<=Date.now()||!row.active||row.demo||!['customer','pt'].includes(row.role)||row.password_hash!==row.current_hash||auth.digest(token(row.id))!==row.token_hash)throw auth.error(400,'This reset link is invalid or expired. Request a new link.');
  db.prepare('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?').run(auth.hashPassword(pass),row.user_id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id);
  db.prepare('UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL').run(Date.now(),row.user_id);
  db.prepare('INSERT INTO audit_log VALUES(?,?,?,?,?)').run(uid(),row.user_id,'password_reset',row.user_id,Date.now());
  return mail(db,{id:row.user_id,email:row.email},'changed');
 });
}
async function deliver(db,id){
 const job=db.prepare('SELECT * FROM auth_mail_jobs WHERE id=?').get(id);if(!job||job.status==='sent'||!configured())return;
 if(Date.now()-job.created_at>23*3600000)return;
 const user=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(job.user_id);if(!user||user.email!==job.recipient)return;
 let text,subject;
 if(job.kind==='link'){
  const reset=db.prepare('SELECT * FROM password_resets WHERE id=?').get(job.reset_id);
  if(!reset||reset.used_at||reset.expires_at<=Date.now()||reset.password_hash!==user.password_hash||reset.token_hash!==auth.digest(token(reset.id)))return;
  subject='Reset your FITSPACE password';text='A password reset was requested for your FITSPACE account.\n\nOpen this link to choose a new password:\n'+job.origin+'/reset-password#'+token(reset.id)+'\n\nThis link expires 30 minutes after the request and can be used once. If you did not request this, ignore this email. Your password has not changed.';
 }else{subject='Your FITSPACE password has changed';text='Your FITSPACE password was reset. All previous sign-in sessions have been closed.\n\nIf you did not make this change, request a fresh password reset from '+job.origin+'/forgot-password and contact your trainer or platform owner.';}
 try{
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'fitspace-auth:'+id},body:JSON.stringify({from:job.sender,to:[job.recipient],subject,text}),signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error('Email delivery not accepted');
  db.prepare("UPDATE auth_mail_jobs SET status='sent',last_error=NULL WHERE id=?").run(id);
 }catch{db.prepare("UPDATE auth_mail_jobs SET status='retry',last_error='Email delivery not confirmed. Request a new link if needed.' WHERE id=?").run(id);}
}
module.exports={configured,requestReset,resetPassword,deliver,MESSAGE};
