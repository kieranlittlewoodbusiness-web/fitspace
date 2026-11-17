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

describe('legacy route parity', () => {
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
