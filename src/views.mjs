// Read models ported from app/server.cjs publicPt/viewBlock/viewBooking and the
// GET /api/dashboard branches (server.cjs:44). Every PT-owned read goes through scopeFor();
// public reads only ever return published PTs/blocks.
import { scopeFor } from './scope.mjs';
import { stripeConnection } from './ops/bookings.mjs';
import { isStripe } from './util.mjs';
import { MOTIVATIONS } from './validate.mjs';
import { parseReviewReason } from './cutover.mjs';
import { connectStatusView } from './connect-status.mjs';
import { profileMissing, ptProfile, publicContactFields } from './profile.mjs';
import { optionsConfig, planView, PAST_DUE_MESSAGE, NEEDS_ATTENTION_MESSAGE } from './instalments.mjs';
import { httpError } from './util.mjs';

// D1 allows at most 100 bound parameters per statement: IN-lists are chunked.
async function inChunks(db, sql, ids, ...before) {
  const out = [];
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    out.push(...(await db.all(sql.replace('(?*)', '(' + part.map(() => '?').join(',') + ')'), ...before, ...part)));
  }
  return out;
}

export const publicPt = pt => ({ id: pt.id, slug: pt.slug, brand_name: pt.brand_name, tagline: pt.tagline, description: pt.description, about: pt.about, accent: pt.accent, background: pt.background, foreground: pt.foreground, features: JSON.parse(pt.features), published: Boolean(pt.published), ...publicContactFields(pt) });

/** Blocks with sessions, availability and paid count, in 2 queries for any number of blocks. */
export async function viewBlocks(db, blocks, now = Date.now()) {
  if (!blocks.length) return [];
  const ids = blocks.map(b => b.id);
  const sessions = (await inChunks(db, 'SELECT id,block_id,starts_at,starts_epoch,duration_minutes FROM class_sessions WHERE block_id IN (?*)', ids)).sort((a, b) => a.starts_epoch - b.starts_epoch);
  const counts = await inChunks(db, "SELECT block_id, sum(status='paid') paid, sum(status='paid' OR (status='pending' AND expires_at>?)) used FROM bookings WHERE block_id IN (?*) GROUP BY block_id", ids, now);
  const byBlock = Object.fromEntries(counts.map(c => [c.block_id, c]));
  // RC-30: saved payment options (PT form shape); the public page swaps in enabled quotes.
  const plans = await inChunks(db, 'SELECT block_id,plan,enabled,amount_pence,count FROM block_payment_plans WHERE block_id IN (?*)', ids);
  return blocks.map(({ create_key, ...b }) => {
    const s = sessions.filter(x => x.block_id === b.id).map(({ block_id, ...rest }) => rest);
    const c = byBlock[b.id] || { paid: 0, used: 0 };
    return { ...b, sessions: s, available: Math.max(0, b.capacity - (c.used || 0)), paid_count: c.paid || 0, can_book: Boolean(b.published && !b.closed && s.length && s[0].starts_epoch > now), ...optionsConfig(b, plans.filter(p => p.block_id === b.id)) };
  });
}

/** Bookings (already scoped) with sessions + attendance, in 2 extra queries. */
export async function withSessions(db, bookings, { reasons = false } = {}) {
  if (!bookings.length) return [];
  const blockIds = [...new Set(bookings.map(b => b.block_id))], bookingIds = bookings.map(b => b.id);
  const sessions = (await inChunks(db, 'SELECT * FROM class_sessions WHERE block_id IN (?*)', blockIds)).sort((a, b) => a.starts_epoch - b.starts_epoch);
  const attendance = await inChunks(db, 'SELECT booking_id,session_id,status FROM attendance WHERE booking_id IN (?*)', bookingIds);
  // PT/admin only: why a booking is in 'review' (cutover duplicate import; see src/cutover.mjs).
  const reviewIds = reasons ? bookings.filter(b => b.status === 'review').map(b => b.id) : [];
  const reviewRows = reviewIds.length ? await inChunks(db, "SELECT target_id,action FROM audit_log WHERE action LIKE 'duplicate_import:kept=%' AND target_id IN (?*)", reviewIds) : [];
  const reasonOf = Object.fromEntries(reviewRows.map(r => [r.target_id, parseReviewReason(r.action)]));
  return bookings.map(b => {
    const { checkout_token, checkout_url, ...safe } = b;
    return { ...safe, ...(reasons ? { review_reason: b.status === 'review' ? reasonOf[b.id] || { code: 'payment_review' } : null } : {}), sessions: sessions.filter(s => s.block_id === b.block_id).map(s => ({ ...s, attendance_status: attendance.find(a => a.booking_id === b.id && a.session_id === s.id)?.status || 'unmarked' })) };
  });
}

