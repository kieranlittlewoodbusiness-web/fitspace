// RC-4 preview upload entry (docs §13). The Cloudflare connector cannot run the static-assets
// direct-upload step (it needs the upload-session JWT as its bearer, and the connector always
// sends its own credentials), so the preview upload ships app/public as Text modules and this
// wrapper gives the unchanged Worker an env.ASSETS with the same behaviour as wrangler.jsonc's
// assets config: exact file, "/" -> index.html, otherwise index.html (single-page-application).
// Production keeps the real assets binding via `wrangler deploy`.
import worker, { Writer } from './index.js';
import indexHtml from './public/index.html.txt';
import appJs from './public/app.js.txt';
import stylesCss from './public/styles.css.txt';
export { Writer };
const FILES = {
  '/index.html': [indexHtml, 'text/html; charset=utf-8'],
  '/app.js': [appJs, 'application/javascript; charset=utf-8'],
  '/styles.css': [stylesCss, 'text/css; charset=utf-8']
};
const ASSETS = {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const [body, type] = FILES[path === '/' ? '/index.html' : path] || FILES['/index.html'];
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: { 'content-type': type, 'cache-control': 'no-cache' } });
  }
};
export default {
  scheduled: (controller, env, ctx) => worker.scheduled(controller, env, ctx),
  fetch: (request, env, ctx) => worker.fetch(request, { ...env, ASSETS }, ctx)
};
