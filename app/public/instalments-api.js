// RC-30 client adapter. Shaped to docs/rc-30-api-contract.md (8a6360c3).
// Live mode calls the documented routes; mock mode is for tests and the local harness
// (?instalments_mock=1 or localStorage.instalments_mock=1). Wiring stays in this file.

export const PLAN_IDS = Object.freeze(['upfront', 'weekly', 'monthly']);
export const PLAN_LABELS = Object.freeze({ upfront: 'Pay upfront', weekly: 'Pay weekly', monthly: 'Pay monthly' });
export const WEEKLY_COUNT = Object.freeze({ min: 2, max: 52 });
export const MONTHLY_COUNT = Object.freeze({ min: 2, max: 12 });
export const MIN_INSTALMENT_PENCE = 30;
export const MIN_UPFRONT_PENCE = 100;
export const MAX_PRICE_PENCE = 1000000;

// Friendly copy for every contract error code. The UI branches on `code` only.
export const ERROR_COPY = Object.freeze({
  NO_PAYMENT_OPTION: 'Choose at least one payment option: pay upfront, weekly or monthly.',
  PLAN_INVALID: 'Check the amounts and number of payments. An upfront price must be £1 to £10,000, weekly plans need 2 to 52 payments, monthly plans need 2 to 12, and each instalment must be at least 30p.',
  PLAN_EXCEEDS_BLOCK: 'The last payment would fall after the final session. Reduce the number of payments or choose a shorter plan.',
  FIELDS_INVALID: 'Some payment option fields are not valid. Check the highlighted fields and try again.',
  DISCOUNT_INVALID: 'That discount code cannot be used on this booking.',
  AUTH_REQUIRED: 'Sign in to continue.',
  UNAUTHENTICATED: 'Sign in to continue.',
  FORBIDDEN: 'You do not have permission to do that.',
  NOT_FOUND: 'This page is not available.',
  PLAN_NOT_OFFERED: 'That payment option is not available for this class.',
  BLOCK_UNAVAILABLE: 'This class is full, closed or no longer available to book.',
  PLACE_TAKEN: 'That place has just been taken. Choose another class or try again.',
  PAYMENT_IN_PROGRESS: 'A checkout is already open for this booking.',
  PLAN_NOT_ACTIVE: 'This instalment plan has already been completed or stopped.',
  CONTACT_COACH: 'Completed payments must be refunded by your coach.',
  PAYMENTS_NOT_READY: 'Card payments are not available for this coach yet.'
});

export function friendlyError(err) {
  const code = err && err.code;
  if (code && ERROR_COPY[code]) return ERROR_COPY[code];
  if (err && err.error) return String(err.error);
  if (err && err.message) return String(err.message);
  return 'Something went wrong.';
}

export function followCheckoutUrl(url) {
  if (!url || typeof url !== 'string') return null;
  return url.startsWith('/') ? 'in-app' : 'redirect';
}

export function instalmentsMockHostAllowed(host) {
  const name = String(host || '').toLowerCase();
  if (name === 'localhost' || name === '[::1]') return true;
  if (name === '127.0.0.1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  return name.endsWith('.workers.dev');
}

export function instalmentsModeFromLocation(loc = (typeof location !== 'undefined' ? location : { search: '' }), storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  const host = (loc && loc.hostname) || (typeof location !== 'undefined' ? location.hostname : '');
  if (!instalmentsMockHostAllowed(host)) return 'live';
  try {
    if (storage && storage.getItem('instalments_mock') === '1') return 'mock';
  } catch (e) { /* private mode */ }
  try {
    if (new URLSearchParams(loc.search || '').get('instalments_mock') === '1') return 'mock';
  } catch (e) { /* ignore */ }
  return 'live';
}

export function formatDueAt(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date);
}

export function poundsToPence(value) {
  if (value === '' || value == null) return null;
  const pounds = Number(value);
  if (!Number.isFinite(pounds)) return NaN;
  return Math.round(pounds * 100);
}

