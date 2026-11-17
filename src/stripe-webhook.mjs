// Stripe signature verification, ported unchanged from app/payments.cjs verifyWebhook().
// Local HMAC only: no Stripe API call.
import crypto from 'node:crypto';
import { httpError, live } from './util.mjs';

export function verifyWebhook(raw, header, secret, mode) {
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter(Boolean);
  if (!secrets.length) throw httpError(503, 'Stripe webhook is not configured.');
  const parts = String(header || '').split(',').map(p => p.split('='));
  const timestamp = parts.find(p => p[0] === 't')?.[1];
  if (!/^\d+$/.test(timestamp || '') || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw httpError(400, 'Invalid webhook timestamp.');
  const ok = secrets.some(value => {
    const expected = crypto.createHmac('sha256', value).update(timestamp + '.' + raw).digest();
    return parts.filter(p => p[0] === 'v1').some(p => {
      try { const sig = Buffer.from(p[1], 'hex'); return sig.length === expected.length && crypto.timingSafeEqual(sig, expected); } catch { return false; }
    });
  });
  if (!ok) throw httpError(400, 'Invalid webhook signature.');
  let event;
  try { event = JSON.parse(raw); } catch { throw httpError(400, 'Invalid webhook data.'); }
  if (event.livemode !== live(mode) || (typeof event.data?.object?.livemode === 'boolean' && event.data.object.livemode !== live(mode))) throw httpError(403, 'Webhook payment mode mismatch.');
  return event;
}
