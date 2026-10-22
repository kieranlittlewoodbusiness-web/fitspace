'use strict';
const crypto=require('node:crypto');
const {uid,hashPassword,verifyPassword}=require('./db.cjs');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const error=(status,message)=>Object.assign(new Error(message),{status});
function cookieToken(req){const cookie=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('fit_session='));return cookie?cookie.slice(12):null;}
function current(db,req,demo){const token=cookieToken(req);if(!token)return null;const row=db.prepare('SELECT u.*,s.csrf,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').get(digest(token),Date.now());if(!row||(!demo&&row.demo))return null;return row;}
function safeUser(row){return row?{id:row.id,name:row.name,email:row.email,role:row.role,pt_id:row.pt_id,must_change_password:Boolean(row.must_change_password)}:null;}
function requireUser(user,roles){if(!user)throw error(401,'Please sign in to continue.');if(roles&&!roles.includes(user.role))throw error(403,'Your account does not have access to this action.');return user;}
function session(db,res,user,secure){const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),user.id,csrf,Date.now()+7*86400000);res.setHeader('Set-Cookie',`fit_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure?'; Secure':''}`);return csrf;}
function logout(db,req,res,secure){const token=cookieToken(req);if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));res.setHeader('Set-Cookie',`fit_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure?'; Secure':''}`);}
function csrf(req,user){if(user&&req.headers['x-csrf-token']!==user.csrf)throw error(403,'Your session changed. Refresh the page and try again.');}
const limits=new Map();
function rateLimit(key,max=15,windowMs=15*60000){const now=Date.now();let data=limits.get(key);if(!data||data.until<now){data={count:0,until:now+windowMs};limits.set(key,data);}if(++data.count>max)throw error(429,'Too many attempts. Please try again in a few minutes.');if(limits.size>10000)for(const [key,value]of limits)if(value.until<now)limits.delete(key);}
function email(value){const result=String(value||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)||result.length>160)throw error(400,'Enter a valid email address.');return result;}
function text(value,label,max=200,min=1){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)throw error(400,`${label} must be ${min}–${max} characters.`);return value.trim();}
function password(value){if(typeof value!=='string'||value.length<12||value.length>200)throw error(400,'Use a password with 12–200 characters.');return value;}
function createUser(db,{name,address,pass,role='customer',ptId=null,temporary=false}){const id=uid();db.prepare('INSERT INTO users(id,name,email,password_hash,role,pt_id,must_change_password,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,text(name,'Name',80,2),email(address),hashPassword(password(pass)),role,ptId,temporary?1:0,Date.now());return db.prepare('SELECT * FROM users WHERE id=?').get(id);}
module.exports={digest,error,current,safeUser,requireUser,session,logout,csrf,rateLimit,email,text,password,createUser,verifyPassword,hashPassword};