export function paymentStatusLabel(status) {
  if (status === 'void') return 'Cancelled';
  if (status === 'paid') return 'Paid';
  if (status === 'upcoming') return 'Upcoming';
  if (status === 'failed') return 'Failed';
  return status ? String(status) : '';
}


export function formatPence(pence) {
  const n = Number(pence);
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: n % 100 ? 2 : 0 }).format(n / 100).replace(/ |\u202f/g, '\u00a0');
}

export function paymentDotLabel(pay) {
  if (!pay) return '';
  const parts = [];
  if (pay.seq != null) parts.push('Payment ' + pay.seq);
  const status = paymentStatusLabel(pay.status);
  if (status) parts.push(status);
  if (pay.amount_pence != null) parts.push(formatPence(pay.amount_pence));
  const due = formatDueAt(pay.due_at);
  if (due) parts.push(due);
  if (pay.next_retry_at) parts.push('Next retry ' + formatDueAt(pay.next_retry_at));
  if (pay.failure) parts.push(String(pay.failure));
  return parts.join(' · ');
}

export function planStatusLabel(status) {
  if (status === 'active') return 'Active';
  if (status === 'past_due') return 'Past due';
  if (status === 'completed') return 'Completed';
  if (status === 'stopped') return 'Stopped';
  return status ? String(status) : '';
}

export const LATE_PAYMENT_HINT = 'A late payment came in after this place was released. Refund the first payment or add a place for this client.';

export function attentionReasonLabel(reason) {
  if (reason === 'late_payment') return 'Late payment, plan stopped';
  return reason ? String(reason) : '';
}

export function needsAttentionCopy(attention) {
  const count = Number(attention && attention.count) || 0;
  if (count <= 0) return '';
  const message = attention && attention.message;
  if (message != null && String(message).trim() !== '') return String(message);
  return count === 1 ? '1 plan needs your attention' : count + ' plans need your attention';
}

export function sortPlansForDisplay(plans) {
  return [...(plans || [])].sort((a, b) => Number(!!b.needs_attention) - Number(!!a.needs_attention));
}

/** Server rule, used only by the mock: leftover pence go on payment 1. The UI displays the quote as returned. */
export function splitInstalments(totalPence, count) {
  const total = Number(totalPence);
  const n = Number(count);
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(n) || n < 1) return [];
  const base = Math.floor(total / n);
  const leftover = total - base * n;
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + leftover : base));
}

export function addInterval(isoOrDate, interval, steps) {
  const date = new Date(isoOrDate);
  if (interval === 'week') date.setUTCDate(date.getUTCDate() + 7 * steps);
  else if (interval === 'month') date.setUTCMonth(date.getUTCMonth() + steps);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function planTotals(options) {
  const totals = { upfront: 0, weekly: 0, monthly: 0 };
  if (options?.upfront) totals.upfront = Number(options.upfront.price_pence) || 0;
  if (options?.weekly) totals.weekly = (Number(options.weekly.amount_pence) || 0) * (Number(options.weekly.count) || 0);
  if (options?.monthly) totals.monthly = (Number(options.monthly.amount_pence) || 0) * (Number(options.monthly.count) || 0);
  return totals;
}

export function emptyPaymentOptions() {
  return {
    upfront: { enabled: true, price_pence: 0 },
    weekly: { enabled: false, amount_pence: 0, count: 8 },
    monthly: { enabled: false, amount_pence: 0, count: 2 }
  };
}

export function optionsFromBlock(block) {
  const options = emptyPaymentOptions();
  const raw = block?.payment_options;
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    for (const id of PLAN_IDS) {
      if (raw[id] && typeof raw[id] === 'object') options[id] = { ...options[id], ...raw[id] };
    }
    return options;
  }
  if (block && block.price_pence != null) options.upfront.price_pence = Number(block.price_pence) || 0;
  return options;
}

