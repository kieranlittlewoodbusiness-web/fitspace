'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createApp}=require('../server.cjs');

const appJs=fs.readFileSync(path.join(__dirname,'../public/app.js'),'utf8');
const serverSrc=fs.readFileSync(path.join(__dirname,'../server.cjs'),'utf8');
const siteHtml=fs.readFileSync(path.join(__dirname,'../../site/index.html'),'utf8');
const resetSrc=fs.readFileSync(path.join(__dirname,'../password-reset.cjs'),'utf8');

// Infra identifiers that must stay "fitspace". Visible copy must not.
const fitspaceIdAllowlist=[
  'fitspace-password-reset:',
  'fitspace-auth:',
  'fitspace_preview_',
  'fitspace-public-v4',
  'FITSPACE_TEST_BUNDLED',
  'fitspace-netlify-public'
];
function withoutAllowlistedIds(text){
  return fitspaceIdAllowlist.reduce((out,id)=>out.split(id).join(''),text);
}
function assertNoVisibleFitspace(text,label){
  assert.equal(/FITSPACE/i.test(withoutAllowlistedIds(text)),false,label+' still contains FITSPACE outside allowlisted identifiers');
}

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
  // Exact surfaces that a loose "Your coach" / header check would miss
  assert.ok(appJs.includes('<a href="/trainers" class="optional" data-route>Your coach</a>'));
  assert.ok(appJs.includes("document.title='Choose a new password — Resilience Coaching'"));
  assert.ok(appJs.includes("document.title=(me.role==='admin'?'Platform admin':me.role==='pt'?'Trainer workspace':'My bookings')+' — Resilience Coaching'"));
});

test('blockForm and brandForm remain the class and brand form functions',()=>{
  // Anchor by function name so this passes before and after rc-4-d1 adds create_key.
  assert.match(appJs,/^function blockForm\(/m);
  assert.match(appJs,/^function brandForm\(/m);
});

test('the public PT 404 uses the approved page copy',()=>{
  assert.ok(serverSrc.includes("throw auth.error(404,'This page is not available.')"));
  assert.equal(serverSrc.includes('This trainer page is not available.'),false);
});

test('site/index.html and password-reset emails keep the approved Resilience Coaching copy',()=>{
  assert.ok(siteHtml.includes('<title>Resilience Coaching setup</title>'));
  assert.ok(siteHtml.includes('<h1>Resilience Coaching · deployment setup</h1>'));
  assertNoVisibleFitspace(siteHtml,'site/index.html');
  assert.ok(resetSrc.includes("subject='Reset your Resilience Coaching password'"));
  assert.ok(resetSrc.includes(String.raw`text='A password reset was requested for your Resilience Coaching account.\n\nOpen this link to choose a new password:\n'+job.origin+'/reset-password#'+token(reset.id)+'\n\nThis link expires 30 minutes after the request and can be used once. If you did not request this, ignore this email. Your password has not changed.'`));
  assert.ok(resetSrc.includes("subject='Your Resilience Coaching password has changed'"));
  assert.ok(resetSrc.includes(String.raw`text='Your Resilience Coaching password was reset. All previous sign-in sessions have been closed.\n\nIf you did not make this change, request a fresh password reset from '+job.origin+'/forgot-password and contact your coach or platform owner.'`));
  assert.equal(resetSrc.includes('and contact your trainer or platform owner.'),false);
  assertNoVisibleFitspace(resetSrc,'password-reset email source');
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
  assert.ok(js.includes('<a href="/trainers" class="optional" data-route>Your coach</a>'));
  assert.ok(js.includes("document.title='Choose a new password — Resilience Coaching'"));
  assert.ok(js.includes("document.title=(me.role==='admin'?'Platform admin':me.role==='pt'?'Trainer workspace':'My bookings')+' — Resilience Coaching'"));
  assert.equal(js.includes('Discover another trainer'),false);
  assertNoVisibleFitspace(js,'served /app.js');
  const html=await (await fetch(base+'/')).text();
  assert.ok(html.includes('<title>Resilience Coaching — Your training, connected</title>'));
  assert.ok(html.includes('<span id="modalEyebrow">Resilience Coaching</span>'));
  assertNoVisibleFitspace(html,'served /');
});
