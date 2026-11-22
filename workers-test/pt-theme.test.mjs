import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { db, seedBlock, seedUser, getRequest, jsonRequest, ORIGIN } from './helpers.mjs';
import { presetById, DEFAULT_THEME_ID } from '../src/theme-presets.mjs';

const jsonOf = async res => { const text = await res.text(); try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; } };
const send = (req, e = env) => exports.default.fetch(req, e);

async function seedTrainer() {
  const s = await seedBlock({ customers: 1 });
  const pt = await seedUser({ role: 'pt', ptId: s.ptId });
  const admin = await seedUser({ role: 'admin' });
  return { ...s, pt, admin };
}

describe('PT theme API', () => {
  it('GET /api/pt/theme returns resilience when the stored colours are the default or unmatched', async () => {
    const s = await seedTrainer();
    const res = await send(getRequest(s.pt, '/api/pt/theme'));
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body).toEqual({ id: DEFAULT_THEME_ID });

    await db().run("UPDATE pts SET accent='#cc3300',background='#ffffff',foreground='#111111' WHERE id=?", s.ptId);
    const unmatched = await jsonOf(await send(getRequest(s.pt, '/api/pt/theme')));
    expect(unmatched).toEqual({ id: 'resilience' });
  });

  it('GET is PT-only and PUT requires a PT session and CSRF', async () => {
    const s = await seedTrainer();
    const anon = await send(new Request(ORIGIN + '/api/pt/theme'));
    expect(anon.status).toBe(401);
    const customerGet = await send(getRequest(s.users[0], '/api/pt/theme'));
    expect(customerGet.status).toBe(403);
    const adminGet = await send(getRequest(s.admin, '/api/pt/theme'));
    expect(adminGet.status).toBe(403);

    const customerPut = await send(jsonRequest(s.users[0], 'PUT', '/api/pt/theme', { id: 'night' }));
    expect(customerPut.status).toBe(403);
    const adminPut = await send(jsonRequest(s.admin, 'PUT', '/api/pt/theme', { id: 'night' }));
    expect(adminPut.status).toBe(403);

    const noCsrf = await send(new Request(ORIGIN + '/api/pt/theme', {
      method: 'PUT',
      headers: { origin: ORIGIN, cookie: 'fit_session=' + s.pt.token, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'night' })
    }));
    expect(noCsrf.status).toBe(403);
  });

  it('PUT /api/pt/theme stores only an allowlisted id and updates the existing colour columns', async () => {
    const s = await seedTrainer();
    const bad = await send(jsonRequest(s.pt, 'PUT', '/api/pt/theme', { id: 'not-a-theme' }));
    expect(bad.status).toBe(400);
    const denied = await jsonOf(bad);
    expect(denied.error).toBe('Choose a theme from the list.');

    const saved = await send(jsonRequest(s.pt, 'PUT', '/api/pt/theme', { id: 'Night' }));
    expect(saved.status).toBe(200);
    expect(await jsonOf(saved)).toEqual({ id: 'night' });

    const row = await db().get('SELECT accent,background,foreground FROM pts WHERE id=?', s.ptId);
    const night = presetById('night');
    expect(row).toEqual({ accent: night.accent, background: night.background, foreground: night.text });

    const got = await jsonOf(await send(getRequest(s.pt, '/api/pt/theme')));
    expect(got).toEqual({ id: 'night' });

    const site = await jsonOf(await send(new Request(ORIGIN + '/api/public/site')));
    expect(site.pt.accent).toBe(night.accent);
    expect(site.pt.background).toBe(night.background);
    expect(site.pt.foreground).toBe(night.text);
  });
});