export function parsePaymentOptionsFromForm(fd) {
  const enabled = name => fd.get(name) === 'on' || fd.get(name) === 'true' || fd.has(name);
  const upfrontOn = enabled('payment_upfront');
  const weeklyOn = enabled('payment_weekly');
  const monthlyOn = enabled('payment_monthly');
  const price = poundsToPence(fd.get('price') ?? fd.get('payment_upfront_price'));
  const weeklyAmount = poundsToPence(fd.get('payment_weekly_amount'));
  const monthlyAmount = poundsToPence(fd.get('payment_monthly_amount'));
  return compactPaymentOptions({
    upfront: { enabled: upfrontOn, price_pence: price == null ? 0 : price },
    weekly: { enabled: weeklyOn, amount_pence: weeklyAmount == null ? 0 : weeklyAmount, count: Number(fd.get('payment_weekly_count') || 0) },
    monthly: { enabled: monthlyOn, amount_pence: monthlyAmount == null ? 0 : monthlyAmount, count: Number(fd.get('payment_monthly_count') || 0) }
  });
}

export function compactPaymentOptions(options) {
  const out = {};
  for (const id of PLAN_IDS) {
    const plan = options?.[id];
    if (!plan?.enabled) {
      out[id] = { enabled: false };
    } else if (id === 'upfront') {
      out[id] = { enabled: true, price_pence: plan.price_pence };
    } else {
      out[id] = { enabled: true, amount_pence: plan.amount_pence, count: plan.count };
    }
  }
  return out;
}

export function validatePaymentOptions(options, { lastSessionAt, now } = {}) {
  const fields = [];
  if (!options?.upfront?.enabled && !options?.weekly?.enabled && !options?.monthly?.enabled) {
    return { ok: false, code: 'NO_PAYMENT_OPTION', fields: ['payment_options'] };
  }
  const typeFields = [];
  if (options.upfront?.enabled) {
    const price = options.upfront.price_pence;
    if (typeof price !== 'number' || Number.isNaN(price) || !Number.isInteger(price)) typeFields.push('payment_options.upfront.price_pence');
    else if (price < MIN_UPFRONT_PENCE || price > MAX_PRICE_PENCE) fields.push('payment_options.upfront.price_pence');
  }
  if (options.weekly?.enabled) {
    const amount = options.weekly.amount_pence;
    const count = options.weekly.count;
    if (typeof amount !== 'number' || Number.isNaN(amount) || !Number.isInteger(amount)) typeFields.push('payment_options.weekly.amount_pence');
    else if (amount < MIN_INSTALMENT_PENCE || amount > MAX_PRICE_PENCE) fields.push('payment_options.weekly.amount_pence');
    if (typeof count !== 'number' || Number.isNaN(count) || !Number.isInteger(count)) typeFields.push('payment_options.weekly.count');
    else if (count < WEEKLY_COUNT.min || count > WEEKLY_COUNT.max) fields.push('payment_options.weekly.count');
  }
  if (options.monthly?.enabled) {
    const amount = options.monthly.amount_pence;
    const count = options.monthly.count;
    if (typeof amount !== 'number' || Number.isNaN(amount) || !Number.isInteger(amount)) typeFields.push('payment_options.monthly.amount_pence');
    else if (amount < MIN_INSTALMENT_PENCE || amount > MAX_PRICE_PENCE) fields.push('payment_options.monthly.amount_pence');
    if (typeof count !== 'number' || Number.isNaN(count) || !Number.isInteger(count)) typeFields.push('payment_options.monthly.count');
    else if (count < MONTHLY_COUNT.min || count > MONTHLY_COUNT.max) fields.push('payment_options.monthly.count');
  }
  if (typeFields.length) return { ok: false, code: 'FIELDS_INVALID', fields: typeFields };
  if (fields.length) return { ok: false, code: 'PLAN_INVALID', fields };
  if (lastSessionAt) {
    const origin = now ? new Date(now) : new Date();
    const last = new Date(lastSessionAt);
    for (const id of ['weekly', 'monthly']) {
      const plan = options[id];
      if (!plan?.enabled) continue;
      const end = new Date(addInterval(origin, id === 'weekly' ? 'week' : 'month', plan.count - 1));
      if (end.getTime() > last.getTime()) {
        return { ok: false, code: 'PLAN_EXCEEDS_BLOCK', fields: [`payment_options.${id}.count`] };
      }
    }
  }
  return { ok: true, totals: planTotals(options) };
}

