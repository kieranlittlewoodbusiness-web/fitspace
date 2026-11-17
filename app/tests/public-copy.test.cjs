'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createApp}=require('../server.cjs');

const appJs=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const appLines=appJs.replace(/\n$/,'').split('\n');
const serverSrc=fs.readFileSync(path.join(__dirname,'../server.cjs'),'utf8');

const present=[
  'View classes ↗',
  'Your coach\u2019s classes, schedule and training space are shown below.',
  'Visit the site ↗',
  'Classes are coming soon.',
  'Sign in to your account.',
  'YOUR ACCOUNT',
  'Contact your coach or the platform owner for help.',
  'Contact your coach to arrange a refund.',
  'your coach can retry it safely using its existing payment-operation key.',
  'Your coach',
  'Find your coach',
  'Bring water, trainers and comfortable workout clothes'
];

const absent=[
  'Discover another trainer ↗',
  'Each trainer has their own classes, schedule and training space.',
  "Visit the trainer's site ↗",
  'Trainer pages and classes are coming soon.',
  'Sign in to your customer, PT or admin account.',
  'CUSTOMERS & PERSONAL TRAINERS',
  'Contact your trainer or the platform owner for help.',
  'Contact the trainer to arrange a refund.',
  'the trainer can retry it safely using its existing payment-operation key.',
  'This trainer page is not available.',
  'Find a trainer',
  'Discover another trainer'
];

test('public app.js keeps the approved single-coach and Resilience Coaching copy',()=>{
  for(const s of present)assert.ok(appJs.includes(s),'missing '+JSON.stringify(s));
  for(const s of absent)assert.equal(appJs.includes(s),false,'should not contain '+JSON.stringify(s));
  assert.match(appJs,/\beyebrow='Resilience Coaching'/);
  assert.match(appJs,/pt\?\.brand_name\|\|'Resilience Coaching'/);
  assert.ok(appJs.includes('<span class="brand-icon">R</span>Resilience Coaching'));
  assert.ok(appJs.includes("Stripe fees reduce your payout; Resilience Coaching adds no application fee."));
  // Previously approved customer labels stay; admin/PT labels stay
  assert.ok(appJs.includes("['trainers','people','Your coach']"));
  assert.ok(appJs.includes("['trainers','people','PT accounts']"));
  assert.ok(appJs.includes("role==='pt'?'TRAINER WORKSPACE'"));
  assert.ok(appJs.includes("me.role==='pt'?'Trainer workspace'"));
});

test('app.js lines 60 and 63 remain the class and brand forms, not copy edits',()=>{
  assert.equal(appLines.length,73);
  assert.match(appLines[59],/^function blockForm\(/);
  assert.match(appLines[62],/^function brandForm\(/);
  assert.equal(appLines[59].includes('create_key'),false);
  assert.equal(appLines[62].includes('create_key'),false);
});

test('the public PT 404 uses the approved page copy',()=>{
  assert.ok(serverSrc.includes("throw auth.error(404,'This page is not available.')"));
  assert.equal(serverSrc.includes('This trainer page is not available.'),false);
});

let app,base,dir;
before(async()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'fitspace-copy-'));
  app=createApp({dbPath:path.join(dir,'test.sqlite'),demo:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  base='http://localhost:'+app.server.address().port;
});
after(async()=>{
  await new Promise(resolve=>app.server.close(resolve));
  app.db.close();
  fs.rmSync(dir,{recursive:true,force:true});
});

test('GET /api/public/pts/:unknown returns 404 "This page is not available."',async()=>{
  const response=await fetch(base+'/api/public/pts/no-such-coach');
  const data=await response.json();
  assert.equal(response.status,404);
  assert.equal(data.error,'This page is not available.');
});

test('the served /app.js and / includes the approved public wording',async()=>{
  const js=await (await fetch(base+'/app.js')).text();
  assert.ok(js.includes('View classes ↗'));
  assert.ok(js.includes('Your coach\u2019s classes, schedule and training space are shown below.'));
  assert.ok(js.includes('Visit the site ↗'));
  assert.ok(js.includes('Find your coach'));
  assert.equal(js.includes('Discover another trainer'),false);
  const html=await (await fetch(base+'/')).text();
  assert.ok(html.includes('<title>Resilience Coaching — Your training, connected</title>'));
  assert.ok(html.includes('<span id="modalEyebrow">Resilience Coaching</span>'));
});
