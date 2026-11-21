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
  'Sign in to book and see your classes.',
  'YOUR ACCOUNT',
  'Contact your coach or the platform owner for help.',
  'Contact your coach to arrange a refund.',
  'your coach can retry it safely using its existing payment-operation key.',
  'Your coach',
  'Find your coach',
  'Bring water, trainers and comfortable workout clothes',
  'Book a class',
  'Show up. Keep going.',
  'Show up for yourself. Book a class and take the next step.',
  'How it works',
  'Create an account.',
  'Choose a class.',
  'Pay upfront, then come to the session.',
  'Booking is not open yet. Please check back soon.',
  'See classes and book',
  'One account. Book a class, then show up.',
  'CLASSES YOU CAN BOOK',
  'YOUR TRAINING SPACE',
  'Ready to book your next class?',
  'Class full',
  "placeholder=\"${customer?'Search class or reference':'Search customer, class or reference'}\"",
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
  'Discover another trainer',
  'Your training, connected',
  'Sign in to your account.',
  'Choose your class or block',
  'Block full',
  'Trainer / class'
];

test('public app.js keeps the approved single-coach and Resilience Coaching copy',()=>{
  for(const s of present)assert.ok(appJs.includes(s),'missing '+JSON.stringify(s));
  for(const s of absent)assert.equal(appJs.includes(s),false,'should not contain '+JSON.stringify(s));
  assert.match(appJs,/\beyebrow='Resilience Coaching'/);
  assert.match(appJs,/pt\?\.brand_name\|\|'Resilience Coaching'/);
  assert.ok(appJs.includes('<span class="brand-icon">R</span><span class="wordmark">Resilience Coaching</span>'));
  assert.ok(appJs.includes("Stripe fees reduce your payout; Resilience Coaching adds no application fee."));
  // Previously approved customer labels stay; admin/PT labels stay
  assert.ok(appJs.includes("['trainers','people','Your coach']"));
  assert.ok(appJs.includes("['trainers','people','PT accounts']"));
  assert.ok(appJs.includes("role==='pt'?'TRAINER WORKSPACE'"));
  assert.ok(appJs.includes("me.role==='pt'?'Trainer workspace'"));
  // Your coach remains, but now targets bookingPath() rather than /trainers
  assert.ok(appJs.includes('data-route>Your coach</a>'));
  assert.equal(appJs.includes('<a href="/trainers" class="optional" data-route>Your coach</a>'),false);
  assert.ok(appJs.includes("document.title='Choose a new password — Resilience Coaching'"));
  assert.ok(appJs.includes("document.title=(me.role==='admin'?'Platform admin':me.role==='pt'?'Trainer workspace':'My bookings')+' — Resilience Coaching'"));
  assert.ok(appJs.includes("document.title='Resilience Coaching — Show up. Keep going.'"));
});

