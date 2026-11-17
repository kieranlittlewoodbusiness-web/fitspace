// Legacy pt_direct READ path, ported from app/pt-stripe.cjs (open, load, status). Kieran
// chose Connect, so the Worker does not port the pt_direct WRITE paths (save/check/enable/
// disconnect): they answer 410 with a pointer to Connect. Existing pt_direct rows stay
// readable so their bookings can be cancelled/refunded and their per-PT webhooks verified,
// until those rows are migrated (then CREDENTIAL_ENCRYPTION_KEY is removed).
// Decryption is AES-256-GCM with AAD id:pt_id:mode:field, exactly as app/pt-stripe.cjs seal().
import crypto from 'node:crypto';
import { httpError } from './util.mjs';

export const PT_WEBHOOK_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired', 'checkout.session.async_payment_failed', 'payment_intent.payment_failed', 'refund.created', 'refund.updated', 'refund.failed', 'charge.refunded', 'account.updated'];

function master(env) {
  const value = env.CREDENTIAL_ENCRYPTION_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(value)) throw httpError(503, 'The owner must configure CREDENTIAL_ENCRYPTION_KEY as 64 random hexadecimal characters.');
  return Buffer.from(value, 'hex');
}
export function encryptionConfigured(env) { try { master(env); return true; } catch { return false; } }

/** Test/import helper only (the Worker never writes credentials): same format as app seal(). */
export function seal(env, value, row, field) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', master(env), iv);
  cipher.setAAD(Buffer.from([row.id, row.pt_id, row.mode, field].join(':')));
  return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
export function open(env, value, row, field) {
  try {
    const data = Buffer.from(value, 'base64'), cipher = crypto.createDecipheriv('aes-256-gcm', master(env), data.subarray(0, 12));
    cipher.setAAD(Buffer.from([row.id, row.pt_id, row.mode, field].join(':')));
    cipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString('utf8');
  } catch (error) {
    if (error.status) throw error;
    throw httpError(503, 'Saved Stripe credentials cannot be opened. Ask the owner to restore the correct encryption key.');
  }
}
/** A credential row with its decrypted API key (never logged, never returned to clients). */
export async function loadCredential(db, env, id) {
  const row = await db.get('SELECT * FROM pt_stripe_credentials WHERE id=?', id);
  if (!row || !row.api_cipher) throw httpError(409, 'This payment account is disconnected. Reconnect the same Stripe account or manage the payment directly in Stripe.');
  return { ...row, key: open(env, row.api_cipher, row, 'api') };
}
const safe = (row, origin) => row ? { id: row.id, mode: row.mode, account_id: row.account_id, configured: Boolean(row.api_cipher), webhook_configured: Boolean(row.webhook_cipher), enabled: Boolean(row.enabled), charges_ready: Boolean(row.charges_ready), payouts_ready: Boolean(row.payouts_ready), webhook_seen_at: row.webhook_seen_at || null, verified_at: row.verified_at || null, webhook_url: origin + '/api/stripe/pt/' + row.id + '/webhook' } : null;

/** GET /api/pt/stripe/setup for the caller's own pt_id only (app/pt-stripe.cjs status()). */
export async function credentialStatus(db, env, ptId, integration) {
  const origin = /^https:\/\/[^/]+\/?$/.test(env.APP_URL || '') ? new URL(env.APP_URL).origin : '';
  const rows = await db.all("SELECT * FROM pt_stripe_credentials WHERE pt_id=? AND mode IN ('stripe_test','stripe_live') ORDER BY mode DESC", ptId);
  const sandbox = await db.get("SELECT b.id FROM bookings b JOIN blocks c ON c.id=b.block_id WHERE c.pt_id=? AND b.mode='stripe_test' AND b.stripe_credential_id IS NOT NULL AND b.paid_at IS NOT NULL AND b.refund_status='succeeded' AND b.refunded_pence=b.amount_pence LIMIT 1", ptId);
  return {
    integration, encryption_ready: encryptionConfigured(env), app_url_ready: Boolean(origin), sandbox_passed: Boolean(sandbox),
    accounts: rows.map(r => safe(r, origin)), events: PT_WEBHOOK_EVENTS,
    permissions: [['Account', 'Read'], ['Checkout Sessions', 'Write'], ['Payment Intents', 'Read'], ['Events', 'Read'], ['Refunds', 'Write']],
    active_mode: env.PAYMENT_MODE || 'demo', writes: 'retired (use Stripe Connect)'
  };
}
