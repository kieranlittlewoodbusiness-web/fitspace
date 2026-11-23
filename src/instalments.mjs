// RC-30 block instalment payments (MVP): pure helpers shared by the Writer ops, the read
// models and the webhook handler. No SQL here. Money is integer pence (GBP); dates are epoch
// ms internally and ISO 8601 UTC in API responses. Contract: docs/rc-30-api-contract.md.
import { httpError } from './util.mjs';

export const PLANS = Object.freeze(['upfront', 'weekly', 'monthly']);
export const INSTALMENT_PLANS = Object.freeze(['weekly', 'monthly']);
export const INTERVAL = Object.freeze({ weekly: 'week', monthly: 'month' });
export const MAX_COUNT = Object.freeze({ weekly: 52, monthly: 12 });
export const MIN_PAYMENT_PENCE = 30; // Stripe's GBP card minimum
export const MAX_PENCE = 1000000;
const WEEK_MS = 7 * 86400000;
const TOLERANCE_MS = 3 * 86400000;

const invalid = (message, fields) => httpError(400, message, { code: 'FIELDS_INVALID', fields });
const planInvalid = (message, fields) => httpError(400, message, { code: 'PLAN_INVALID', fields });
export const exceedsBlock = (status = 400) => httpError(status, "The last payment would fall after the block's final session.", { code: 'PLAN_EXCEEDS_BLOCK' });

/** Add whole calendar months in UTC, clamping to the month's last day (as Stripe does). */
export function addMonths(ms, n) {
  const d = new Date(ms);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}
/** Due time of payment `seq` (1-based) for a plan starting at `startMs`. */
export const dueAt = (plan, startMs, seq) => (plan === 'monthly' ? addMonths(startMs, seq - 1) : plan === 'weekly' ? startMs + (seq - 1) * WEEK_MS : startMs);

/**
 * Per-payment amounts with the RC-8 discount hook. `discount` is null (RC-8 not built) or
 * { kind: 'percent'|'fixed', amount }. Rules: list = amount × count; a percent discount is
 * rounded half up; the discount never takes the total below 0; each payment is
 * floor(total / count) and the leftover pence go on payment 1, so the sum is exactly total.
 */
export function planAmounts({ amount_pence, count, discount = null }) {
  const list = amount_pence * count;
  let off = 0;
  if (discount) off = discount.kind === 'percent' ? Math.floor((list * discount.amount + 50) / 100) : discount.amount;
  off = Math.min(Math.max(0, off), list);
  const total = list - off;
  const base = Math.floor(total / count);
  const amounts = Array.from({ length: count }, (_, i) => (i === 0 ? base + (total - base * count) : base));
  return { list_total_pence: list, discount_pence: off, total_pence: total, amounts };
}

const isInt = v => Number.isInteger(v);
/**
 * Validate `payment_options` from the PT block form. Returns null when absent (no change), or
 * { upfront: { enabled, price_pence|null }, weekly: {enabled, amount_pence, count}|null, monthly: ...|null }.
 */
export function parsePaymentOptions(raw) {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Payment options are not valid.', ['payment_options']);
  const out = { upfront: { enabled: true, price_pence: null }, weekly: null, monthly: null };
  for (const key of Object.keys(raw)) if (!PLANS.includes(key)) throw invalid('Unknown payment option.', ['payment_options.' + key]);
  const u = raw.upfront;
  if (u !== undefined) {
    if (!u || typeof u !== 'object' || typeof u.enabled !== 'boolean') throw invalid('Upfront payment option is not valid.', ['payment_options.upfront.enabled']);
    // Upfront off: its price is ignored (any value). Upfront on: whole pence, range checked in blockFields.
    if (u.enabled && u.price_pence !== undefined && u.price_pence !== null && !isInt(u.price_pence)) throw invalid('Upfront price must be whole pence.', ['payment_options.upfront.price_pence']);
    out.upfront = { enabled: u.enabled, price_pence: u.enabled ? u.price_pence ?? null : null };
  }
  for (const plan of INSTALMENT_PLANS) {
    const p = raw[plan];
    if (p === undefined || p === null) continue;
    const f = k => `payment_options.${plan}.${k}`;
    if (typeof p !== 'object' || typeof p.enabled !== 'boolean') throw invalid('Instalment option is not valid.', [f('enabled')]);
    const hasValues = p.amount_pence !== undefined && p.amount_pence !== null && p.count !== undefined && p.count !== null;
    if (!p.enabled && !hasValues) continue; // disabled with nothing to keep
    if (!isInt(p.amount_pence)) throw invalid('Instalment amount must be whole pence.', [f('amount_pence')]);
    if (!isInt(p.count)) throw invalid('Number of payments must be a whole number.', [f('count')]);
    if (p.amount_pence < MIN_PAYMENT_PENCE || p.amount_pence > MAX_PENCE) throw planInvalid(`Each payment must be between £0.30 and £${MAX_PENCE / 100}.`, [f('amount_pence')]);
    if (p.count < 2 || p.count > MAX_COUNT[plan]) throw planInvalid(`${plan === 'weekly' ? 'Weekly' : 'Monthly'} plans need 2–${MAX_COUNT[plan]} payments.`, [f('count')]);
    out[plan] = { enabled: p.enabled, amount_pence: p.amount_pence, count: p.count };
  }
  if (out.upfront.enabled === false && !out.weekly?.enabled && !out.monthly?.enabled) throw httpError(400, 'Turn on at least one way to pay.', { code: 'NO_PAYMENT_OPTION' });
  return out;
}

