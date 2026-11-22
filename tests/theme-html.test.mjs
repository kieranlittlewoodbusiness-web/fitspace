import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectThemeIntoHtml, themeVarsFromPt, themeStyleTag, DEFAULT_THEME_VARS } from '../src/theme-resolve.mjs';
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
