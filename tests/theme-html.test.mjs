import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectThemeIntoHtml, themeVarsFromPt, themeStyleTag, serveThemedAsset, DEFAULT_THEME_VARS, THEME_HEX } from '../src/theme-resolve.mjs';
import { presetById } from '../src/theme-presets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(join(root, 'app/public/index.html'), 'utf8');

test('themeVarsFromPt uses Resilience when the PT is missing or colours are blank', () => {
  assert.deepEqual(themeVarsFromPt(null), DEFAULT_THEME_VARS);
  assert.equal(DEFAULT_THEME_VARS.accent, '#ffd43b');
  assert.equal(DEFAULT_THEME_VARS.background, '#ffffff');
  assert.equal(DEFAULT_THEME_VARS.text, '#111111');
  assert.deepEqual(themeVarsFromPt({ accent: '', background: '', foreground: '' }), DEFAULT_THEME_VARS);
});

test('themeVarsFromPt maps a stored preset, including custom unmatched colours', () => {
  const ocean = presetById('ocean');
  const vars = themeVarsFromPt(ocean);
  assert.equal(vars.accent, ocean.accent);
  assert.equal(vars.background, ocean.background);
  assert.equal(vars.text, ocean.text);
  assert.equal(vars.primary, ocean.primary);
  const custom = themeVarsFromPt({ accent: '#cc3300', background: '#ffffff', foreground: '#111111' });
  assert.equal(custom.accent, '#cc3300');
  assert.equal(custom.background, '#ffffff');
  assert.equal(custom.text, '#111111');
});

test('injectThemeIntoHtml puts sanitised CSS variables in the document head', () => {
  const ocean = themeVarsFromPt(presetById('ocean'));
  const html = injectThemeIntoHtml(indexHtml, ocean);
  assert.match(html, /<style id="theme-boot">:root\{/);
  assert.ok(html.includes(`--accent:${ocean.accent}`));
  assert.ok(html.includes(`--bg:${ocean.background}`));
  assert.ok(html.includes(`--fg:${ocean.text}`));
  assert.ok(html.includes(`--primary:${ocean.primary}`));
  assert.ok(html.indexOf('id="theme-boot"') < html.toLowerCase().indexOf('</head>'));
  const again = injectThemeIntoHtml(html, DEFAULT_THEME_VARS);
  assert.equal(again.split('id="theme-boot"').length, 2);
  assert.ok(again.includes('--accent:#ffd43b'));
});

test('themeStyleTag only interpolates hex colours', () => {
  const tag = themeStyleTag(themeVarsFromPt({ accent: 'red;}</style><script>', background: '#0e7490', foreground: '#0c4a6e' }));
  assert.equal(tag.includes('<script'), false);
  assert.ok(tag.includes('--accent:#ffd43b'));
  assert.ok(tag.includes('--bg:#0e7490'));
});

test('app.js applies the theme on dashboard, checkout and settings save, and resets only for admin', () => {
  const appJs = readFileSync(join(root, 'app/public/app.js'), 'utf8');
  assert.ok(appJs.includes('function applyPageTheme('));
  assert.ok(appJs.includes("if(me.role==='admin')resetTheme();else if(me.role==='pt')theme(data.pt);else applyPageTheme();"));
  assert.ok(appJs.includes('applyPageTheme();const b=result.booking'));
  assert.ok(appJs.includes('if(preset)theme(preset);'));
  assert.equal(appJs.includes('resetTheme();const data=await api(\'/api/dashboard\')'), false);
  assert.equal(appJs.includes('resetTheme();const b=result.booking'), false);
  assert.ok(appJs.includes('data-action="theme-preset"'));
});

test('THEME_HEX is a fully anchored 6-digit pattern', () => {
  assert.equal(THEME_HEX.source, '^#[0-9a-f]{6}$');
  assert.ok(THEME_HEX.ignoreCase);
  assert.equal(THEME_HEX.test('#0e7490'), true);
  assert.equal(THEME_HEX.test('#0E7490'), true);
  assert.equal(THEME_HEX.test('#123'), false);
  assert.equal(THEME_HEX.test('#1234567'), false);
  assert.equal(THEME_HEX.test(' #0e7490'), false);
  assert.equal(THEME_HEX.test('#0e7490 '), false);
  assert.equal(THEME_HEX.test('#0e7490;'), false);
});

test('themeVarsFromPt and themeStyleTag reject breakout and injection strings', () => {
  const cases = [
    '#123456;}</style><script>alert(1)</script>',
    '#123456;}</style><script>',
    'red;}body{background:red',
    'url(javascript:alert(1))',
    'expression(alert(1))',
    '#123456\n#ffffff',
    '#123',
    '#1234567',
    '#12345',
    '123456',
    '##123456',
    '#gggggg'
  ];
  for (const accent of cases) {
    const vars = themeVarsFromPt({ accent, background: '#ffffff', foreground: '#111111' });
    assert.equal(vars.accent, DEFAULT_THEME_VARS.accent, accent);
    const tag = themeStyleTag(vars);
    assert.equal(tag.includes('<script'), false, accent);
    assert.equal(tag.includes(accent), false, accent);
    assert.ok(THEME_HEX.test(vars.accent));
  }
});

test('serveThemedAsset passes 304 and non-200 HTML through without a body and without crashing', async () => {
  const headers = { 'content-type': 'text/html; charset=utf-8', etag: '"abc"', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' };
  const asset = new Response(null, { status: 304, statusText: 'Not Modified', headers });
  const request = new Request('https://example.test/');
  const out = await serveThemedAsset(asset, request, {}, { 'Cache-Control': 'no-store' });
  assert.equal(out.status, 304);
  assert.equal(out.headers.get('etag'), '"abc"');
  assert.equal(out.headers.get('last-modified'), 'Wed, 21 Oct 2015 07:28:00 GMT');
  assert.equal(await out.text(), '');
});

test('serveThemedAsset leaves non-HTML 200 responses untouched', async () => {
  const body = 'const n=1;';
  const asset = new Response(body, { status: 200, headers: { 'content-type': 'application/javascript', etag: '"js1"' } });
  const out = await serveThemedAsset(asset, new Request('https://example.test/app.js'), {}, { 'Cache-Control': 'no-store' });
  assert.equal(out.status, 200);
  assert.equal(out.headers.get('etag'), '"js1"');
  assert.equal(await out.text(), body);
  // Re-run against a fresh asset; the first read consumed the body.
  const again = await serveThemedAsset(new Response(body, { status: 200, headers: { 'content-type': 'application/javascript', etag: '"js1"' } }), new Request('https://example.test/app.js'), {}, {});
  assert.equal((await again.text()).includes('theme-boot'), false);
});

test('app.js does not apply a cached site payload over server theme-boot', () => {
  const appJs = readFileSync(join(root, 'app/public/app.js'), 'utf8');
  assert.ok(appJs.includes("fetch('/api/public/site',{cache:'no-store'"));
  assert.ok(appJs.includes("function applyLandingTheme(){if(document.getElementById('theme-boot'))return;"));
  assert.ok(appJs.includes("if(!fromPt&&document.getElementById('theme-boot'))return;"));
});
