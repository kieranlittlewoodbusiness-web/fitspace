// Public (unauthenticated) and platform-level reads: published PTs only, never PT-private data.
import { httpError } from './util.mjs';
import { publicPt, viewBlocks } from './views.mjs';
import { bookingPathFor } from './multi-pt.mjs';
import { INSTALMENT_PLANS, PLANS, exceedsBlock, fitsBlock, publicOptions, quoteFor } from './instalments.mjs';

export async function defaultSlug(db) {
  return (await db.get('SELECT slug FROM pts WHERE published=1 ORDER BY created_at LIMIT 1'))?.slug || null;
}
/** The single published PT used in single-PT mode (first published by created_at), or null. */
export async function publishedCoach(db) {
  return (await db.get('SELECT * FROM pts WHERE published=1 ORDER BY created_at LIMIT 1')) || null;
}
export async function publishedPts(db) {
  return (await db.all('SELECT * FROM pts WHERE published=1 ORDER BY created_at')).map(publicPt);
}
/** Public site payload for GET /api/public/site. pt is the first published PT, or null. */
export async function publicSite(db, { multiPt }) {
  const row = await publishedCoach(db);
  return {
    multi_pt_enabled: Boolean(multiPt),
    pt: row ? { ...publicPt(row), booking_path: bookingPathFor(row) } : null,
    default_slug: row?.slug || null
  };
}
export async function publishedPtPage(db, slug, now = Date.now(), { multiPt = true } = {}) {
  if (!multiPt) {
    const only = await publishedCoach(db);
    if (!only || only.slug !== slug) throw httpError(404, 'This page is not available.', { code: 'PT_NOT_FOUND' });
  }
  const pt = await db.get('SELECT * FROM pts WHERE slug=? AND published=1', slug);
  if (!pt) throw httpError(404, 'This page is not available.');
  const blocks = (await viewBlocks(db, await db.all('SELECT * FROM blocks WHERE pt_id=? AND published=1 AND closed=0', pt.id), now))
    .filter(b => b.can_book).sort((a, b) => a.sessions[0].starts_epoch - b.sessions[0].starts_epoch)
    .map(({ payment_options, totals, ...b }) => ({ ...b, payment_options: publicOptions(b, planRows(payment_options), b.sessions[b.sessions.length - 1].starts_epoch, now) }));
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

// RC-30: config view (optionsConfig) back to plan rows for the public quote builder.
const planRows = options => INSTALMENT_PLANS.filter(p => options[p].amount_pence !== null).map(p => ({ plan: p, enabled: options[p].enabled ? 1 : 0, amount_pence: options[p].amount_pence, count: options[p].count }));

/** POST /api/bookings/quote (signed-in customer): a read-only quote for one plan. */
export async function quoteBlock(db, { blockId, plan = 'upfront', discountCode = null, now = Date.now() }) {
  if (typeof blockId !== 'string' || !blockId) throw httpError(400, 'Choose a class.', { code: 'FIELDS_INVALID', fields: ['block_id'] });
  if (!PLANS.includes(plan)) throw httpError(400, 'Choose a way to pay.', { code: 'FIELDS_INVALID', fields: ['plan'] });
  // RC-8 hook: discount codes are not built yet, so any code is rejected without a lookup.
  if (discountCode !== null && discountCode !== undefined && discountCode !== '') throw httpError(400, 'This discount code cannot be used.', { code: 'DISCOUNT_INVALID' });
  const row = await db.get('SELECT b.* FROM blocks b JOIN pts p ON p.id=b.pt_id WHERE b.id=? AND b.published=1 AND p.published=1 AND p.deleted_at IS NULL', blockId);
  if (!row) throw httpError(404, 'Class not found.', { code: 'NOT_FOUND' });
  const [block] = await viewBlocks(db, [row], now);
  if (!block.can_book || block.available < 1) throw httpError(409, 'This class is no longer open for bookings.', { code: 'BLOCK_UNAVAILABLE' });
  if (plan === 'upfront') {
    if (block.upfront_enabled === 0) throw httpError(409, 'This way to pay is not offered for this class.', { code: 'PLAN_NOT_OFFERED' });
    return { quote: quoteFor(block, 'upfront', null, { now }) };
  }
  const opt = block.payment_options[plan];
  if (!opt.enabled) throw httpError(409, 'This way to pay is not offered for this class.', { code: 'PLAN_NOT_OFFERED' });
  if (!fitsBlock(plan, opt.count, block.sessions[block.sessions.length - 1].starts_epoch, now)) throw exceedsBlock(409);
  return { quote: quoteFor(block, plan, opt, { now }) };
}
