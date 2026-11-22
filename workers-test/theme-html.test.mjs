import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../worker/index.mjs';
import { db, seedBlock, seedUser, getRequest, insertBooking, ORIGIN } from './helpers.mjs';
import { presetById } from '../src/theme-presets.mjs';

const send = (req, e = env) => worker.fetch(req, e);
const overlay = (over = {}) => Object.assign(Object.create(null), env, over);
const single = (over = {}) => overlay({ MULTI_PT_ENABLED: 'false', ...over });
const multi = (over = {}) => overlay({ MULTI_PT_ENABLED: 'true', ...over });

const ocean = presetById('ocean');
const forest = presetById('forest');

async function paintPt(id, preset) {
  await db().run(
    'UPDATE pts SET accent=?,background=?,foreground=? WHERE id=?',
    preset.accent, preset.background, preset.text, id
  );
}

async function onlyPublished(id) {
  await db().run('UPDATE pts SET published=0 WHERE id<>?', id);
  await db().run('UPDATE pts SET published=1 WHERE id=?', id);
}

async function htmlOf(req, e) {
  const res = await send(req, e);
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  return { status: res.status, type, body };
}

function bootVars(body) {
  const match = body.match(/<style id="theme-boot">:root\{([^}]+)\}<\/style>/);
  if (!match) return null;
  const vars = {};
  for (const part of match[1].split(';')) {
    if (!part) continue;
    const [name, value] = part.split(':');
    vars[name] = value;
  }
  return vars;
}

describe('HTML theme injection', () => {
  it('single-PT HTML includes the published coach theme in the head', async () => {
    const s = await seedBlock({ customers: 0 });
    await paintPt(s.ptId, ocean);
    await onlyPublished(s.ptId);
    const res = await htmlOf(new Request(ORIGIN + '/'), single());
    expect(res.status).toBe(200);
    expect(res.type).toContain('text/html');
    const vars = bootVars(res.body);
    expect(vars).toBeTruthy();
    expect(vars['--accent']).toBe(ocean.accent);
    expect(vars['--bg']).toBe(ocean.background);
    expect(vars['--fg']).toBe(ocean.text);
    expect(vars['--primary']).toBe(ocean.primary);
    expect(res.body.indexOf('id="theme-boot"')).toBeLessThan(res.body.toLowerCase().indexOf('</head>'));
  });

  it('a signed-in customer gets their PT theme, including on the dashboard', async () => {
    const s = await seedBlock({ customers: 1 });
    await paintPt(s.ptId, ocean);
    const bookingId = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'paid' });
    const home = await htmlOf(getRequest(s.users[0], '/'), multi());
    expect(bootVars(home.body)['--accent']).toBe(ocean.accent);
    const dash = await htmlOf(getRequest(s.users[0], '/dashboard'), multi());
    expect(bootVars(dash.body)['--bg']).toBe(ocean.background);
    const checkout = await htmlOf(getRequest(s.users[0], '/booking/' + bookingId), multi());
    expect(bootVars(checkout.body)['--primary']).toBe(ocean.primary);
  });

  it('a signed-in PT gets their own theme on dashboard HTML', async () => {
    const s = await seedBlock({ customers: 0 });
    await paintPt(s.ptId, forest);
    const pt = await seedUser({ role: 'pt', ptId: s.ptId });
    const res = await htmlOf(getRequest(pt, '/dashboard'), multi());
    expect(res.status).toBe(200);
    const vars = bootVars(res.body);
    expect(vars['--accent']).toBe(forest.accent);
    expect(vars['--bg']).toBe(forest.background);
    expect(vars['--fg']).toBe(forest.text);
  });

  it('admin dashboard HTML stays on the Resilience default', async () => {
    const s = await seedBlock({ customers: 0 });
    await paintPt(s.ptId, ocean);
    const admin = await seedUser({ role: 'admin' });
    const dash = await htmlOf(getRequest(admin, '/dashboard'), single());
    const vars = bootVars(dash.body);
    expect(vars['--accent']).toBe('#ffd43b');
    expect(vars['--bg']).toBe('#ffffff');
    expect(vars['--fg']).toBe('#111111');
    expect(vars['--primary']).toBe('#111111');
  });

  it('falls back to Resilience when no published PT can be resolved', async () => {
    await db().run('UPDATE pts SET published=0');
    const res = await htmlOf(new Request(ORIGIN + '/'), single());
    expect(res.status).toBe(200);
    const vars = bootVars(res.body);
    expect(vars['--accent']).toBe('#ffd43b');
    expect(vars['--bg']).toBe('#ffffff');
    expect(vars['--fg']).toBe('#111111');
  });
});
