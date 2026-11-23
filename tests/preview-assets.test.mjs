import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entrySrc = readFileSync(join(root, 'docs/rc-4/preview/entry.mjs'), 'utf8');
const genSrc = readFileSync(join(root, 'docs/rc-4/preview/gen-upload.mjs'), 'utf8');

// Workers treat .txt (and .b64.txt) imports as text modules; Node does not.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.txt')) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(source)};` };
    }
    return nextLoad(url, context);
  }
});

const TEXT = {
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/styles.css': 'styles.css',
  '/sitemap.xml': 'sitemap.xml'
};
const BINARY = {
  '/fonts/sora-latin-wght.woff2': ['fonts/sora-latin-wght.woff2', 'font/woff2', 'public, max-age=31536000, immutable'],
  '/images/hero.webp': ['images/hero.webp', 'image/webp', 'public, max-age=86400'],
  '/images/booking-hero.webp': ['images/booking-hero.webp', 'image/webp', 'public, max-age=86400'],
  '/images/class-strength.webp': ['images/class-strength.webp', 'image/webp', 'public, max-age=86400'],
  '/images/class-conditioning.webp': ['images/class-conditioning.webp', 'image/webp', 'public, max-age=86400'],
  '/images/empty-classes.webp': ['images/empty-classes.webp', 'image/webp', 'public, max-age=86400'],
  '/images/empty-bookings.webp': ['images/empty-bookings.webp', 'image/webp', 'public, max-age=86400'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon', 'public, max-age=86400'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png', 'public, max-age=86400']
};

async function loadPreviewEntry() {
  const dir = mkdtempSync(join(tmpdir(), 'rc28-preview-assets-'));
  writeFileSync(join(dir, 'index.js'), `export class Writer {}
export default {
  scheduled(){},
  async fetch(request, env, ctx){
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'This action is not available.' }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      });
    }
    const res = await env.ASSETS.fetch(request, env, ctx);
    const out = new Response(res.body, res);
    out.headers.set('cache-control', 'no-store');
    return out;
  }
};
`);
  mkdirSync(join(dir, 'public/fonts'), { recursive: true });
  mkdirSync(join(dir, 'public/images'), { recursive: true });
  for (const file of Object.values(TEXT)) {
    writeFileSync(join(dir, 'public', file + '.txt'), readFileSync(join(root, 'app/public', file)));
  }
  for (const [file] of Object.values(BINARY)) {
    const dest = join(dir, 'public', file + '.b64.txt');
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(root, 'app/public', file)).toString('base64'));
  }
  writeFileSync(join(dir, 'entry.mjs'), entrySrc);
  return import(pathToFileURL(join(dir, 'entry.mjs')).href);
}

async function get(mod, path, method = 'GET') {
  return mod.default.fetch(new Request('https://resiliencecoaching-preview.example' + path, { method }), {}, {});
}

test('gen-upload and the preview entry both list the font and image modules', () => {
  for (const file of Object.values(BINARY).map(([f]) => f)) {
    assert.ok(entrySrc.includes(`./public/${file}.b64.txt`), 'entry missing import for ' + file);
    assert.ok(genSrc.includes(file), 'gen-upload missing ' + file);
  }
  assert.ok(entrySrc.includes('./public/sitemap.xml.txt'), 'entry missing sitemap import');
  assert.ok(genSrc.includes('sitemap.xml'), 'gen-upload missing sitemap.xml');
  assert.equal(entrySrc.includes('robots.txt.txt') || genSrc.includes('robots.txt.txt') || genSrc.includes("public/robots.txt"), false, 'production robots.txt must not be inlined into the preview upload');
});

test('preview ASSETS serves /fonts and /images with the right type, body and cache headers', async () => {
  const mod = await loadPreviewEntry();
  let inlined = 0;
  for (const [path, [file, type, cache]] of Object.entries(BINARY)) {
    const raw = readFileSync(join(root, 'app/public', file));
    inlined += Buffer.from(raw.toString('base64')).length;
    const res = await get(mod, path);
    assert.equal(res.status, 200, path + ' status');
    assert.equal(res.headers.get('content-type'), type, path + ' type');
    assert.equal(res.headers.get('cache-control'), cache, path + ' cache');
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.length > 0, path + ' empty body');
    assert.deepEqual(body, raw, path + ' bytes');
    const head = await get(mod, path, 'HEAD');
    assert.equal(head.status, 200, path + ' HEAD status');
    assert.equal(head.headers.get('content-type'), type, path + ' HEAD type');
    assert.equal((await head.arrayBuffer()).byteLength, 0, path + ' HEAD body');
  }
  // ~388 KB of base64 text-module source for the nine binaries (pin 370–395 KB), after
  // inlining favicon.ico and apple-touch-icon.png (the production Open Graph image is not inlined).
  assert.ok(inlined > 370 * 1024 && inlined < 395 * 1024, 'unexpected inlined size ' + inlined);
  console.log('preview inlined binary text modules:', (inlined / 1024).toFixed(1), 'KB');
});