/** True when the plan's last payment (projected from `startMs`) is on or before the final session. */
export const fitsBlock = (plan, count, lastSessionMs, startMs) => dueAt(plan, startMs, count) <= lastSessionMs;

/** Saved config view for the PT form: { payment_options, totals }. `plans` = block_payment_plans rows. */
export function optionsConfig(block, plans) {
  const row = name => plans.find(p => p.plan === name);
  const view = name => { const r = row(name); return r ? { enabled: Boolean(r.enabled), amount_pence: r.amount_pence, count: r.count } : { enabled: false, amount_pence: null, count: null }; };
  const total = name => { const r = row(name); return r ? r.amount_pence * r.count : null; };
  return {
    payment_options: { upfront: { enabled: block.upfront_enabled !== 0, price_pence: block.price_pence }, weekly: view('weekly'), monthly: view('monthly') },
    totals: { upfront: block.price_pence, weekly: total('weekly'), monthly: total('monthly') }
  };
}

const iso = ms => new Date(ms).toISOString();
/** A checkout quote for one plan. `planRow` is null for upfront. */
export function quoteFor(block, plan, planRow, { now = Date.now(), discount = null } = {}) {
  if (plan === 'upfront') {
    return { plan: 'upfront', interval: null, count: 1, amount_pence: block.price_pence, list_total_pence: block.price_pence, discount: null, total_pence: block.price_pence, today_pence: block.price_pence, payments: [{ seq: 1, amount_pence: block.price_pence, due_at: iso(now) }] };
  }
  const a = planAmounts({ amount_pence: planRow.amount_pence, count: planRow.count, discount: discount && discount.rule });
  return {
    plan, interval: INTERVAL[plan], count: planRow.count, amount_pence: planRow.amount_pence,
    list_total_pence: a.list_total_pence, discount: discount ? { code: discount.code, discount_pence: a.discount_pence } : null,
    total_pence: a.total_pence, today_pence: a.amounts[0],
    payments: a.amounts.map((amount, i) => ({ seq: i + 1, amount_pence: amount, due_at: iso(dueAt(plan, now, i + 1)) }))
  };
}

/** Enabled, still-fitting options for the public block read (no discount). */
export function publicOptions(block, plans, lastSessionMs, now = Date.now()) {
  const out = [];
  if (block.upfront_enabled !== 0) out.push(quoteFor(block, 'upfront', null, { now }));
  for (const plan of INSTALMENT_PLANS) {
    const r = plans.find(p => p.plan === plan && p.enabled);
    if (r && fitsBlock(plan, r.count, lastSessionMs, now)) out.push(quoteFor(block, plan, r, { now }));
  }
  return out;
}

/**
 * Which payment of a plan a Stripe invoice is for, from its billing period start (unix s)
 * relative to the plan anchor (payment 1's period start, unix s). null when it matches no
 * payment within ±3 days.
 */
export function seqFromPeriod(plan, anchorSec, periodStartSec) {
  if (!Number.isFinite(anchorSec) || !Number.isFinite(periodStartSec)) return null;
  const a = anchorSec * 1000, p = periodStartSec * 1000;
  let k;
  if (plan === 'weekly') k = Math.round((p - a) / WEEK_MS);
  else {
    const da = new Date(a), dp = new Date(p);
    k = (dp.getUTCFullYear() - da.getUTCFullYear()) * 12 + dp.getUTCMonth() - da.getUTCMonth();
    const best = [k - 1, k, k + 1].map(n => [n, Math.abs(addMonths(a, n) - p)]).sort((x, y) => x[1] - y[1])[0];
    k = best[0];
  }
  if (k < 0 || Math.abs(dueAt(plan, a, k + 1) - p) > TOLERANCE_MS) return null;
  return k + 1;
}

/** API view of one instalment row. */
export function paymentView(r) {
  const v = { seq: r.seq, amount_pence: r.amount_pence, due_at: iso(r.due_at), status: r.status };
  if (r.status === 'paid') v.paid_at = r.paid_at ? iso(r.paid_at) : null;
  if (r.status === 'failed') Object.assign(v, { attempts: r.attempts, next_retry_at: r.next_retry_at ? iso(r.next_retry_at) : null, failure: r.failure || null });
  return v;
}

export const PAST_DUE_MESSAGE = n => `${n} plan${n === 1 ? ' has' : 's have'} a failed payment. Stripe retries automatically. Check what happens after the final retry in your Stripe Billing settings (set it to leave the subscription past due).`;

/** Plan fields for one booking row (from scopeFor) and its instalment rows. `canStop`:
 *  undefined -> no can_stop key (customers); true only for the owning PT (PM ruling). */
export function planView(b, rows, { canStop } = {}) {
  const mine = rows.filter(r => r.booking_id === b.id);
  const paid = mine.filter(r => r.status === 'paid').reduce((n, r) => n + r.amount_pence, 0);
  const total = b.total_pence ?? b.amount_pence;
  return {
    plan: b.plan, status: b.plan_status, count: b.plan_count, today_pence: mine.find(r => r.seq === 1)?.amount_pence ?? b.amount_pence,
    list_total_pence: b.list_price_pence ?? total, discount_pence: b.discount_pence || 0, total_pence: total,
    paid_pence: paid, remaining_pence: Math.max(0, total - paid),
    ...(canStop === undefined ? {} : { can_stop: canStop === true && ['active', 'past_due'].includes(b.plan_status) }),
    payments: mine.map(paymentView)
  };
}

