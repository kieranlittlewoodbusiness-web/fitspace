'use strict';
const {uid,hashPassword}=require('./db.cjs');
const auth=require('./auth.cjs');

// Public visitors can browse and register customers. Privileged accounts must
// be owned accounts; public fixture credentials are never seeded or accepted.
function initialise(db){
  if(db.prepare('SELECT count(*) n FROM users WHERE demo=1').get().n){
    throw auth.error(503,'This store contains demo accounts. Set DATA_NAMESPACE to a fresh value such as fitspace-public-v4 and redeploy.');
  }
  if(db.prepare('SELECT count(*) n FROM users').get().n)return;
  let email,password;
  try{email=auth.email(process.env.ADMIN_EMAIL);password=auth.password(process.env.ADMIN_PASSWORD);}catch{
    throw auth.error(503,'Set ADMIN_EMAIL and ADMIN_PASSWORD (12–200 characters) in Netlify to create your private admin login. Visitors do not need a site password.');
  }
  if(password==='TrainTogether123!')throw auth.error(503,'Choose your own ADMIN_PASSWORD rather than the old demo password.');
  db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(uid(),process.env.ADMIN_NAME||'Site Admin',email,hashPassword(password),'admin',Date.now());
}
module.exports={initialise};