test('preview ASSETS still serves known text assets and unknown paths as the HTML shell', async () => {
  const mod = await loadPreviewEntry();
  const html = readFileSync(join(root, 'app/public/index.html'));
  for (const path of ['/', '/index.html', '/no-such-page', '/fonts/missing.woff2', '/images/not-there.webp']) {
    const res = await get(mod, path);
    assert.equal(res.status, 200, path + ' status');
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8', path + ' type');
    assert.equal(res.headers.get('cache-control'), 'no-store', path + ' cache');
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.length > 0, path + ' empty body');
    assert.deepEqual(body, html, path + ' should be the index shell');
  }
  const js = await get(mod, '/app.js');
  assert.equal(js.headers.get('content-type'), 'application/javascript; charset=utf-8');
  assert.deepEqual(Buffer.from(await js.arrayBuffer()), readFileSync(join(root, 'app/public/app.js')));
  const css = await get(mod, '/styles.css');
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(css.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await css.arrayBuffer()), readFileSync(join(root, 'app/public/styles.css')));
  const sitemap = await get(mod, '/sitemap.xml');
  assert.equal(sitemap.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.equal(sitemap.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await sitemap.arrayBuffer()), readFileSync(join(root, 'app/public/sitemap.xml')));
});

test('preview entry serves robots.txt and X-Robots-Tag noindex on every response', async () => {
  assert.ok(entrySrc.includes("docs/rc-4/preview/entry.mjs") || entrySrc.includes('preview-upload entry') || entrySrc.includes('Preview-only noindex'), 'entry should document preview-only scope');
  assert.ok(!readFileSync(join(root, 'worker/index.mjs'), 'utf8').includes('X-Robots-Tag'), 'noindex must not live in the shared Worker');
  const mod = await loadPreviewEntry();
  const robots = await get(mod, '/robots.txt');
  assert.equal(robots.status, 200);
  assert.equal(robots.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(robots.headers.get('cache-control'), 'no-store');
  assert.equal(robots.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(await robots.text(), 'User-agent: *\nDisallow: /');
  const robotsHead = await get(mod, '/robots.txt', 'HEAD');
  assert.equal(robotsHead.status, 200);
  assert.equal(robotsHead.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal((await robotsHead.arrayBuffer()).byteLength, 0);
  for (const [path, status, typePrefix] of [
    ['/', 200, 'text/html'],
    ['/fonts/sora-latin-wght.woff2', 200, 'font/woff2'],
    ['/images/hero.webp', 200, 'image/webp'],
    ['/favicon.ico', 200, 'image/x-icon'],
    ['/apple-touch-icon.png', 200, 'image/png'],
    ['/sitemap.xml', 200, 'application/xml'],
    ['/app.js', 200, 'application/javascript'],
    ['/no-such-page', 200, 'text/html'],
    ['/api/not-a-real-route', 404, 'application/json']
  ]) {
    const res = await get(mod, path);
    assert.equal(res.status, status, path + ' status');
    assert.equal((res.headers.get('content-type') || '').startsWith(typePrefix), true, path + ' type ' + res.headers.get('content-type'));
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', path + ' robots tag');
    await res.arrayBuffer();
  }
});

test('preview entry restores font and image cache after Worker security headers', async () => {
  const mod = await loadPreviewEntry();
  const font = await get(mod, '/fonts/sora-latin-wght.woff2');
  assert.equal(font.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const image = await get(mod, '/images/hero.webp');
  assert.equal(image.headers.get('cache-control'), 'public, max-age=86400');
  const favicon = await get(mod, '/favicon.ico');
  assert.equal(favicon.headers.get('cache-control'), 'public, max-age=86400');
  const apple = await get(mod, '/apple-touch-icon.png');
  assert.equal(apple.headers.get('cache-control'), 'public, max-age=86400');
  const sitemap = await get(mod, '/sitemap.xml');
  assert.equal(sitemap.headers.get('cache-control'), 'no-store');
  const html = await get(mod, '/');
  assert.equal(html.headers.get('cache-control'), 'no-store');
  const js = await get(mod, '/app.js');
  assert.equal(js.headers.get('cache-control'), 'no-store');
  const css = await get(mod, '/styles.css');
  assert.equal(css.headers.get('cache-control'), 'no-store');
  const robots = await get(mod, '/robots.txt');
  assert.equal(robots.headers.get('cache-control'), 'no-store');
  const missing = await get(mod, '/fonts/missing.woff2');
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  const api = await get(mod, '/api/not-a-real-route');
  assert.equal(api.status, 404);
  assert.equal(api.headers.get('cache-control'), 'no-store');
  await font.arrayBuffer(); await image.arrayBuffer(); await favicon.arrayBuffer(); await apple.arrayBuffer(); await sitemap.arrayBuffer(); await html.arrayBuffer(); await js.arrayBuffer(); await css.arrayBuffer(); await robots.arrayBuffer(); await missing.arrayBuffer(); await api.arrayBuffer();
});
