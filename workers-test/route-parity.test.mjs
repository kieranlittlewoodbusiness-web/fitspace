// Every route the legacy server (app/server.cjs) answered is answered by the Worker: none falls
// through to the unknown-route 404, none is a 501 stub, and no 501 remains in src/ or worker/.
import { describe, it, expect } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import legacy from '../app/server.cjs?raw';
import { seedUser, getRequest, jsonRequest } from './helpers.mjs';

const UNKNOWN = 'This action is not available.';
const id = '00000000-0000-4000-8000-000000000000';
// [method, sample path, legacy route literal or pattern]
const ROUTES = [
  ['GET', '/health', '/health'],
  ['POST', `/api/stripe/pt/${id}/webhook`, 'stripe/pt/:id/webhook'],
  ['POST', '/api/stripe/webhook', '/api/stripe/webhook'],
  ['GET', '/api/me', '/api/me'],
  ['POST', '/api/auth/login', '/api/auth/login'],
  ['POST', '/api/auth/forgot-password', '/api/auth/forgot-password'],
  ['POST', '/api/auth/reset-password', '/api/auth/reset-password'],
  ['POST', '/api/auth/signup', '/api/auth/signup'],
  ['POST', '/api/auth/logout', '/api/auth/logout'],
  ['POST', '/api/auth/password', '/api/auth/password'],
  ['GET', '/api/public/pts', '/api/public/pts'],
  ['GET', '/api/public/pts/no-such-slug', 'public/pts/:slug'],
  ['GET', '/api/dashboard', '/api/dashboard'],
  ['GET', '/api/admin/stripe/setup', '/api/admin/stripe/setup'],
  ['POST', '/api/admin/stripe/check', '/api/admin/stripe/check'],
  ['POST', '/api/admin/stripe/link', '/api/admin/stripe/link'],
  ['POST', '/api/admin/pts', '/api/admin/pts'],
  ['PUT', `/api/admin/pts/${id}`, 'admin/pts/:id'],
  ['POST', '/api/blocks', '/api/blocks'],
  ['PUT', `/api/blocks/${id}`, 'blocks/:id'],
  ['POST', '/api/bookings', '/api/bookings'],
  ['POST', `/api/bookings/${id}/checkout`, 'bookings/:id/checkout'],
  ['POST', `/api/bookings/${id}/refund`, 'bookings/:id/refund'],
  ['GET', `/api/bookings/${id}`, 'bookings/:id'],
  ['POST', `/api/bookings/${id}/pay`, 'bookings/:id/pay'],
  ['POST', `/api/bookings/${id}/cancel`, 'bookings/:id/cancel'],
  ['POST', '/api/attendance', '/api/attendance'],
  ['GET', '/api/pt/stripe/setup', '/api/pt/stripe/setup'],
  ['POST', '/api/pt/stripe/connect', '/api/pt/stripe/connect'],
  ['POST', '/api/pt/stripe/status', '/api/pt/stripe/status']
];

