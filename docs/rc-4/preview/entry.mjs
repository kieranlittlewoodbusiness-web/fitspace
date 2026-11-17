// RC-4 preview upload entry (docs §13). The Cloudflare connector cannot run the static-assets
// direct-upload step (it needs the upload-session JWT as its bearer, and the connector always
// sends its own credentials), so the preview upload ships app/public as Text modules and this
// wrapper gives the unchanged Worker an env.ASSETS with the same behaviour as wrangler.jsonc's
// assets config: exact file, "/" -> index.html, otherwise index.html (single-page-application).
// Production keeps the real assets binding via `wrangler deploy`.
// RC-28: fonts and images are shipped as base64 text modules (~408 KB of module source) and
// decoded here so /fonts/* and /images/* are served with the correct types.
import worker, { Writer } from './index.js';
import indexHtml from './public/index.html.txt';
import appJs from './public/app.js.txt';
import stylesCss from './public/styles.css.txt';
import soraWoff2 from './public/fonts/sora-latin-wght.woff2.b64.txt';
import heroWebp from './public/images/hero.webp.b64.txt';
import bookingHeroWebp from './public/images/booking-hero.webp.b64.txt';
import classStrengthWebp from './public/images/class-strength.webp.b64.txt';
import classConditioningWebp from './public/images/class-conditioning.webp.b64.txt';
import emptyClassesWebp from './public/images/empty-classes.webp.b64.txt';
import emptyBookingsWebp from './public/images/empty-bookings.webp.b64.txt';
export { Writer };
const bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const FILES = {
  '/index.html': [indexHtml, 'text/html; charset=utf-8', 'no-cache'],
  '/app.js': [appJs, 'application/javascript; charset=utf-8', 'no-cache'],
  '/styles.css': [stylesCss, 'text/css; charset=utf-8', 'no-cache'],
  '/fonts/sora-latin-wght.woff2': [bytes(soraWoff2), 'font/woff2', 'public, max-age=31536000, immutable'],
  '/images/hero.webp': [bytes(heroWebp), 'image/webp', 'public, max-age=86400'],
  '/images/booking-hero.webp': [bytes(bookingHeroWebp), 'image/webp', 'public, max-age=86400'],
  '/images/class-strength.webp': [bytes(classStrengthWebp), 'image/webp', 'public, max-age=86400'],
  '/images/class-conditioning.webp': [bytes(classConditioningWebp), 'image/webp', 'public, max-age=86400'],
  '/images/empty-classes.webp': [bytes(emptyClassesWebp), 'image/webp', 'public, max-age=86400'],
  '/images/empty-bookings.webp': [bytes(emptyBookingsWebp), 'image/webp', 'public, max-age=86400']
};
const ASSETS = {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const [body, type, cache] = FILES[path === '/' ? '/index.html' : path] || FILES['/index.html'];
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: { 'content-type': type, 'cache-control': cache } });
  }
};
export default {
  scheduled: (controller, env, ctx) => worker.scheduled(controller, env, ctx),
  fetch: (request, env, ctx) => worker.fetch(request, { ...env, ASSETS }, ctx)
};
