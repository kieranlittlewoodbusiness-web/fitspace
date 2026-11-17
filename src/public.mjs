// Public (unauthenticated) and platform-level reads: published PTs only, never PT-private data.
import { httpError } from './util.mjs';
import { publicPt, viewBlocks } from './views.mjs';

export async function defaultSlug(db) {
  return (await db.get('SELECT slug FROM pts WHERE published=1 ORDER BY created_at LIMIT 1'))?.slug || null;
}
export async function publishedPts(db) {
  return (await db.all('SELECT * FROM pts WHERE published=1 ORDER BY created_at')).map(publicPt);
}
export async function publishedPtPage(db, slug, now = Date.now()) {
  const pt = await db.get('SELECT * FROM pts WHERE slug=? AND published=1', slug);
  if (!pt) throw httpError(404, 'This page is not available.');
  const blocks = (await viewBlocks(db, await db.all('SELECT * FROM blocks WHERE pt_id=? AND published=1 AND closed=0', pt.id), now))
    .filter(b => b.can_book).sort((a, b) => a.sessions[0].starts_epoch - b.sessions[0].starts_epoch);
  return { pt: publicPt(pt), blocks };
}
/** Expire lapsed holds (app/payments.cjs expire()); one guarded statement. */
export const expireHolds = (db, now = Date.now()) => db.run("UPDATE bookings SET status='expired' WHERE status='pending' AND expires_at<=?", now);

/** Admin Stripe setup status (app/payments.cjs setupStatus()); admin route only. */
export async function adminSetupStatus(db, env, { paymentMode, integration, keyReady }) {
  const appUrlReady = /^https:\/\/[^/]+\/?$/.test(env.APP_URL || '');
  if (integration === 'pt_direct') return { integration, mode: paymentMode, encryption_ready: /^[a-f0-9]{64}$/i.test(env.CREDENTIAL_ENCRYPTION_KEY || ''), app_url_ready: appUrlReady, connections: await db.all('SELECT id,pt_id,mode,account_id,enabled,charges_ready,webhook_seen_at FROM pt_stripe_credentials') };
  return { mode: paymentMode, key_ready: keyReady, webhook_ready: Boolean(env.STRIPE_WEBHOOK_SECRET), connect_webhook_ready: Boolean(env.STRIPE_CONNECT_WEBHOOK_SECRET), app_url_ready: appUrlReady, connections: await db.all('SELECT c.*,p.brand_name FROM stripe_connections c JOIN pts p ON p.id=c.pt_id') };
}

/** PT webhook: the credential row (scoped by its unguessable id in the URL path). */
export const credentialById = (db, id) => db.get('SELECT * FROM pt_stripe_credentials WHERE id=?', id);
export const markWebhookSeen = (db, id) => db.run('UPDATE pt_stripe_credentials SET webhook_seen_at=? WHERE id=?', Date.now(), id);
