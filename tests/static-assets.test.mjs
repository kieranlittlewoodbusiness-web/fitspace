import test from 'node:test';
import assert from 'node:assert/strict';

const { createHandler } = await import(process.env.FITSPACE_TEST_BUNDLED ? '../.netlify/verified-functions/platform/netlify/functions/platform.mjs' : '../netlify/functions/platform.mjs');
const handler = createHandler();
const origin = 'https://static-assets.test';

const PUBLIC_STATIC = [
  ['/app.js', 'text/javascript'],
  ['/styles.css', 'text/css'],
  ['/fonts/sora-latin-wght.woff2', 'font/woff2', 'public, max-age=31536000, immutable'],
  ['/images/hero.webp', 'image/webp', 'public, max-age=86400'],
  ['/images/booking-hero.webp', 'image/webp', 'public, max-age=86400'],
  ['/images/class-strength.webp', 'image/webp', 'public, max-age=86400'],
  ['/images/class-conditioning.webp', 'image/webp', 'public, max-age=86400'],
  ['/images/empty-classes.webp', 'image/webp', 'public, max-age=86400'],
  ['/images/empty-bookings.webp', 'image/webp', 'public, max-age=86400']
];

async function get(path) {
  return handler(new Request(origin + path));
}

test('Netlify serves the exact public static allowlist with per-type cache headers', async () => {
  for (const [path, type, cache] of PUBLIC_STATIC) {
    const res = await get(path);
    assert.equal(res.status, 200, path + ' status');
    assert.ok((res.headers.get('content-type') || '').includes(type), path + ' type');
    if (cache) assert.equal(res.headers.get('cache-control'), cache, path + ' cache');
    else assert.equal(res.headers.get('cache-control'), 'no-store', path + ' default cache');
    assert.ok((await res.arrayBuffer()).byteLength > 0, path + ' empty');
  }
  const html = await (await get('/')).text();
  for (const path of ['/IMAGES/hero.webp', '/FONTS/sora-latin-wght.woff2']) {
    const res = await get(path);
    assert.equal(res.status, 200, path + ' status');
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.equal(await res.text(), html);
  }
  for (const path of ['/images/not-a-real-image.webp', '/fonts/missing.woff2', '/fonts/OFL.txt']) {
    const res = await get(path);
    assert.equal(res.status, 404, path + ' should 404');
  }
  for (const path of ['/images/%2fsecret.webp', '/fonts/%5csecret.woff2', '/images/..%2fapp.js', '/images/%2e%2e%2fapp.js']) {
    const res = await get(path);
    assert.equal(res.status, 404, path + ' should 404');
  }
  for (const path of ['/images/../etc/passwd', '/fonts/%2e%2e/%2e%2e/package.json', '/images/%2e%2e/%2e%2e/package.json']) {
    const res = await get(path);
    assert.equal(res.status, 200, path + ' status');
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.equal(await res.text(), html);
  }
});
