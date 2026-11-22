import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

test('production robots.txt allows indexing and points at the canonical sitemap', () => {
  const robots = read('app/public/robots.txt');
  assert.match(robots, /Canonical origin: https:\/\/resiliencecoaching\.app/);
  assert.match(robots, /User-agent: \*\nAllow: \//);
  assert.match(robots, /Sitemap: https:\/\/resiliencecoaching\.app\/sitemap\.xml/);
  assert.equal(robots.includes('Disallow: /'), false);
});

test('sitemap.xml lists the public marketing and policy URLs on the canonical origin', () => {
  const sitemap = read('app/public/sitemap.xml');
  for (const path of ['/', '/terms', '/privacy', '/refunds', '/contact']) {
    assert.ok(sitemap.includes(`<loc>https://resiliencecoaching.app${path === '/' ? '/' : path}</loc>`), path);
  }
});

test('index.html has canonical, OG, Twitter, favicon and apple-touch tags', () => {
  const html = read('app/public/index.html');
  for (const snippet of [
    'rel="canonical" href="https://resiliencecoaching.app/"',
    'rel="icon" href="/favicon.ico"',
    'rel="apple-touch-icon" href="/apple-touch-icon.png"',
    'property="og:title"',
    'property="og:image" content="https://resiliencecoaching.app/images/og.jpg"',
    'property="og:image:width" content="1200"',
    'property="og:image:height" content="630"',
    'name="twitter:card" content="summary_large_image"',
    'name="twitter:image" content="https://resiliencecoaching.app/images/og.jpg"'
  ]) assert.ok(html.includes(snippet), 'missing ' + snippet);
});

test('favicon, apple-touch icon and og image exist at the expected sizes', async () => {
  assert.ok(existsSync(join(root, 'app/public/favicon.ico')));
  // Dynamic import so node:test can still load if sharp/PIL aren't used.
  const png = readFileSync(join(root, 'app/public/apple-touch-icon.png'));
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), 180);
  assert.equal(png.readUInt32BE(20), 180);
  const jpg = readFileSync(join(root, 'app/public/images/og.jpg'));
  assert.equal(jpg[0], 0xff);
  assert.equal(jpg[1], 0xd8);
  // SOF0/2 scan for 1200x630
  let w = 0, h = 0;
  let i = 2;
  while (i < jpg.length - 8) {
    if (jpg[i] !== 0xff) { i += 1; continue; }
    const marker = jpg[i + 1];
    if (marker === 0xc0 || marker === 0xc2) {
      h = jpg.readUInt16BE(i + 5);
      w = jpg.readUInt16BE(i + 7);
      break;
    }
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    const len = jpg.readUInt16BE(i + 2);
    i += 2 + len;
  }
  assert.equal(w, 1200);
  assert.equal(h, 630);
});

test('app.js legal pages are marked draft and only interpolate present public profile fields', () => {
  const js = read('app/public/app.js');
  assert.ok(js.includes('DRAFT for Kieran\'s review, not legal advice.'));
  for (const name of ['business_name', 'display_name', 'contact_email', 'contact_phone', 'venue_name', 'venue_address', 'cancellation_window_hours']) {
    assert.ok(js.includes(name), 'missing field ' + name);
  }
  assert.ok(js.includes('presentField(pt?.display_name)||presentField(pt?.brand_name)'));
  assert.ok(js.includes("[The cancellation window will be shown here once it is set in the trainer's settings.]"));
  assert.ok(js.includes('[TODO: Contact details will appear here once the trainer has added them in their settings.]'));
  assert.ok(js.includes('UK GDPR'));
  assert.ok(js.includes('Data Protection Act 2018'));
  assert.ok(js.includes('Consumer Contracts (Information, Cancellation and Additional Charges) Regulations 2013'));
  assert.ok(js.includes('aria-label="Policies and contact"'));
  assert.ok(js.includes('Read the <a href="/terms" data-route>terms</a> and <a href="/privacy" data-route>privacy policy</a>.'));
  assert.ok(js.includes("if(path==='/terms'||path==='/privacy'||path==='/refunds'||path==='/contact')"));
});

test('preview entry still serves Disallow-all robots and the Worker stays without X-Robots-Tag', () => {
  const entry = read('docs/rc-4/preview/entry.mjs');
  const worker = read('worker/index.mjs');
  assert.ok(entry.includes("const ROBOTS_TXT = 'User-agent: *\\nDisallow: /'"));
  assert.equal(entry.includes('app/public/robots.txt'), false);
  assert.equal(worker.includes('X-Robots-Tag'), false);
  assert.equal(worker.includes('robots.txt'), false);
});