export async function dashboard(db, user, { paymentMode, integration, now = Date.now() }) {
  const scope = scopeFor(db, user);
  if (user.role === 'customer') return { bookings: await withSessions(db, await scope.bookings()) };
  if (user.role === 'pt') {
    const pt = await db.get('SELECT * FROM pts WHERE id=?', user.pt_id);
    const blocks = await viewBlocks(db, await scope.blocks(), now);
    const bookings = await withSessions(db, await scope.bookings(), { reasons: true });
    const outbox = await scope.outbox(100);
    const c = await stripeConnection(db, pt.id, paymentMode, integration);
    const noShows = (await db.get("SELECT count(*) n FROM attendance a JOIN bookings b ON b.id=a.booking_id JOIN blocks c ON c.id=b.block_id WHERE c.pt_id=? AND a.status='no_show'", user.pt_id)).n;
    return {
      pt: { ...publicPt(pt), ...ptProfile(pt), profile_missing: profileMissing(pt), stripe_account_id: c?.account_id || null, stripe_routing: c?.routing || null, stripe_connected: Boolean(c), stripe_ready: Boolean(c?.ready), stripe: connectStatusView(c, { mode: paymentMode }) },
      blocks, bookings, outbox,
      instalments: planCounts(bookings),
      stats: {
        confirmed: bookings.filter(b => b.status === 'paid').length,
        revenue_pence: bookings.filter(b => b.paid_at && b.mode === paymentMode && isStripe(b.mode)).reduce((n, b) => n + b.amount_pence - b.refunded_pence, 0),
        refunds_pence: bookings.filter(b => b.mode === paymentMode && isStripe(b.mode)).reduce((n, b) => n + b.refunded_pence, 0),
        demo_revenue_pence: bookings.filter(b => b.status === 'paid' && b.mode === 'demo').reduce((n, b) => n + b.amount_pence, 0),
        no_shows: noShows
      }
    };
  }
  // admin (unscoped by definition)
  const ptRows = await db.all("SELECT p.*,u.name owner_name,u.email owner_email,u.active owner_active FROM pts p LEFT JOIN users u ON u.pt_id=p.id AND u.role='pt' AND u.deleted_at IS NULL WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC");
  const allBlocks = await viewBlocks(db, await scope.blocks(), now);
  const pts = [];
  for (const p of ptRows) {
    const c = await stripeConnection(db, p.id, paymentMode, integration);
    pts.push({ ...publicPt(p), owner_name: p.owner_name, owner_email: p.owner_email, owner_active: Boolean(p.owner_active), stripe_connected: Boolean(c), stripe_ready: Boolean(c?.ready), stripe_account_id: c?.account_id || null, stripe: connectStatusView(c, { mode: paymentMode }), blocks: allBlocks.filter(b => b.pt_id === p.id) });
  }
  const bookings = await withSessions(db, await scope.bookings(), { reasons: true });
  return {
    pts, bookings, outbox: await scope.outbox(100), instalments: planCounts(bookings),
    stats: { pts: pts.length, customers: (await db.get("SELECT count(*) n FROM users WHERE role='customer'")).n, confirmed: bookings.filter(b => b.status === 'paid').length },
    quotes: MOTIVATIONS
  };
}

// ---- RC-30 instalment plans (PT/admin) ----
const PLAN_LIVE = ['paid', 'review'];
/** CR m2: payment 1 landed after the hold lapsed (booking in review, no place). The plan was
 *  stopped automatically; the trainer decides (refund payment 1, or add a place). */
const needsAttention = b => b.status === 'review';
const planCounts = bookings => {
  const plans = bookings.filter(b => b.plan && b.plan !== 'upfront' && PLAN_LIVE.includes(b.status) && b.plan_status);
  return { past_due_count: plans.filter(b => b.plan_status === 'past_due').length, active_count: plans.filter(b => b.plan_status === 'active').length, needs_attention_count: plans.filter(needsAttention).length };
};
const PLAN_STATUSES = ['active', 'past_due', 'completed', 'stopped'];

/** Instalment rows for already-scoped booking ids. */
export async function instalmentRows(db, bookingIds) {
  if (!bookingIds.length) return [];
  return (await inChunks(db, 'SELECT * FROM booking_instalments WHERE booking_id IN (?*)', bookingIds)).sort((a, b) => a.seq - b.seq);
}
/** GET /api/pt/instalment-plans: the caller's (PT) or every (admin) instalment plan. */
export async function instalmentPlans(db, user, { status = 'all' } = {}) {
  if (status !== 'all' && !PLAN_STATUSES.includes(status)) throw httpError(400, 'Unknown plan status filter.', { code: 'FIELDS_INVALID', fields: ['status'] });
  const scope = scopeFor(db, user);
  const all = (await scope.bookings()).filter(b => b.plan && b.plan !== 'upfront' && PLAN_LIVE.includes(b.status) && b.plan_status);
  const counts = planCounts(all);
  const chosen = status === 'all' ? all : all.filter(b => b.plan_status === status);
  const rows = await instalmentRows(db, chosen.map(b => b.id));
  return {
    past_due_reminder: { show: counts.past_due_count > 0, count: counts.past_due_count, message: counts.past_due_count ? PAST_DUE_MESSAGE(counts.past_due_count) : null },
    needs_attention: { count: counts.needs_attention_count, message: counts.needs_attention_count ? NEEDS_ATTENTION_MESSAGE(counts.needs_attention_count) : null },
    plans: chosen.map(b => ({
      booking_id: b.id, block_id: b.block_id, block_title: b.title,
      customer: { name: b.customer_name, email: b.customer_email },
      created_at: new Date(b.created_at).toISOString(),
      needs_attention: needsAttention(b), attention_reason: needsAttention(b) ? 'late_payment' : null,
      ...planView(b, rows, { canStop: user.role === 'pt' })
    }))
  };
}