// CR 5941600057: (method, route) pairs parsed from app/server.cjs, so a changed legacy METHOD
// fails too. Forms: `req.method==='X'&&route==='/p'`, `route==='/p'&&req.method==='X'`,
// `route==='/p'` (any method), and `const n=route.match(/re/)` + `req.method==='X'&&n` / `n&&req.method==='X'`.
export function legacyPairs(src) {
  const pairs = [];
  for (const m of src.matchAll(/req\.method==='([A-Z]+)'&&route==='([^']+)'/g)) pairs.push([m[1], m[2]]);
  for (const m of src.matchAll(/route==='([^']+)'&&req\.method==='([A-Z]+)'/g)) pairs.push([m[2], m[1]]);
  for (const m of src.matchAll(/route==='([^']+)'(?!&&req\.method)/g)) if (!pairs.some(p => p[1] === m[1]) && !new RegExp("req\\.method==='[A-Z]+'&&route==='" + m[1].replace(/[/.]/g, '\\$&') + "'").test(src)) pairs.push(['ANY', m[1]]);
  for (const m of src.matchAll(/const (\w+)=route\.match\(\/(.+?)\/\)/g)) {
    const [, name, re] = m;
    const methods = [...src.matchAll(new RegExp("(?:req\\.method==='([A-Z]+)'&&" + name + "\\b|\\b" + name + "&&req\\.method==='([A-Z]+)')", 'g'))].map(x => x[1] || x[2]);
    if (!methods.length) pairs.push(['?', '/' + re + '/']);
    for (const method of methods) pairs.push([method, '/' + re + '/']);
  }
  return pairs.map(([method, r]) => method + ' ' + r).sort();
}
const matches = (legacyRoute, path) => legacyRoute.startsWith('/^') ? new RegExp(legacyRoute.slice(1, -1).replace(/\\\//g, '/')).test(path) : legacyRoute === path;

describe('legacy route parity', () => {
  it('methods: every (method, route) pair in app/server.cjs is in the table with the SAME method, and vice versa', () => {
    const pairs = legacyPairs(legacy);
    expect(pairs.length).toBe(ROUTES.length);
    for (const pair of pairs) {
      const [method, r] = [pair.slice(0, pair.indexOf(' ')), pair.slice(pair.indexOf(' ') + 1)];
      const hit = ROUTES.filter(([m, path]) => matches(r, path) && (method === 'ANY' || m === method));
      expect(hit.length, pair).toBeGreaterThan(0);
    }
    for (const [m, path] of ROUTES) expect(pairs.some(p => { const [method, r] = [p.slice(0, p.indexOf(' ')), p.slice(p.indexOf(' ') + 1)]; return matches(r, path) && (method === 'ANY' || method === m); }), m + ' ' + path).toBe(true);
    // the parser must actually see methods: a changed legacy method (POST -> PUT) fails above
    const mutated = legacyPairs(legacy.replace("req.method==='POST'&&cancelRoute", "req.method==='PUT'&&cancelRoute"));
    expect(mutated).toContain('PUT /^\\/api\\/bookings\\/([^/]+)\\/cancel$/');
    expect(mutated).not.toContain('POST /^\\/api\\/bookings\\/([^/]+)\\/cancel$/');
  });

  it('the table covers every literal route in app/server.cjs', () => {
    const literals = [...legacy.matchAll(/route==='([^']+)'/g)].map(m => m[1]);
    expect(literals.length).toBeGreaterThan(20);
    for (const r of literals) expect(ROUTES.map(x => x[2]), r).toContain(r);
    expect([...legacy.matchAll(/route\.match\(/g)].length).toBe(ROUTES.filter(r => !r[2].startsWith('/')).length);
  });

  it('every legacy route is answered (no unknown-route 404, no 501)', async () => {
    const admin = await seedUser({ role: 'admin' });
    const results = [];
    // Logout last so the admin session stays valid for every other route.
    for (const [method, path] of [...ROUTES].sort((a, b) => (a[1] === '/api/auth/logout') - (b[1] === '/api/auth/logout'))) {
      const req = method === 'GET' ? getRequest(admin, path) : jsonRequest(admin, method, path, {});
      const res = await exports.default.fetch(req);
      const body = (res.headers.get('content-type') || '').includes('json') ? await res.json() : {};
      results.push([method, path, res.status, body.error]);
    }
    const missing = results.filter(([, , status, error]) => status === 501 || error === UNKNOWN);
    expect(missing).toEqual([]);
    // Signed in, so a 401 would mean the route was never reached.
    expect(results.filter(r => r[2] === 401)).toEqual([]);
  });

  it('no 501 status remains in src/ or worker/', () => {
    const files = { ...import.meta.glob('../src/**/*.mjs', { query: '?raw', import: 'default', eager: true }), ...import.meta.glob('../worker/**/*.mjs', { query: '?raw', import: 'default', eager: true }) };
    const hits = Object.entries(files).filter(([, s]) => /\b501\b/.test(s)).map(([f]) => f);
    expect(hits).toEqual([]);
  });
});