export function enabledQuotesFromBlock(block, now) {
  const raw = block?.payment_options;
  if (Array.isArray(raw)) return raw.filter(p => p && p.plan);
  const options = optionsFromBlock(block);
  const origin = now ? new Date(now) : new Date();
  const lastSession = block?.sessions?.length ? block.sessions[block.sessions.length - 1].starts_at : null;
  const lastMs = lastSession ? new Date(lastSession).getTime() : null;
  const quotes = [];
  if (options.upfront.enabled) {
    const amount = options.upfront.price_pence;
    quotes.push({
      plan: 'upfront',
      today_pence: amount,
      total_pence: amount,
      payments: [{ seq: 1, amount_pence: amount, due_at: origin.toISOString().replace(/\.\d{3}Z$/, 'Z') }]
    });
  }
  for (const [id, interval] of [['weekly', 'week'], ['monthly', 'month']]) {
    const plan = options[id];
    if (!plan.enabled) continue;
    const amounts = splitInstalments(plan.amount_pence * plan.count, plan.count);
    const payments = amounts.map((amount_pence, i) => ({
      seq: i + 1,
      amount_pence,
      due_at: addInterval(origin, interval, i)
    }));
    if (lastMs != null && new Date(payments[payments.length - 1].due_at).getTime() > lastMs) continue;
    quotes.push({
      plan: id,
      interval,
      count: plan.count,
      amount_pence: plan.amount_pence,
      today_pence: amounts[0],
      total_pence: amounts.reduce((a, b) => a + b, 0),
      payments
    });
  }
  if (!quotes.length && block?.price_pence != null) {
    const amount = Number(block.price_pence) || 0;
    quotes.push({
      plan: 'upfront',
      today_pence: amount,
      total_pence: amount,
      payments: [{ seq: 1, amount_pence: amount, due_at: origin.toISOString().replace(/\.\d{3}Z$/, 'Z') }]
    });
  }
  return quotes;
}

function apiError(code, { status = 400, fields, url, booking_id } = {}) {
  const err = new Error(ERROR_COPY[code] || code);
  err.code = code;
  err.error = ERROR_COPY[code] || code;
  err.status = status;
  if (fields) err.fields = fields;
  if (url) err.url = url;
  if (booking_id) err.booking_id = booking_id;
  return err;
}


function longWeeklyPlan() {
  const count = 52;
  const amount = 1250;
  const start = new Date('2026-11-23T22:00:00Z');
  const payments = Array.from({ length: count }, (_, i) => {
    const due = new Date(start);
    due.setUTCDate(due.getUTCDate() + 7 * i);
    const due_at = due.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const seq = i + 1;
    if (i < 8) return { seq, amount_pence: amount, due_at, status: 'paid', paid_at: due_at };
    return { seq, amount_pence: amount, due_at, status: 'upcoming' };
  });
  return {
    booking_id: 'bk_year',
    block_id: 'blk_year',
    block_title: '52-week strength block',
    customer: { name: 'Alex Morgan', email: 'alex@example.com' },
    plan: 'weekly',
    status: 'active',
    count,
    list_total_pence: amount * count,
    discount_pence: 0,
    total_pence: amount * count,
    paid_pence: amount * 8,
    remaining_pence: amount * 44,
    created_at: '2026-11-23T22:00:00Z',
    needs_attention: false,
    attention_reason: null,
    can_stop: true,
    payments
  };
}