test('blockForm and brandForm remain the class and brand form functions',()=>{
  // Anchor by function name so this passes before and after rc-4-d1 adds create_key.
  assert.match(appJs,/^function blockForm\(/m);
  assert.match(appJs,/^function brandForm\(/m);
});

test('landing and site helpers are anchored by function name',()=>{
  assert.match(appJs,/^function bookingPath\(/m);
  assert.match(appJs,/^function isMultiPt\(/m);
  assert.match(appJs,/^async function loadSite\(/m);
  assert.match(appJs,/^function emptyState\(/m);
  assert.match(appJs,/^function heroImage\(/m);
  assert.match(appJs,/^async function renderLanding\(/m);
  assert.match(appJs,/^function brandHeader\(/m);
  assert.match(appJs,/^function classCard\(/m);
  assert.match(appJs,/^function bookingTable\(/m);
  assert.match(appJs,/^async function renderHome\(/m);
  assert.match(appJs,/^async function renderRoute\(/m);
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
  assert.ok(resetSrc.includes('Password reset email is not configured. Contact your coach or the platform owner for help.'));
  assert.equal(resetSrc.includes('and contact your trainer or platform owner.'),false);
  assert.equal(resetSrc.includes('Contact your trainer or platform owner.'),false);
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
  assert.ok(js.includes('data-route>Your coach</a>'));
  assert.ok(js.includes('Book a class'));
  assert.ok(js.includes('Show up. Keep going.'));
  assert.equal(js.includes('<a href="/trainers" class="optional" data-route>Your coach</a>'),false);
  assert.ok(js.includes("document.title='Choose a new password — Resilience Coaching'"));
  assert.ok(js.includes("document.title=(me.role==='admin'?'Platform admin':me.role==='pt'?'Trainer workspace':'My bookings')+' — Resilience Coaching'"));
  assert.equal(js.includes('Discover another trainer'),false);
  assertNoVisibleFitspace(js,'served /app.js');
  const html=await (await fetch(base+'/')).text();
  assert.ok(html.includes('<title>Resilience Coaching — Show up. Keep going.</title>'));
  assert.ok(html.includes('<span id="modalEyebrow">Resilience Coaching</span>'));
  assert.ok(html.includes('rel="preload" href="/fonts/sora-latin-wght.woff2"'));
  assert.ok(html.includes('rel="preload" href="/images/hero.webp"'));
  assertNoVisibleFitspace(html,'served /');
});

const PUBLIC_STATIC=[
  ['/app.js','text/javascript','no-cache'],
  ['/styles.css','text/css','no-cache'],
  ['/fonts/sora-latin-wght.woff2','font/woff2','public, max-age=31536000, immutable'],
  ['/images/hero.webp','image/webp','public, max-age=86400'],
  ['/images/booking-hero.webp','image/webp','public, max-age=86400'],
  ['/images/class-strength.webp','image/webp','public, max-age=86400'],
  ['/images/class-conditioning.webp','image/webp','public, max-age=86400'],
  ['/images/empty-classes.webp','image/webp','public, max-age=86400'],
  ['/images/empty-bookings.webp','image/webp','public, max-age=86400']
];

test('brand fonts and images are served from /fonts and /images',async()=>{
  const font=await fetch(base+'/fonts/sora-latin-wght.woff2');
  assert.equal(font.status,200);
  assert.match(font.headers.get('content-type')||'',/woff2/);
  const hero=await fetch(base+'/images/hero.webp');
  assert.equal(hero.status,200);
  assert.match(hero.headers.get('content-type')||'',/image\/webp/);
  const missing=await fetch(base+'/images/not-a-real-image.webp');
  assert.equal(missing.status,404);
});

test('the public static allowlist is an exact, case-sensitive list of files',async()=>{
  assert.equal(serverSrc.includes("route==='/app.js'"),false);
  assert.equal(serverSrc.includes("route==='/styles.css'"),false);
  assert.equal(serverSrc.includes('.woff2)$/i'),false);
  assert.equal(serverSrc.includes('.webp)$/i'),false);
  for(const [path,type,cache] of PUBLIC_STATIC){
    const res=await fetch(base+path);
    assert.equal(res.status,200,path+' status');
    assert.ok((res.headers.get('content-type')||'').includes(type),path+' type');
    assert.equal(res.headers.get('cache-control'),cache,path+' cache');
    assert.ok((await res.arrayBuffer()).byteLength>0,path+' empty');
  }
  const html=await (await fetch(base+'/')).text();
  for(const path of ['/IMAGES/hero.webp','/FONTS/sora-latin-wght.woff2']){
    const res=await fetch(base+path);
    assert.equal(res.status,200,path+' status');
    assert.match(res.headers.get('content-type')||'',/text\/html/);
    assert.equal(await res.text(),html,path+' should be the HTML shell');
  }
  for(const path of ['/fonts/OFL.txt','/images/not-a-real-image.webp','/fonts/missing.woff2','/images/%2fsecret.webp','/fonts/%5csecret.woff2','/images/..%2fapp.js','/images/%2e%2e%2fapp.js']){
    const res=await fetch(base+path);
    assert.equal(res.status,404,path+' should 404');
  }
  for(const path of ['/images/../etc/passwd','/fonts/%2e%2e/%2e%2e/package.json','/images/%2e%2e/%2e%2e/package.json']){
    const res=await fetch(base+path);
    assert.equal(res.status,200,path+' status');
    assert.match(res.headers.get('content-type')||'',/text\/html/);
    assert.equal(await res.text(),html,path+' should be the HTML shell');
  }
});

// RC-4: the sign-in modal rendered a literal "}" after </form> (typo in the uploaded app.js,
// 06c9a72, kept by RC-20). Render the real login, signup, forgot and reset views from app.js
// with minimal stand-ins and check none has a stray "}" or an uninterpolated "${".
function assertCleanAuthHtml(html,label){
  assert.equal(typeof html,'string',label+' did not render');
  assert.ok(html.length>100,label+' rendered almost nothing');
  assert.equal(html.includes('${'),false,label+' contains uninterpolated ${');
  assert.equal(/>\s*}/.test(html),false,label+' has a stray } after a tag');
  assert.equal(/}\s*</.test(html),false,label+' has a stray } before a tag');
}
function renderAuthViews(src,{config={},resetToken='tok'}={}){
  const start=src.indexOf('function authModal');
  const resetAt=src.indexOf('function resetPasswordView');
  const end=src.indexOf('\nfunction ',resetAt+1);
  assert.ok(start>=0&&resetAt>start,'auth view functions not found in app.js');
  const fnSrc=src.slice(start,end===-1?src.length:end);
  let captured=null;
  const views=new Function('sandbox',
    'const {config,esc,brandHeader,modal}=sandbox;\nlet resetToken=sandbox.resetToken,authIntent=null;\n'+fnSrc+
    '\nreturn {authModal,forgotPasswordView,resetPasswordView};')({
    config,resetToken,
    esc(value){return String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));},
    brandHeader(){return '<header></header>';},
    modal(_title,html){captured=html;}
  });
  views.authModal('login');const login=captured;
  views.authModal('signup');const signup=captured;
  return {login,signup,forgot:views.forgotPasswordView(),reset:views.resetPasswordView()};
}
test('rendered login, signup, forgot and reset views have no stray } or ${',()=>{
  for(const config of [{},{password_reset_available:true},{password_reset_available:false}]){
    const views=renderAuthViews(appJs,{config});
    for(const [name,html] of Object.entries(views))assertCleanAuthHtml(html,name+' '+JSON.stringify(config));
    assert.equal(views.login.includes('}</form>'),false);
    assert.ok(views.login.includes('</form>'));
  }
  assert.ok(renderAuthViews(appJs).login.includes('Forgot your password?'));
});


test('readResetToken takes ?token= on any path and the hash only on /reset-password',()=>{
  const start=appJs.indexOf('function readResetToken');
  const end=appJs.indexOf('function captureResetToken');
  assert.ok(start>=0&&end>start);
  const readResetToken=new Function(appJs.slice(start,end)+';return readResetToken;')();
  assert.equal(readResetToken({pathname:'/reset-password',search:'?token=from-query',hash:'#from-hash'}),'from-query');
  assert.equal(readResetToken({pathname:'/',search:'?token=from-query',hash:''}),'from-query');
  assert.equal(readResetToken({pathname:'/login',search:'?token=from-query',hash:'#ignored'}),'from-query');
  assert.equal(readResetToken({pathname:'/reset-password',search:'',hash:'#from-hash'}),'from-hash');
  assert.equal(readResetToken({pathname:'/',search:'',hash:'#from-hash'}),'');
  assert.equal(readResetToken({pathname:'/reset-password',search:'',hash:''}),'');
});

test('the reset token is captured before popstate routing, and /reset-password is handled first',()=>{
  const boot=appJs.indexOf("window.addEventListener('popstate',renderRoute)");
  const capture=appJs.lastIndexOf('captureResetToken();', boot);
  assert.ok(boot>=0&&capture>=0&&capture<boot,'captureResetToken must run before the popstate listener is attached');
  assert.match(appJs,/captureResetToken\(\);if\(location\.pathname==='\/reset-password'\)\{await refreshMe\(\)/);
  assert.match(appJs,/history\.replaceState\(null,'','\/reset-password'\)/);
});
