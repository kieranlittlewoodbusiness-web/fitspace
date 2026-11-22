import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  THEME_PRESETS, DEFAULT_THEME_ID, CUSTOM_THEME_ID, accentInk, contrastRatios, resolveThemeId, presetById, themeIdFromBody, colours
} from '../src/theme-presets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('there are 8–10 theme presets and the default is Resilience yellow/black', () => {
  assert.ok(THEME_PRESETS.length >= 8 && THEME_PRESETS.length <= 10);
  assert.equal(DEFAULT_THEME_ID, 'resilience');
  const resilience = presetById('resilience');
  assert.deepEqual(resilience, {
    id: 'resilience',
    name: 'Resilience',
    primary: '#111111',
    accent: '#ffd43b',
    background: '#ffffff',
    text: '#111111'
  });
  assert.equal(accentInk(resilience.accent), '#000000');
  assert.equal(accentInk(resilience.primary), '#ffffff');
});

test('every preset meets WCAG AA 4.5:1 for body text, buttons and links', () => {
  const ids = new Set();
  const triples = new Set();
  const rows = [];
  for (const preset of THEME_PRESETS) {
    assert.equal(ids.has(preset.id), false, 'duplicate id ' + preset.id);
    ids.add(preset.id);
    const key = [preset.accent, preset.background, preset.text].join(' ').toLowerCase();
    assert.equal(triples.has(key), false, 'duplicate colour triple ' + preset.id);
    triples.add(key);
    const ratios = contrastRatios(preset);
    const checks = {
      'body text on background': ratios.textOnBackground,
      'button text on primary': ratios.buttonOnPrimary,
      'button text on accent': ratios.buttonOnAccent,
      'links on background': ratios.linksOnBackground
    };
    for (const [label, value] of Object.entries(checks)) {
      assert.ok(value >= 4.5, `${preset.id} ${label} is ${value.toFixed(2)}:1`);
    }
    rows.push({
      id: preset.id,
      text: ratios.textOnBackground.toFixed(2),
      primary: ratios.buttonOnPrimary.toFixed(2),
      accent: ratios.buttonOnAccent.toFixed(2),
      links: ratios.linksOnBackground.toFixed(2)
    });
  }
  console.log('theme contrast (AA 4.5:1)', rows);
});

test('resolveThemeId matches stored colours, returns custom when unmatched, and falls back to resilience when empty', () => {
  assert.equal(CUSTOM_THEME_ID, 'custom');
  assert.equal(resolveThemeId({ accent: '#FFD43B', background: '#FFFFFF', foreground: '#111111' }), 'resilience');
  assert.equal(resolveThemeId(presetById('night')), 'night');
  assert.equal(resolveThemeId({ accent: '#cc3300', background: '#ffffff', foreground: '#111111' }), 'custom');
  assert.equal(resolveThemeId({}), 'resilience');
  assert.equal(resolveThemeId({ accent: '', background: '  ', foreground: null }), 'resilience');
});

test('themeIdFromBody accepts custom as a no-op id and still rejects unknown ids', () => {
  assert.equal(themeIdFromBody({ id: 'Custom' }), 'custom');
  assert.equal(themeIdFromBody({ id: 'custom' }), 'custom');
});

test('themeIdFromBody accepts only allowlisted ids', () => {
  assert.equal(themeIdFromBody({ id: 'Ocean' }), 'ocean');
  const fail = (body) => {
    try { themeIdFromBody(body); throw new Error('expected throw'); }
    catch (error) { if (error.message === 'expected throw') throw error; return error; }
  };
  for (const body of [null, 'resilience', { id: 'not-a-theme' }, { id: '' }, {}]) {
    const error = fail(body);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.equal(error.message, 'Choose a theme from the list.');
  }
});

test('presetById and themeIdFromBody reject prototype keys and non-string ids', () => {
  for (const id of ['__proto__', 'constructor', 'prototype', ['night'], { id: 'night' }, 0, null, undefined]) {
    assert.equal(presetById(id), null);
  }
  assert.ok(presetById('resilience'));
  const fail = (body) => {
    try { themeIdFromBody(body); throw new Error('expected throw'); }
    catch (error) { if (error.message === 'expected throw') throw error; return error; }
  };
  for (const body of [
    { id: '__proto__' },
    { id: 'constructor' },
    { id: 'prototype' },
    { id: 1 },
    { id: ['night'] },
    { id: { toString: () => 'night' } }
  ]) {
    const error = fail(body);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.equal(error.message, 'Choose a theme from the list.');
  }
});

test('app.js ships the same preset ids and colours as the shared allowlist', () => {
  const appJs = readFileSync(join(root, 'app/public/app.js'), 'utf8');
  const start = appJs.indexOf('const THEME_PRESETS=');
  const end = appJs.indexOf(']);', start);
  assert.ok(start >= 0 && end > start);
  const client = Function('"use strict"; ' + appJs.slice(start, end + 3) + '; return THEME_PRESETS;')();
  assert.deepEqual(
    client.map(p => ({ id: p.id, name: p.name, primary: p.primary, accent: p.accent, background: p.background, text: p.text })),
    THEME_PRESETS.map(p => ({ id: p.id, name: p.name, primary: p.primary, accent: p.accent, background: p.background, text: p.text }))
  );
  assert.ok(appJs.includes('if(!isMultiPt()&&site?.pt)theme(site.pt);else resetTheme();'));
  assert.ok(appJs.includes('applyLandingTheme();'));
  assert.ok(appJs.includes('for="themePreset">Theme'));
  assert.ok(appJs.includes('<select id="themePreset" name="theme-preset">'));
  assert.ok(appJs.includes('class="theme-swatch-preview"'));
  assert.ok(appJs.includes('Custom (current)'));
  assert.ok(appJs.includes("if(picked.value==='custom')"));
  assert.ok(appJs.includes("api('/api/pt/theme',{method:'PUT'"));
  assert.ok(appJs.includes("me.role==='pt'?profileForm()+themeSettings()"));
  assert.equal(appJs.includes('<label for="theme-accent">Accent'), false);
  // Admin branding still has its own colour presets; PT settings must not add a free picker.
  const themeFn = appJs.slice(appJs.indexOf('function themeSettings()'), appJs.indexOf('async function saveTheme'));
  assert.equal(themeFn.includes('type="color"'), false);
  assert.equal(themeFn.includes('type="radio"'), false);
  assert.equal(themeFn.includes('role="radiogroup"'), false);
});

test('colours helper still reports the Resilience text/background ratio above 4.5', () => {
  assert.ok(colours('#ffffff', '#111111') >= 4.5);
});