const SPEC_EXAMPLE = {
  options: {
    upfront: { enabled: true, price_pence: 10000 },
    weekly: { enabled: true, amount_pence: 1250, count: 8 },
    monthly: { enabled: false, amount_pence: 5000, count: 2 }
  },
  block: {
    id: 'blk_example',
    title: '8-week strength block',
    sessions: [
      { starts_at: '2026-11-24T19:00:00' },
      { starts_at: '2027-01-12T19:00:00' }
    ]
  },
  reminder: {
    show: true,
    count: 1,
    message: '1 plan has a failed payment. Stripe retries automatically. Check what happens after the final retry in your Stripe Billing settings (set it to leave the subscription past due).'
  },
  plan: {
    booking_id: 'bk_example',
    block_id: 'blk_example',
    block_title: '8-week strength block',
    customer: { name: 'Sam Lee', email: 'sam@example.com' },
    plan: 'weekly',
    status: 'past_due',
    count: 8,
    list_total_pence: 10000,
    discount_pence: 0,
    total_pence: 10000,
    paid_pence: 2500,
    remaining_pence: 7500,
    created_at: '2026-11-23T22:00:00Z',
    needs_attention: false,
    attention_reason: null,
    can_stop: true,
    payments: [
      { seq: 1, amount_pence: 1250, due_at: '2026-11-23T22:00:00Z', status: 'paid', paid_at: '2026-11-23T22:01:10Z' },
      { seq: 2, amount_pence: 1250, due_at: '2026-11-30T22:00:00Z', status: 'paid', paid_at: '2026-11-30T22:03:00Z' },
      { seq: 3, amount_pence: 1250, due_at: '2026-12-07T22:00:00Z', status: 'failed', attempts: 2, next_retry_at: '2026-12-10T22:00:00Z', failure: 'Card declined' },
      { seq: 4, amount_pence: 1250, due_at: '2026-12-14T22:00:00Z', status: 'upcoming' }
    ]
  },
  attention: {
    count: 1,
    message: '1 plan took a first payment after the booking hold had expired, so there is no place. We stopped further payments. Refund the first payment or add a place.'
  },
  flaggedPlan: {
    booking_id: 'bk_late',
    block_id: 'blk_example',
    block_title: '8-week strength block',
    customer: { name: 'Riley Chen', email: 'riley@example.com' },
    booking_status: 'review',
    needs_attention: true,
    attention_reason: 'late_payment',
    plan: 'weekly',
    status: 'stopped',
    count: 8,
    list_total_pence: 10000,
    discount_pence: 0,
    total_pence: 10000,
    paid_pence: 1250,
    remaining_pence: 0,
    created_at: '2026-11-23T21:30:00Z',
    can_stop: false,
    payments: [
      { seq: 1, amount_pence: 1250, due_at: '2026-11-23T21:30:00Z', status: 'paid', paid_at: '2026-11-23T22:20:00Z' },
      { seq: 2, amount_pence: 1250, due_at: '2026-11-30T21:30:00Z', status: 'void' },
      { seq: 3, amount_pence: 1250, due_at: '2026-12-07T21:30:00Z', status: 'void' },
      { seq: 4, amount_pence: 1250, due_at: '2026-12-14T21:30:00Z', status: 'void' }
    ]
  },
  longPlan: longWeeklyPlan()
};

