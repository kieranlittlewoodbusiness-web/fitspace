import test from 'node:test';
import assert from 'node:assert/strict';
import { theme, colours, accentInk, THEME_DEFAULTS, branding } from '../src/validate.mjs';

const defaults = { accent: '#ffd43b', background: '#ffffff', foreground: '#111111' };

const fail = (body) => {
  try {
    theme(body);
    throw new Error('expected theme() to throw');
  } catch (error) {
    if (error.message === 'expected theme() to throw') throw error;
    return error;
  }
};

test('theme accepts the default yellow/black and normalises hex case', () => {
  assert.deepEqual(theme({ ...defaults }), defaults);
  assert.deepEqual(theme({ accent: '#FFD43B', background: '#FFFFFF', foreground: '#111111' }), defaults);
  assert.equal(colours(defaults.background, defaults.foreground) >= 4.5, true);
  assert.equal(colours(defaults.accent, accentInk(defaults.accent)) >= 4.5, true);
  assert.equal(accentInk(defaults.accent), '#000000');
  assert.deepEqual(THEME_DEFAULTS, defaults);
});

test('theme reset:true returns the default yellow/black', () => {
  assert.deepEqual(theme({ reset: true }), defaults);
  assert.deepEqual(theme({ reset: true, accent: '#000000' }), defaults);
});

test('theme rejects invalid hex', () => {
  const cases = [
    {},
    { accent: '#ffd43b', background: '#ffffff' },
    { accent: '#fff', background: '#ffffff', foreground: '#111111' },
    { accent: 'ffd43b', background: '#ffffff', foreground: '#111111' },
    { accent: '#FFD43BFF', background: '#ffffff', foreground: '#111111' },
    { accent: '#gggggg', background: '#ffffff', foreground: '#111111' },
    null,
    'reset'
  ];
  for (const body of cases) {
    const error = fail(body);
    assert.equal(error.status, 400, JSON.stringify(body));
    assert.equal(error.message, 'Choose valid six-digit colours.');
  }
});

test('theme rejects text and background combinations below 4.5:1', () => {
  const error = fail({ accent: '#ffd43b', background: '#ffffff', foreground: '#eeeeee' });
  assert.equal(error.status, 400);
  assert.equal(error.message, 'Choose text and background colours with clearer contrast.');
  assert.ok(colours('#ffffff', '#eeeeee') < 4.5);
});

test('theme checks accent against accentInk at 4.5:1 in the same style as branding', () => {
  assert.equal(typeof accentInk, 'function');
  assert.equal(accentInk('#111111'), '#ffffff');
  assert.ok(colours('#ffd43b', '#000000') >= 4.5);
  // The auto ink is chosen so typical #rrggbb values meet 4.5:1; the check still runs.
  const ok = theme({ accent: '#000000', background: '#ffffff', foreground: '#111111' });
  assert.equal(ok.accent, '#000000');
  assert.equal(colours(ok.accent, accentInk(ok.accent)) >= 4.5, true);
});

test('theme rejects slug, copy and published fields', () => {
  const extras = [
    { reset: true, slug: 'local-coach' },
    { ...defaults, published: true },
    { ...defaults, brand_name: 'Club' },
    { ...defaults, tagline: 'A headline that is long enough.' },
    { ...defaults, description: 'An introduction that is long enough.' },
    { ...defaults, about: 'Training information that is long enough.' },
    { ...defaults, features: ['Coached training'] }
  ];
  for (const body of extras) {
    const error = fail(body);
    assert.equal(error.status, 400, JSON.stringify(body));
    assert.equal(error.message, 'Theme settings only accept colours.');
  }
});

test('theme does not replace branding() for admin copy updates', () => {
  const branded = branding({
    slug: 'local-coach',
    brand_name: 'Local Coach',
    tagline: 'Train with purpose and confidence.',
    description: 'Supportive fitness sessions for all abilities.',
    about: 'Small groups and personalised training support.',
    accent: '#ffd43b',
    background: '#ffffff',
    foreground: '#111111',
    features: ['Coached training'],
    published: true
  });
  assert.equal(branded.slug, 'local-coach');
  assert.equal(branded.published, 1);
});
