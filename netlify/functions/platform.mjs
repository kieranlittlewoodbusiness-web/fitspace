import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { databasePool, ensureSchema, checkLimit, withSnapshot } from '../../lib/storage.mjs';
import { boundedBody, runApp, securityHeaders, failure } from '../../lib/bridge.mjs';
import crypto from 'node:crypto';

// Explicit demo, sandbox or live mode. Email remains preview-only.
process.env.EMAIL_MODE = 'preview';
const sourceRoot = new URL('../../', import.meta.url);
// Resolve kept source files from the project root at runtime, rather than
// relying on esbuild's rewritten __dirname for CommonJS modules.
const runtimeRoot = process.env.LAMBDA_TASK_ROOT || fileURLToPath(sourceRoot);
const require = createRequire(new URL('../../package.json', import.meta.url));
let appFactory;
function createApp(options) {
  appFactory ||= require(`${runtimeRoot}/app/server.cjs`).createApp;
  return appFactory(options);
}
let pool;
let schema;
function storage() {
  pool ||= databasePool(process.env.DATABASE_URL);
  schema ||= ensureSchema(pool).catch(error => { schema = null; throw error; });
  return { pool, ready: schema };
}

export function createHandler({ getStorage = storage } = {}) {
  return async function handler(request, context = {}) {
    const url = new URL(request.url);
    const json = url.pathname.startsWith('/api/');
    // Origin is the current Netlify URL, never an arbitrary forwarded host.
    const origin = url.origin;
    const namespace = process.env.DATA_NAMESPACE || 'fitspace-public-v4';
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(namespace)) return failure('Set a valid DATA_NAMESPACE.', 503, json);
    try {
      if (!json) {
        if (!['GET', 'HEAD'].includes(request.method)) return failure('Method not allowed.', 405);
        const asset = url.pathname === '/app.js' ? ['app.js', 'text/javascript'] : url.pathname === '/styles.css' ? ['styles.css', 'text/css'] : ['index.html', 'text/html'];
        const bytes = await readFile(`${runtimeRoot}/app/public/${asset[0]}`);
        return new Response(request.method === 'HEAD' ? null : bytes, { headers: { ...securityHeaders, 'Content-Type': asset[1] + '; charset=utf-8' } });
      }
      const paymentMode=process.env.PAYMENT_MODE||'demo';
      if(!['demo','stripe_test','stripe_live'].includes(paymentMode))return failure('Use PAYMENT_MODE=demo, stripe_test or stripe_live.',503,true);
      if(process.env.STRIPE_SECRET_KEY&&!url.pathname.startsWith('/api/auth/'))require(`${runtimeRoot}/app/stripe-mode.cjs`).validate(paymentMode);
      const diagnostic=/^\/api\/(me|auth\/.*|dashboard|admin\/.*|public\/.*)$/.test(url.pathname);
      if(!diagnostic){
        require(`${runtimeRoot}/app/stripe-mode.cjs`).validate(paymentMode);
        if(paymentMode!=='demo'&&(!process.env.STRIPE_WEBHOOK_SECRET||!/^https:\/\/[^/]+(?:\/)?$/.test(process.env.APP_URL||'')))return failure('Set STRIPE_WEBHOOK_SECRET and an HTTPS APP_URL before accepting Stripe payments.',503,true);
      }
      const body = await boundedBody(request,url.pathname==='/api/stripe/webhook'?1048576:65536);
      const { pool, ready } = getStorage();
      await ready;
      if (request.method === 'POST' && ['/api/auth/login', '/api/auth/signup', '/api/auth/forgot-password', '/api/auth/reset-password'].includes(url.pathname)) {
        await checkLimit(pool, namespace + ':' + url.pathname + ':' + crypto.createHash('sha256').update(context.ip || 'unknown').digest('hex'), 15);
      }
      const response=await withSnapshot(pool, namespace, async dbPath => {
        const app = createApp({ dbPath, demo: false, origin, paymentMode, deferStripe:true, startEmailWorker: false, initialise: require(`${runtimeRoot}/app/public-mode.cjs`).initialise });
        try {
          return await runApp(app.handler, request, body, context.ip);
        } finally {
          app.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          app.db.close();
        }
      });
      if(response.status!==202)return response;
      const prepared=await response.clone().json();
      if(prepared.reset_delivery){
        // The reset hash and delivery job have committed before contacting email.
        // Only IDs cross this internal boundary; raw reset links are not API responses.
        try{await withSnapshot(pool,namespace,async dbPath=>{
          const app=createApp({dbPath,demo:false,origin,paymentMode,deferStripe:true,startEmailWorker:false,initialise:require(`${runtimeRoot}/app/public-mode.cjs`).initialise});
          try{await require(`${runtimeRoot}/app/password-reset.cjs`).deliver(app.db,prepared.reset_delivery);return new Response('ok');}
          finally{app.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');app.db.close();}
        },{commitErrors:true});}catch{console.error('FITSPACE authentication email delivery was not confirmed.');}
        return new Response(JSON.stringify(prepared.reset_complete?{ok:true,message:'Your password has been reset. Sign in with your new password.'}:{message:require(`${runtimeRoot}/app/password-reset.cjs`).MESSAGE}),{status:200,headers:{...securityHeaders,'Content-Type':'application/json',...(response.headers.get('set-cookie')?{'Set-Cookie':response.headers.get('set-cookie')}:{})}});
      }
      if(!prepared.stripe_job)return response;
      let jobId=prepared.stripe_job;
      for(let step=0;step<3;step++){
        const result=await withSnapshot(pool,namespace,async dbPath=>{
          const app=createApp({dbPath,demo:false,origin,paymentMode,deferStripe:true,startEmailWorker:false,initialise:require(`${runtimeRoot}/app/public-mode.cjs`).initialise});
          try{const outcome=await require(`${runtimeRoot}/app/payments.cjs`).executeJob(app.db,jobId);return new Response(JSON.stringify(outcome.body),{status:outcome.status,headers:{...securityHeaders,'Content-Type':'application/json'}});}
          finally{app.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');app.db.close();}
        },{commitErrors:true});
        const data=await result.clone().json();
        if(result.status===200&&data.stripe_next){jobId=data.stripe_next;continue;}
        return result;
      }
      return failure('Continue Stripe setup to finish this operation.',503,true);
    } catch (error) {
      if (error.status) return failure(error.message, error.status, json);
      // Do not expose database URLs, SQL details, passwords or stack traces.
      console.error('FITSPACE request failed:', error.code || error.name || 'Error');
      return failure('The preview could not save or load its data. Check DATABASE_URL, Node 24 and the function logs, then try again.', 503, json);
    }
  };
}
export default createHandler();
