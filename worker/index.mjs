// RC-1 spike Worker entry: a thin adapter around netlify/functions/platform.mjs.
// platform.mjs is NOT edited. The adapter:
//   1. serves app/public via Workers Static Assets and adds the app's security headers;
//   2. routes /api/* to platform.mjs's own createHandler();
//   3. injects a per-request pg pool (Workers forbid reusing a socket across requests);
//   4. routes /__spike/* to isolated runtime probes (spike only).
// wrangler.jsonc supplies LAMBDA_TASK_ROOT=/bundle, an import.meta.url define, and uploads
// app/*.cjs as CommonJS modules so platform.mjs's runtime require() calls can resolve.
import { createHandler } from '../netlify/functions/platform.mjs';
import { databasePool, ensureSchema } from '../lib/storage.mjs';
import { securityHeaders } from '../lib/bridge.mjs';
import { handleProbe } from './probes.mjs';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Probes are spike-only and answer only on a local wrangler dev host.
    if (url.pathname.startsWith('/__spike/')) {
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return new Response('Not found.', { status: 404, headers: securityHeaders });
      return handleProbe(request);
    }
    if (url.pathname.startsWith('/api/')) {
      const pools = [];
      const handler = createHandler({
        getStorage() {
          const pool = databasePool(process.env.DATABASE_URL);
          pools.push(pool);
          return { pool, ready: ensureSchema(pool) };
        }
      });
      try {
        return await handler(request, { ip: request.headers.get('CF-Connecting-IP') || 'unknown' });
      } finally {
        ctx.waitUntil(Promise.all(pools.map(p => p.end().catch(() => {}))));
      }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed.', { status: 405, headers: securityHeaders });
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, value);
    return response;
  }
};