function createMockApi({ now = () => new Date(), paymentMode = 'stripe_test' } = {}) {
  const blocks = new Map();
  const quotesByToken = new Map();
  const stopByToken = new Map();
  const plans = new Map();
  const paidIds = new Set();
  blocks.set(SPEC_EXAMPLE.block.id, { ...SPEC_EXAMPLE.block, payment_options: structuredClone(SPEC_EXAMPLE.options) });
  plans.set(SPEC_EXAMPLE.plan.booking_id, structuredClone(SPEC_EXAMPLE.plan));
  plans.set(SPEC_EXAMPLE.flaggedPlan.booking_id, structuredClone(SPEC_EXAMPLE.flaggedPlan));
  plans.set(SPEC_EXAMPLE.longPlan.booking_id, structuredClone(SPEC_EXAMPLE.longPlan));
  let ids = 1;

  function savedBlock(id, options) {
    const current = blocks.get(id) || { id, title: SPEC_EXAMPLE.block.title, sessions: SPEC_EXAMPLE.block.sessions };
    const next = { ...current, id, payment_options: structuredClone(options), totals: planTotals(options) };
    blocks.set(id, next);
    return { block: { ...next, totals: planTotals(options) } };
  }

  return {
    mode: 'mock',
    async saveBlockPaymentOptions(blockId, payment_options, { lastSessionAt } = {}) {
      payment_options = compactPaymentOptions(payment_options);
      const check = validatePaymentOptions(payment_options, { lastSessionAt, now: now() });
      if (!check.ok) throw apiError(check.code, { fields: check.fields, status: 400 });
      const id = blockId || SPEC_EXAMPLE.block.id;
      return savedBlock(id, payment_options);
    },
    async getPublicPaymentOptions(block) {
      const stored = block?.id && blocks.get(block.id);
      return enabledQuotesFromBlock(stored || block, now());
    },
    async quoteBooking({ block_id, plan, discount_code }) {
      if (plan != null && plan !== '' && !PLAN_IDS.includes(plan)) {
        throw apiError('FIELDS_INVALID', { status: 400, fields: ['plan'] });
      }
      if (discount_code != null && String(discount_code).trim() !== '') {
        throw apiError('DISCOUNT_INVALID', { status: 400 });
      }
      const block = blocks.get(block_id) || { ...SPEC_EXAMPLE.block, payment_options: SPEC_EXAMPLE.options };
      const quotes = enabledQuotesFromBlock(block, now());
      const found = quotes.find(q => q.plan === plan);
      if (!found) throw apiError('PLAN_NOT_OFFERED', { status: 409 });
      return {
        quote: {
          plan: found.plan,
          count: found.count,
          list_total_pence: found.total_pence,
          discount: null,
          total_pence: found.total_pence,
          today_pence: found.today_pence,
          payments: found.payments
        }
      };
    },
    async createBooking({ block_id, checkout_token, plan = 'upfront', discount_code = null }) {
      if (plan != null && plan !== '' && !PLAN_IDS.includes(plan)) {
        throw apiError('FIELDS_INVALID', { status: 400, fields: ['plan'] });
      }
      const instalment = plan === 'weekly' || plan === 'monthly';
      if (instalment && paymentMode === 'demo') {
        throw apiError('PAYMENTS_NOT_READY', { status: 503 });
      }
      const quoted = await this.quoteBooking({ block_id, plan, discount_code });
      if (checkout_token && quotesByToken.has(checkout_token)) {
        const prev = quotesByToken.get(checkout_token);
        const id = prev.booking_id || prev.booking?.id;
        if (id && paidIds.has(id)) return { booking: { id, status: 'paid' }, url: '/booking/' + id };
        return prev;
      }
      const booking_id = 'bk_mock_' + (ids++);
      let result;
      if (instalment) {
        result = { booking: { id: booking_id }, booking_id, url: '/checkout/' + booking_id };
      } else if (paymentMode === 'demo') {
        result = { booking: { id: booking_id }, url: '/checkout/' + booking_id };
      } else {
        result = { url: 'https://checkout.stripe.com/c/pay/mock_' + booking_id, booking_id };
      }
      quotesByToken.set(checkout_token || booking_id, result);
      return result;
    },
    markPaid(bookingId) {
      paidIds.add(bookingId);
    },
    async listInstalmentPlans({ status = 'all' } = {}) {
      let list = [...plans.values()];
      if (status && status !== 'all') list = list.filter(p => p.status === status);
      const all = [...plans.values()];
      const pastDue = all.filter(p => p.status === 'past_due').length;
      const flagged = all.filter(p => p.needs_attention).length;
      return {
        past_due_reminder: pastDue ? { ...SPEC_EXAMPLE.reminder, show: true, count: pastDue } : { show: false, count: 0, message: '' },
        needs_attention: flagged ? { ...SPEC_EXAMPLE.attention, count: flagged } : { count: 0, message: null },
        plans: list
      };
    },
    async stopInstalmentPlan(bookingId, { request_token } = {}) {
      if (request_token && stopByToken.has(request_token)) return stopByToken.get(request_token);
      const plan = plans.get(bookingId);
      if (!plan) throw apiError('NOT_FOUND', { status: 404 });
      if (plan.status === 'completed' || plan.status === 'stopped') throw apiError('PLAN_NOT_ACTIVE', { status: 409 });
      let voided = 0;
      plan.payments = plan.payments.map(p => {
        if (p.status === 'upcoming' || p.status === 'failed') { voided += 1; return { ...p, status: 'void', next_retry_at: null }; }
        return p;
      });
      plan.status = 'stopped';
      plan.can_stop = false;
      const result = { booking_id: plan.booking_id, status: 'stopped', voided_payments: voided, refunded_pence: 0 };
      if (request_token) stopByToken.set(request_token, result);
      return result;
    },
    async dashboardCounts() {
      const list = [...plans.values()];
      return { instalments: { past_due_count: list.filter(p => p.status === 'past_due').length, active_count: list.filter(p => p.status === 'active').length, needs_attention_count: list.filter(p => p.needs_attention).length } };
    }
  };
}

