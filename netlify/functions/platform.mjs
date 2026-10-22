import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { databasePool, ensureSchema, checkLimit, withSnapshot } from '../../lib/storage.mjs';
import { boundedBody, runApp, securityHeaders, failure } from '../../lib/bridge.mjs';
import crypto from 'node:crypto';

// Deliberate test-only transport. The original local server retains its optional
// Stripe sandbox integration; this deployment cannot take money or send email.
process.env.PAYMENT_MODE = 'demo';
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
      if (url.pathname === '/api/stripe/webhook' || url.pathname.startsWith('/api/pt/stripe/')) {
        return failure('Stripe is disabled in this Netlify preview. Checkout uses simulated payments.', 503, true);
      }
      if (!json) {
        if (!['GET', 'HEAD'].includes(request.method)) return failure('Method not allowed.', 405);
        const asset = url.pathname === '/app.js' ? ['app.js', 'text/javascript'] : url.pathname === '/styles.css' ? ['styles.css', 'text/css'] : ['index.html', 'text/html'];
        const bytes = await readFile(`${runtimeRoot}/app/public/${asset[0]}`);
        return new Response(request.method === 'HEAD' ? null : bytes, { headers: { ...securityHeaders, 'Content-Type': asset[1] + '; charset=utf-8' } });
      }
      const body = await boundedBody(request);
      const { pool, ready } = getStorage();
      await ready;
      if (request.method === 'POST' && ['/api/auth/login', '/api/auth/signup'].includes(url.pathname)) {
        await checkLimit(pool, namespace + ':' + url.pathname + ':' + crypto.createHash('sha256').update(context.ip || 'unknown').digest('hex'), 15);
      }
      return await withSnapshot(pool, namespace, async dbPath => {
        const app = createApp({ dbPath, demo: false, origin, paymentMode: 'demo', startEmailWorker: false, initialise: require(`${runtimeRoot}/app/public-mode.cjs`).initialise });
        try {
          return await runApp(app.handler, request, body, context.ip);
        } finally {
          app.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          app.db.close();
        }
      });
    } catch (error) {
      if (error.status) return failure(error.message, error.status, json);
      // Do not expose database URLs, SQL details, passwords or stack traces.
      console.error('FITSPACE request failed:', error.code || error.name || 'Error');
      return failure('The preview could not save or load its data. Check DATABASE_URL, Node 24 and the function logs, then try again.', 503, json);
    }
  };
}
export default createHandler();
