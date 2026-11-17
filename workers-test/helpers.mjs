import crypto from 'node:crypto';
import { env } from 'cloudflare:workers';
import { createDb } from '../src/db.mjs';

export const db = () => createDb(env.DB);
export const ORIGIN = 'http://example.test';
const sha = v => crypto.createHash('sha256').update(v).digest('hex');

/** A PT, a published block with a future session, and `customers` signed-in customers. */
export async function seedBlock({ capacity = 5, customers = 20, blockId = 'block-' + crypto.randomUUID(), price = 1500 } = {}) {
  const d = db();
  const now = Date.now();
  const ptId = 'pt-' + crypto.randomUUID();
  const stmts = [
    d.stmt("INSERT INTO pts(id,slug,brand_name,tagline,description,about,created_at) VALUES(?,?,?,?,?,?,?)", ptId, ptId, 'Test PT', 'Tagline here', 'Description here', 'About text here', now),
    d.stmt('INSERT INTO blocks(id,pt_id,title,description,venue,price_pence,capacity,created_at) VALUES(?,?,?,?,?,?,?,?)', blockId, ptId, 'Strength block', 'Six weeks', 'Studio', price, capacity, now),
    d.stmt('INSERT INTO class_sessions VALUES(?,?,?,?,?)', blockId + '-s0', blockId, '2099-01-05T18:30', Date.UTC(2099, 0, 5, 18, 30), 60)
  ];
  const users = [];
  for (let i = 0; i < customers; i++) {
    const id = `${blockId}-c${i}`, token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
    stmts.push(d.stmt("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,'x','customer',?)", id, 'Customer ' + i, `${id}@example.com`, now));
    stmts.push(d.stmt('INSERT INTO sessions VALUES(?,?,?,?)', sha(token), id, csrf, now + 3600000));
    users.push({ id, token, csrf });
  }
  await d.batch(stmts);
  return { ptId, blockId, users };
}

export function bookingRequest(user, blockId, checkoutToken = crypto.randomUUID()) {
  return new Request(ORIGIN + '/api/bookings', {
    method: 'POST',
    headers: { origin: ORIGIN, cookie: 'fit_session=' + user.token, 'x-csrf-token': user.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ block_id: blockId, checkout_token: checkoutToken })
  });
}

export function signedWebhook(payload, secret = env.STRIPE_WEBHOOK_SECRET) {
  const raw = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(t + '.' + raw).digest('hex');
  return () => new Request(ORIGIN + '/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${v1}`, 'content-type': 'application/json' }, body: raw });
}

export const tally = list => list.reduce((acc, k) => ((acc[k] = (acc[k] || 0) + 1), acc), {});

/** A signed-in user of any role (for tenant-scope tests). */
export async function seedUser({ role, ptId = null }) {
  const d = db();
  const id = role + '-' + crypto.randomUUID(), token = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
  await d.batch([
    d.stmt("INSERT INTO users(id,name,email,password_hash,role,pt_id,created_at) VALUES(?,?,?,'x',?,?,?)", id, 'User ' + role, `${id}@example.com`, role, ptId, Date.now()),
    d.stmt('INSERT INTO sessions VALUES(?,?,?,?)', sha(token), id, csrf, Date.now() + 3600000)
  ]);
  return { id, role, pt_id: ptId, token, csrf };
}
export const getRequest = (user, path) => new Request(ORIGIN + path, { headers: { cookie: 'fit_session=' + user.token } });

export function jsonRequest(user, method, path, body) {
  const headers = { origin: ORIGIN, 'content-type': 'application/json' };
  if (user) Object.assign(headers, { cookie: 'fit_session=' + user.token, 'x-csrf-token': user.csrf });
  return new Request(ORIGIN + path, { method, headers, body: JSON.stringify(body ?? {}) });
}
/** Insert a booking row directly (any status), returning its id. */
export async function insertBooking({ blockId, customerId, status = 'paid', mode = 'demo', expiresAt = Date.now() + 30 * 60000, extra = {} }) {
  const id = 'bk-' + crypto.randomUUID();
  const cols = { id, block_id: blockId, customer_id: customerId, reference: 'FIT-' + id.slice(3, 11).toUpperCase(), status, amount_pence: 1500, mode, checkout_token: crypto.randomUUID(), expires_at: expiresAt, created_at: Date.now(), paid_at: status === 'paid' ? Date.now() : null, ...extra };
  const keys = Object.keys(cols);
  await db().run(`INSERT INTO bookings(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => cols[k]));
  return id;
}
