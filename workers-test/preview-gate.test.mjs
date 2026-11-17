import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker, { cronTick } from '../worker/index.mjs';
import { db, seedBlock, insertBooking } from './helpers.mjs';
import { GATE_PATH, COOKIE_NAME, ROBOTS_BODY, signPreviewCookie, TTL_MS, deriveCookieKey, safeNext, safeFragment, TOKEN_FRAGMENT } from '../src/preview-gate.mjs';

const PASSWORD = 'correct-horse-preview';
const gated = (extra = {}) => Object.assign(Object.create(null), env, {
  PREVIEW_GATE: 'on',
  PREVIEW_PASSWORD: PASSWORD,
  ...extra
});
const cookieKey = (e = gated()) => deriveCookieKey(e.PT_INVITE_SECRET);
const ORIGIN = 'http://example.test';

function req(path, { method = 'GET', cookie, password, json, ip, headers, fields } = {}) {
  const h = { ...(headers || {}) };
  if (ip) h['CF-Connecting-IP'] = ip;
  if (cookie) h.cookie = `${COOKIE_NAME}=${cookie}`;
  let body;
  if (password !== undefined && json) {
    h['content-type'] = 'application/json';
    body = JSON.stringify({ password, ...(fields || {}) });
    method = method === 'GET' ? 'POST' : method;
  } else if (password !== undefined || fields) {
    h['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams({ ...(password !== undefined ? { password } : {}), ...(fields || {}) }).toString();
    method = method === 'GET' ? 'POST' : method;
  }
  return new Request(ORIGIN + path, { method, headers: h, body });
}
const cookieOf = r => {
  const raw = r.headers.get('set-cookie') || '';
  const m = raw.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return m ? m[1] : '';
};

describe('preview gate: off by default', () => {
  it('the default env does not gate, even if PREVIEW_PASSWORD were set', async () => {
    expect(env.PREVIEW_GATE).toBeUndefined();
    const e = Object.assign(Object.create(null), env, { PREVIEW_PASSWORD: PASSWORD });
    const health = await worker.fetch(req('/health'), e);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect(health.headers.get('X-Robots-Tag')).toBeNull();
    const api = await worker.fetch(req('/api/me'), e);
    expect(api.status).toBe(200);
    expect((await api.json()).code).toBeUndefined();
    const page = await worker.fetch(req('/'), e);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toMatch(/This preview is locked/);
  });

  it('PREVIEW_GATE values other than "on" do not enable the gate', async () => {
    for (const value of ['', 'true', 'ON', 'yes', '1']) {
      const r = await worker.fetch(req('/health'), gated({ PREVIEW_GATE: value }));
      expect(r.status, value).toBe(200);
    }
  });
});

describe('preview gate: on', () => {
  it('HTML requests without a cookie get a 401 form and the robots header', async () => {
    const r = await worker.fetch(req('/'), gated());
    expect(r.status).toBe(401);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    const html = await r.text();
    expect(html).toMatch(/Resilience Coaching/);
    expect(html).toMatch(/This preview is locked/);
    expect(html).toMatch(new RegExp(`action="${GATE_PATH}"`));
  });

  it('API requests without a cookie get 401 JSON {error, code:PREVIEW_LOCKED}', async () => {
    for (const path of ['/api/me', '/api/public/site', '/api/health']) {
      const r = await worker.fetch(req(path), gated());
      expect(r.status, path).toBe(401);
      expect(r.headers.get('content-type')).toMatch(/application\/json/);
      expect(r.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      const body = await r.json();
      expect(body.code).toBe('PREVIEW_LOCKED');
      expect(body.error).toBeTruthy();
    }
  });

  it('gates /health and static files, but not /robots.txt', async () => {
    expect((await worker.fetch(req('/health'), gated())).status).toBe(401);
    expect((await worker.fetch(req('/styles.css'), gated())).status).toBe(401);
    const robots = await worker.fetch(req('/robots.txt'), gated());
    expect(robots.status).toBe(200);
    expect(robots.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(await robots.text()).toBe(ROBOTS_BODY);
  });

  it('fails closed with 503 if PREVIEW_PASSWORD or PT_INVITE_SECRET is missing', async () => {
    const noPass = await worker.fetch(req('/'), gated({ PREVIEW_PASSWORD: '' }));
    expect(noPass.status).toBe(503);
    expect(noPass.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    const noInvite = await worker.fetch(req('/api/me'), gated({ PT_INVITE_SECRET: '' }));
    expect(noInvite.status).toBe(503);
    expect(await noInvite.json()).toMatchObject({ error: expect.any(String) });
    const neither = await worker.fetch(req('/'), Object.assign(Object.create(null), env, { PREVIEW_GATE: 'on', PREVIEW_PASSWORD: '', PT_INVITE_SECRET: '' }));
    expect(neither.status).toBe(503);
  });

  it('accepts the right password and sets a signed HttpOnly Secure SameSite=Lax cookie', async () => {
    const r = await worker.fetch(req(GATE_PATH, { method: 'POST', password: PASSWORD }), gated());
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/');
    const set = r.headers.get('set-cookie') || '';
    expect(set).toMatch(new RegExp(`^${COOKIE_NAME}=`));
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Secure/);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Path=\//);
    expect(set).toMatch(/Max-Age=86400/);
    const token = cookieOf(r);
    expect(token).toMatch(/^\d+\.[A-Za-z0-9_-]+$/);

    const page = await worker.fetch(req('/', { cookie: token }), gated());
    expect(page.status).toBe(200);
    expect(page.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    const html = await page.text();
    expect(html).toMatch(/Resilience Coaching/);
    expect(html).not.toMatch(/This preview is locked/);

    const api = await worker.fetch(req('/api/me', { cookie: token }), gated());
    expect(api.status).toBe(200);
    const body = await api.json();
    expect(body.code).not.toBe('PREVIEW_LOCKED');
    expect(body).toHaveProperty('user');
  });

  it('accepts a JSON unlock and then serves /health', async () => {
    const r = await worker.fetch(req(GATE_PATH, { method: 'POST', password: PASSWORD, json: true }), gated());
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
    const token = cookieOf(r);
    const health = await worker.fetch(req('/health', { cookie: token }), gated());
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });

  it('rejects the wrong password with 401 and no cookie', async () => {
    const r = await worker.fetch(req(GATE_PATH, { method: 'POST', password: 'nope', ip: '203.0.113.10' }), gated());
    expect(r.status).toBe(401);
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(await r.text()).toMatch(/incorrect/i);
  });

  it('rejects a JSON wrong password with 401 PREVIEW_LOCKED and no cookie', async () => {
    const r = await worker.fetch(req(GATE_PATH, { method: 'POST', password: 'nope', json: true, ip: '203.0.113.11' }), gated());
    expect(r.status).toBe(401);
    expect(r.headers.get('set-cookie')).toBeNull();
    const body = await r.json();
    expect(body.code).toBe('PREVIEW_LOCKED');
  });

  it('rejects an expired cookie', async () => {
    const token = signPreviewCookie(await cookieKey(), Date.now() - TTL_MS - 1000);
    const r = await worker.fetch(req('/', { cookie: token }), gated());
    expect(r.status).toBe(401);
    const api = await worker.fetch(req('/api/me', { cookie: token }), gated());
    expect(api.status).toBe(401);
    expect((await api.json()).code).toBe('PREVIEW_LOCKED');
  });

  it('rejects a tampered cookie', async () => {
    const token = signPreviewCookie(await cookieKey());
    const [ts, mac] = token.split('.');
    const flipped = mac[0] === 'A' ? 'B' + mac.slice(1) : 'A' + mac.slice(1);
    const r = await worker.fetch(req('/', { cookie: `${ts}.${flipped}` }), gated());
    expect(r.status).toBe(401);
    const cut = await worker.fetch(req('/api/public/site', { cookie: ts }), gated());
    expect(cut.status).toBe(401);
    const foreign = signPreviewCookie(await deriveCookieKey('b'.repeat(64)));
    const other = await worker.fetch(req('/', { cookie: foreign }), gated());
    expect(other.status).toBe(401);
  });

  it('the derived cookie key differs from the invite-signing key, and a cookie signed with the raw PT_INVITE_SECRET is rejected', async () => {
    const invite = gated().PT_INVITE_SECRET;
    const derived = await deriveCookieKey(invite);
    expect(derived.length).toBe(32);
    expect(derived.equals(Buffer.from(invite, 'utf8'))).toBe(false);

    const rawSigned = signPreviewCookie(invite);
    const rejected = await worker.fetch(req('/', { cookie: rawSigned }), gated());
    expect(rejected.status).toBe(401);
    const api = await worker.fetch(req('/api/me', { cookie: rawSigned }), gated());
    expect(api.status).toBe(401);
    expect((await api.json()).code).toBe('PREVIEW_LOCKED');

    const allowed = await worker.fetch(req('/', { cookie: signPreviewCookie(derived) }), gated());
    expect(allowed.status).toBe(200);
  });

  it('rate-limits wrong attempts: 5 per 15 minutes per IP, then 429', async () => {
    const ip = '198.51.100.44';
    const e = gated();
    for (let i = 0; i < 5; i++) {
      const r = await worker.fetch(req(GATE_PATH, { method: 'POST', password: 'wrong', ip }), e);
      expect(r.status, `attempt ${i + 1}`).toBe(401);
    }
    const blocked = await worker.fetch(req(GATE_PATH, { method: 'POST', password: 'wrong', ip }), e);
    expect(blocked.status).toBe(429);
    // A different IP is still allowed to try
    const other = await worker.fetch(req(GATE_PATH, { method: 'POST', password: 'wrong', ip: '198.51.100.45' }), e);
    expect(other.status).toBe(401);
  });
});

describe('preview gate: cron is unaffected', () => {
  it('scheduled() still runs with the gate on and no cookie', async () => {
    const s = await seedBlock({ customers: 1 });
    const id = await insertBooking({ blockId: s.blockId, customerId: s.users[0].id, status: 'pending', expiresAt: Date.now() - 60000 });
    const waits = [];
    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: Date.now() },
      gated({ CRON_ENABLED: 'true' }),
      { waitUntil: p => waits.push(p) }
    );
    await Promise.all(waits);
    expect((await db().get('SELECT status FROM bookings WHERE id=?', id)).status).toBe('expired');
  });

  it('cronTick itself is not wrapped by the gate', async () => {
    expect(await cronTick(gated({ CRON_ENABLED: undefined }))).toEqual({ skipped: 'CRON_ENABLED is not "true"' });
  });
});


const SAMPLE_TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.' + 'A'.repeat(43);

describe('preview gate: return path and fragment', () => {
  it('safeNext allows a same-origin path and query, and rejects schemes and //', () => {
    expect(safeNext('/reset-password?token=' + SAMPLE_TOKEN)).toBe('/reset-password?token=' + SAMPLE_TOKEN);
    expect(safeNext('/pt/preview-trainer')).toBe('/pt/preview-trainer');
    expect(safeNext('/')).toBe('/');
    expect(safeNext('https://evil.example/')).toBe('/');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('javascript:alert(1)')).toBe('/');
  });

  it('safeFragment accepts only the reset-token charset', () => {
    expect(TOKEN_FRAGMENT.test(SAMPLE_TOKEN)).toBe(true);
    expect(safeFragment('#' + SAMPLE_TOKEN)).toBe('#' + SAMPLE_TOKEN);
    expect(safeFragment(SAMPLE_TOKEN)).toBe('#' + SAMPLE_TOKEN);
    expect(safeFragment('#classes')).toBe('');
    expect(safeFragment('#javascript:alert(1)')).toBe('');
    expect(safeFragment('')).toBe('');
  });

  it('a gated GET of /reset-password?token= includes a hidden next with that path and query', async () => {
    const path = '/reset-password?token=' + SAMPLE_TOKEN;
    const r = await worker.fetch(req(path), gated());
    expect(r.status).toBe(401);
    const html = await r.text();
    expect(html).toContain(`name="next" value="${path}"`);
    expect(html).toMatch(/id="preview-gate-fragment"/);
    expect(html).toMatch(/location\.hash/);
    expect(r.headers.get('content-security-policy')).toMatch(/script-src 'self' 'nonce-/);
  });

  it('unlock redirects to next plus a validated fragment', async () => {
    const path = '/reset-password?token=' + SAMPLE_TOKEN;
    const r = await worker.fetch(req(GATE_PATH, { method: 'POST', password: PASSWORD, fields: { next: path, fragment: SAMPLE_TOKEN } }), gated());
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(path + '#' + SAMPLE_TOKEN);
    expect(r.headers.get('set-cookie')).toMatch(new RegExp(`^${COOKIE_NAME}=`));
  });

  it('unlock with only ?token= next (no fragment) goes to the query form of the link', async () => {
    const path = '/reset-password?token=' + SAMPLE_TOKEN;
    const r = await worker.fetch(req(GATE_PATH, { method: 'POST', password: PASSWORD, fields: { next: path } }), gated());
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(path);
  });

  it('rejects an unsafe next and an invalid fragment, falling back to /', async () => {
    const r = await worker.fetch(req(GATE_PATH, { method: 'POST', password: PASSWORD, fields: { next: 'https://evil.example/', fragment: 'classes' } }), gated());
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/');
  });

  it('a wrong password re-renders the form with the submitted next preserved', async () => {
    const path = '/reset-password?token=' + SAMPLE_TOKEN;
    const r = await worker.fetch(req(GATE_PATH, { method: 'POST', password: 'nope', fields: { next: path }, ip: '203.0.113.40' }), gated());
    expect(r.status).toBe(401);
    expect(r.headers.get('set-cookie')).toBeNull();
    const html = await r.text();
    expect(html).toContain(`name="next" value="${path}"`);
  });

  it('/api/me includes preview_pt_email only when the gate is on and unlocked', async () => {
    const off = await worker.fetch(req('/api/me'), Object.assign(Object.create(null), env, { PREVIEW_PASSWORD: PASSWORD }));
    expect(off.status).toBe(200);
    expect((await off.json()).preview_pt_email).toBeUndefined();
    const unlocked = await worker.fetch(req(GATE_PATH, { method: 'POST', password: PASSWORD }), gated());
    const me = await worker.fetch(req('/api/me', { cookie: cookieOf(unlocked) }), gated());
    expect(me.status).toBe(200);
    expect((await me.json()).preview_pt_email).toBe('preview-trainer@example.com');
  });
});


describe('preview assets and reset-password document', () => {
  it('unlocked GET /reset-password?token= returns 200 HTML (not a 30x) with no-store and versioned assets', async () => {
    const unlocked = await worker.fetch(req(GATE_PATH, { method: 'POST', password: PASSWORD }), gated());
    const cookie = cookieOf(unlocked);
    const path = '/reset-password?token=' + SAMPLE_TOKEN;
    const r = await worker.fetch(req(path, { cookie }), gated());
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    expect(r.headers.get('location')).toBeNull();
    const html = await r.text();
    expect(html).toMatch(/\/app\.js\?v=[a-f0-9]+/);
    expect(html).toMatch(/\/styles\.css\?v=[a-f0-9]+/);
    expect(html).not.toMatch(/This preview is locked/);
  });

  it('unlocked GET / and /app.js send Cache-Control: no-store', async () => {
    const unlocked = await worker.fetch(req(GATE_PATH, { method: 'POST', password: PASSWORD }), gated());
    const cookie = cookieOf(unlocked);
    for (const path of ['/', '/app.js', '/styles.css', '/api/me']) {
      const r = await worker.fetch(req(path, { cookie }), gated());
      expect(r.status, path).toBe(200);
      expect(r.headers.get('cache-control'), path).toMatch(/no-store/);
    }
  });
});