function createLiveApi(request) {
  if (typeof request !== 'function') throw new Error('Live instalments adapter needs a request function.');
  return {
    mode: 'live',
    async saveBlockPaymentOptions(blockId, payment_options, { lastSessionAt, body } = {}) {
      payment_options = compactPaymentOptions(payment_options);
      const check = validatePaymentOptions(payment_options, { lastSessionAt });
      if (!check.ok) throw apiError(check.code, { fields: check.fields, status: 400 });
      const payload = { ...(body || {}), payment_options };
      if (payment_options.upfront?.enabled) payload.price_pence = payment_options.upfront.price_pence;
      const path = blockId ? '/api/blocks/' + blockId : '/api/blocks';
      return request(path, { method: blockId ? 'PUT' : 'POST', body: payload });
    },
    async getPublicPaymentOptions(block) {
      return enabledQuotesFromBlock(block);
    },
    async quoteBooking({ block_id, plan, discount_code }) {
      return request('/api/bookings/quote', { method: 'POST', body: { block_id, plan, discount_code: discount_code || null } });
    },
    async createBooking({ block_id, checkout_token, plan = 'upfront', discount_code = null }) {
      // C2 v2.1: in-app url (/) is navigated; any other url is a full redirect.
      // booking_id comes from booking_id or booking.id (demo upfront may omit booking_id).
      const result = await request('/api/bookings', { method: 'POST', body: { block_id, checkout_token, plan, discount_code: discount_code || null } });
      const booking_id = result.booking_id || result.booking?.id;
      return { ...result, booking_id, url: result.url };
    },
    async listInstalmentPlans({ status = 'all' } = {}) {
      const query = status && status !== 'all' ? '?status=' + encodeURIComponent(status) : '?status=all';
      return request('/api/pt/instalment-plans' + query);
    },
    async stopInstalmentPlan(bookingId, { request_token } = {}) {
      return request('/api/pt/instalment-plans/' + encodeURIComponent(bookingId) + '/stop', { method: 'POST', body: { request_token } });
    },
    async dashboardCounts(dashboard) {
      if (dashboard?.instalments) return { instalments: dashboard.instalments };
      return { instalments: { past_due_count: 0, active_count: 0 } };
    }
  };
}

export function createInstalmentsApi({ mode = 'live', request, now, paymentMode } = {}) {
  if (mode === 'mock') return createMockApi({ now, paymentMode });
  return createLiveApi(request);
}

if (typeof window !== 'undefined') {
  window.createInstalmentsApi = createInstalmentsApi;
  window.Instalments = {
    PLAN_IDS, PLAN_LABELS, ERROR_COPY, WEEKLY_COUNT, MONTHLY_COUNT, MIN_INSTALMENT_PENCE, MIN_UPFRONT_PENCE, MAX_PRICE_PENCE,
    friendlyError, followCheckoutUrl, instalmentsModeFromLocation, instalmentsMockHostAllowed, formatDueAt, formatPence, poundsToPence,
    paymentStatusLabel, paymentDotLabel, planStatusLabel, LATE_PAYMENT_HINT, attentionReasonLabel, needsAttentionCopy, sortPlansForDisplay, splitInstalments, addInterval, planTotals,
    emptyPaymentOptions, optionsFromBlock, parsePaymentOptionsFromForm, compactPaymentOptions, validatePaymentOptions,
    enabledQuotesFromBlock, createInstalmentsApi
  };
}
