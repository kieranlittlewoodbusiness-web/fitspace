import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ERROR_COPY, PLAN_LABELS, friendlyError, formatDueAt, splitInstalments,
  parsePaymentOptionsFromForm, validatePaymentOptions, enabledQuotesFromBlock,
  optionsFromBlock, createInstalmentsApi, instalmentsModeFromLocation, planTotals
} from '../app/public/instalments-api.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CONTRACT_CODES = [
  'FIELDS_INVALID', 'PLAN_INVALID', 'NO_PAYMENT_OPTION', 'PLAN_EXCEEDS_BLOCK',
  'DISCOUNT_INVALID', 'AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND',
  'PLAN_NOT_OFFERED', 'BLOCK_UNAVAILABLE', 'PLACE_TAKEN', 'PAYMENT_IN_PROGRESS',
  'PLAN_NOT_ACTIVE', 'CONTACT_COACH', 'PAYMENTS_NOT_READY'
];

test('every contract error code has friendly UI copy', () => {
  for (const code of CONTRACT_CODES) {
    assert.equal(typeof ERROR_COPY[code], 'string');
    assert.ok(ERROR_COPY[code].length > 8, code);
    assert.equal(friendlyError({ code }), ERROR_COPY[code]);
  }
  assert.deepEqual(Object.keys(ERROR_COPY).sort(), [...CONTRACT_CODES].sort());
});

test('dates are displayed in Europe/London from ISO UTC', () => {
  // 23 Nov 2026 is GMT (UTC+0)
  assert.match(formatDueAt('2026-11-23T22:00:00Z'), /23 Nov 2026, 22:00/);
  // 10 Jul 2026 is BST (UTC+1)
  assert.match(formatDueAt('2026-07-10T22:00:00Z'), /10 Jul 2026, 23:00/);
});

test('mock leftover pence go on payment 1 and sum to the total after discount', () => {
  assert.deepEqual(splitInstalments(10001, 8), [1251, 1250, 1250, 1250, 1250, 1250, 1250, 1250]);
  assert.equal(splitInstalments(10001, 8).reduce((a, b) => a + b, 0), 10001);
  assert.deepEqual(splitInstalments(9000, 8), [1125, 1125, 1125, 1125, 1125, 1125, 1125, 1125]);
  assert.deepEqual(splitInstalments(10000, 8), [1250, 1250, 1250, 1250, 1250, 1250, 1250, 1250]);
});

function formData(entries) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, String(v));
  return fd;
}

test('form parse and validate match the write-shape payment_options object', () => {
  const options = parsePaymentOptionsFromForm(formData({
    payment_upfront: 'on',
    price: '100',
    payment_weekly: 'on',
    payment_weekly_amount: '12.50',
    payment_weekly_count: '8',
    payment_monthly_amount: '50',
    payment_monthly_count: '2'
  }));
  assert.deepEqual(options, {
    upfront: { enabled: true, price_pence: 10000 },
    weekly: { enabled: true, amount_pence: 1250, count: 8 },
    monthly: { enabled: false, amount_pence: 5000, count: 2 }
  });
  assert.deepEqual(planTotals(options), { upfront: 10000, weekly: 10000, monthly: 10000 });
  assert.equal(validatePaymentOptions(options).ok, true);

  assert.equal(validatePaymentOptions({
    upfront: { enabled: false, price_pence: 0 },
    weekly: { enabled: false, amount_pence: 0, count: 8 },
    monthly: { enabled: false, amount_pence: 0, count: 2 }
  }).code, 'NO_PAYMENT_OPTION');

  const badCount = validatePaymentOptions({
    upfront: { enabled: false, price_pence: 0 },
    weekly: { enabled: true, amount_pence: 1250, count: 1 },
    monthly: { enabled: false, amount_pence: 0, count: 2 }
  });
  assert.equal(badCount.code, 'PLAN_INVALID');
  assert.deepEqual(badCount.fields, ['payment_options.weekly.count']);

  const badType = validatePaymentOptions({
    upfront: { enabled: true, price_pence: '10000' },
    weekly: { enabled: false, amount_pence: 0, count: 8 },
    monthly: { enabled: false, amount_pence: 0, count: 2 }
  });
  assert.equal(badType.code, 'FIELDS_INVALID');
  assert.deepEqual(badType.fields, ['payment_options.upfront.price_pence']);
});

test('PLAN_EXCEEDS_BLOCK when the last instalment would fall after the final session', () => {
  const options = {
    upfront: { enabled: false, price_pence: 0 },
    weekly: { enabled: true, amount_pence: 1250, count: 8 },
    monthly: { enabled: false, amount_pence: 0, count: 2 }
  };
  const now = '2026-11-23T22:00:00Z';
  const ok = validatePaymentOptions(options, { lastSessionAt: '2027-01-12T19:00:00Z', now });
  assert.equal(ok.ok, true);
  const late = validatePaymentOptions(options, { lastSessionAt: '2026-11-24T19:00:00Z', now });
  assert.equal(late.code, 'PLAN_EXCEEDS_BLOCK');
  assert.deepEqual(late.fields, ['payment_options.weekly.count']);
});

test('public block quotes are an enabled-plan array and omit plans that would run past the final session', () => {
  const quotes = enabledQuotesFromBlock({
    payment_options: {
      upfront: { enabled: true, price_pence: 10000 },
      weekly: { enabled: true, amount_pence: 1250, count: 8 },
      monthly: { enabled: false, amount_pence: 5000, count: 2 }
    },
    sessions: [{ starts_at: '2026-11-24T19:00:00' }, { starts_at: '2027-01-12T19:00:00' }]
  }, '2026-11-23T22:00:00Z');
  assert.deepEqual(quotes.map(q => q.plan), ['upfront', 'weekly']);
  const weekly = quotes.find(q => q.plan === 'weekly');
  assert.equal(weekly.count, 8);
  assert.equal(weekly.today_pence, 1250);
  assert.equal(weekly.total_pence, 10000);
  assert.equal(weekly.payments.length, 8);
  assert.equal(weekly.payments[0].due_at, '2026-11-23T22:00:00Z');
  assert.equal(weekly.payments[1].due_at, '2026-11-30T22:00:00Z');
});

test('mock save, quote, booking, list, counts and stop follow the contract shapes', async () => {
  const api = createInstalmentsApi({ mode: 'mock', now: () => new Date('2026-11-23T22:00:00Z') });
  const saved = await api.saveBlockPaymentOptions('blk_example', {
    upfront: { enabled: true, price_pence: 10000 },
    weekly: { enabled: true, amount_pence: 1250, count: 8 },
    monthly: { enabled: false, amount_pence: 5000, count: 2 }
  }, { lastSessionAt: '2027-01-12T19:00:00Z' });
  assert.equal(saved.block.id, 'blk_example');
  assert.deepEqual(saved.block.payment_options.weekly, { enabled: true, amount_pence: 1250, count: 8 });
  assert.deepEqual(saved.block.totals, { upfront: 10000, weekly: 10000, monthly: 10000 });

  const quoted = await api.quoteBooking({ block_id: 'blk_example', plan: 'weekly', discount_code: null });
  assert.equal(quoted.quote.discount, null);
  assert.equal(quoted.quote.total_pence, 10000);
  assert.equal(quoted.quote.list_total_pence, 10000);
  assert.equal(quoted.quote.today_pence, 1250);

  await assert.rejects(
    () => api.quoteBooking({ block_id: 'blk_example', plan: 'weekly', discount_code: 'NEWYEAR10' }),
    err => err.code === 'DISCOUNT_INVALID' && err.status === 400
  );
  await assert.rejects(
    () => api.quoteBooking({ block_id: 'blk_example', plan: 'monthly', discount_code: null }),
    err => err.code === 'PLAN_NOT_OFFERED' && err.status === 409
  );

  const created = await api.createBooking({ block_id: 'blk_example', checkout_token: 'tok-1', plan: 'weekly', discount_code: null });
  assert.ok(created.booking_id);
  assert.ok(created.url);
  const again = await api.createBooking({ block_id: 'blk_example', checkout_token: 'tok-1', plan: 'weekly', discount_code: null });
  assert.deepEqual(again, created);

  const listed = await api.listInstalmentPlans({ status: 'all' });
  assert.equal(listed.past_due_reminder.show, true);
  assert.equal(listed.past_due_reminder.count, 1);
  assert.equal(listed.plans[0].customer.name, 'Sam Lee');
  assert.equal(listed.plans[0].can_stop, true);
  assert.equal(listed.plans[0].total_pence, 10000);
  assert.equal(listed.plans[0].payments[2].status, 'failed');

  const counts = await api.dashboardCounts();
  assert.deepEqual(counts.instalments, { past_due_count: 1, active_count: 0 });

  const stopped = await api.stopInstalmentPlan('bk_example', { request_token: 'stop-1' });
  assert.deepEqual(stopped, { booking_id: 'bk_example', status: 'stopped', voided_payments: 2, refunded_pence: 0 });
  const repeat = await api.stopInstalmentPlan('bk_example', { request_token: 'stop-1' });
  assert.deepEqual(repeat, stopped);
  await assert.rejects(
    () => api.stopInstalmentPlan('bk_example', { request_token: 'stop-2' }),
    err => err.code === 'PLAN_NOT_ACTIVE' && err.status === 409
  );
});

test('live adapter posts the documented routes, CSRF-ready request, and plan payload', async () => {
  const calls = [];
  const request = async (path, opts = {}) => {
    calls.push({ path, ...opts });
    if (path === '/api/blocks/blk_1') return { block: { id: 'blk_1', payment_options: opts.body.payment_options, totals: { upfront: 10000, weekly: 10000, monthly: 0 } } };
    if (path === '/api/bookings/quote') return { quote: { plan: 'weekly', count: 8, list_total_pence: 10000, discount: null, total_pence: 10000, today_pence: 1250, payments: [] } };
    if (path === '/api/bookings') return { booking: { id: 'bk_1' }, booking_id: 'bk_1', url: '/checkout/bk_1' };
    if (path.startsWith('/api/pt/instalment-plans?')) return { past_due_reminder: { show: false, count: 0, message: '' }, plans: [] };
    if (path === '/api/pt/instalment-plans/bk_1/stop') return { booking_id: 'bk_1', status: 'stopped', voided_payments: 3, refunded_pence: 0 };
    throw new Error('unexpected ' + path);
  };
  const api = createInstalmentsApi({ mode: 'live', request });
  await api.saveBlockPaymentOptions('blk_1', {
    upfront: { enabled: true, price_pence: 10000 },
    weekly: { enabled: true, amount_pence: 1250, count: 8 },
    monthly: { enabled: false, amount_pence: 5000, count: 2 }
  }, { body: { title: '8-week strength block' } });
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].path, '/api/blocks/blk_1');
  assert.equal(calls[0].body.price_pence, 10000);
  assert.equal(calls[0].body.payment_options.weekly.count, 8);

  await api.quoteBooking({ block_id: 'blk_1', plan: 'weekly', discount_code: null });
  assert.deepEqual(calls[1], { path: '/api/bookings/quote', method: 'POST', body: { block_id: 'blk_1', plan: 'weekly', discount_code: null } });

  const booked = await api.createBooking({ block_id: 'blk_1', checkout_token: 'tok', plan: 'weekly', discount_code: null });
  assert.equal(booked.booking_id, 'bk_1');
  assert.equal(booked.booking.id, 'bk_1');
  assert.equal(booked.url, '/checkout/bk_1');

  await api.listInstalmentPlans({ status: 'past_due' });
  assert.equal(calls[3].path, '/api/pt/instalment-plans?status=past_due');

  await api.stopInstalmentPlan('bk_1', { request_token: 'r1' });
  assert.deepEqual(calls[4], { path: '/api/pt/instalment-plans/bk_1/stop', method: 'POST', body: { request_token: 'r1' } });
});

test('live save omits price_pence when upfront is not enabled', async () => {
  const calls = [];
  const api = createInstalmentsApi({
    mode: 'live',
    request: async (path, opts = {}) => { calls.push(opts.body); return { block: { id: 'blk_1' } }; }
  });
  await api.saveBlockPaymentOptions('blk_1', {
    upfront: { enabled: false, price_pence: 0 },
    weekly: { enabled: true, amount_pence: 1250, count: 8 },
    monthly: { enabled: false, amount_pence: 0, count: 2 }
  }, { lastSessionAt: '2027-01-12T19:00:00Z', body: { title: '8-week strength block' } });
  assert.equal('price_pence' in calls[0], false);
  assert.equal(calls[0].payment_options.weekly.enabled, true);
});

test('booking an upfront plan that is not enabled is PLAN_NOT_OFFERED', async () => {
  const api = createInstalmentsApi({ mode: 'mock', now: () => new Date('2026-11-23T22:00:00Z') });
  await api.saveBlockPaymentOptions('blk_example', {
    upfront: { enabled: false, price_pence: 0 },
    weekly: { enabled: true, amount_pence: 1250, count: 8 },
    monthly: { enabled: false, amount_pence: 0, count: 2 }
  }, { lastSessionAt: '2027-01-12T19:00:00Z' });
  await assert.rejects(
    () => api.createBooking({ block_id: 'blk_example', checkout_token: 'tok-up', plan: 'upfront' }),
    err => err.code === 'PLAN_NOT_OFFERED' && err.status === 409 && friendlyError(err) === ERROR_COPY.PLAN_NOT_OFFERED
  );
});

test('live createBooking also reads the current { booking, url } reserve shape', async () => {
  const api = createInstalmentsApi({
    mode: 'live',
    request: async () => ({ booking: { id: 'bk_old' }, url: '/checkout/bk_old' })
  });
  const result = await api.createBooking({ block_id: 'blk', checkout_token: 't', plan: 'upfront' });
  assert.equal(result.booking_id, 'bk_old');
  assert.equal(result.url, '/checkout/bk_old');
});

test('instalments_mock=1 selects the mock harness', () => {
  assert.equal(instalmentsModeFromLocation({ search: '?instalments_mock=1' }, null), 'mock');
  assert.equal(instalmentsModeFromLocation({ search: '' }, { getItem: () => '1' }), 'mock');
  assert.equal(instalmentsModeFromLocation({ search: '' }, { getItem: () => null }), 'live');
});

test('legacy blocks without payment_options stay upfront-only', () => {
  const options = optionsFromBlock({ price_pence: 9000, sessions: [] });
  assert.equal(options.upfront.enabled, true);
  assert.equal(options.upfront.price_pence, 9000);
  assert.equal(options.weekly.enabled, false);
  const quotes = enabledQuotesFromBlock({ price_pence: 9000, sessions: [] }, '2026-11-23T22:00:00Z');
  assert.deepEqual(quotes.map(q => q.plan), ['upfront']);
  assert.equal(quotes[0].total_pence, 9000);
});

test('app.js checkout total is labelled total after discount and hooks go through the adapter', () => {
  const appJs = readFileSync(join(root, 'app/public/app.js'), 'utf8');
  assert.ok(appJs.includes('Total after discount'));
  assert.ok(appJs.includes('getInstalmentsApi()'));
  assert.ok(appJs.includes('createBooking(body)'));
  assert.ok(appJs.includes('saveBlockPaymentOptions('));
  assert.ok(appJs.includes('listInstalmentPlans('));
  assert.ok(appJs.includes('stopInstalmentPlan('));
  assert.ok(appJs.includes('Past-due behaviour is configured in your own Stripe account.'));
  assert.ok(appJs.includes("plan.can_stop&&me.role==='pt'"));
  assert.ok(appJs.includes('resume-open-checkout'));
  assert.ok(appJs.includes('refreshReserveQuote('));
  assert.ok(appJs.includes('if(result.url)error.url=result.url'));
  assert.ok(appJs.includes('if(result.booking_id)error.booking_id=result.booking_id'));
  assert.ok(appJs.includes('<dt>Total after discount</dt><dd>${money(b.total_pence)}</dd>'));
  const html = readFileSync(join(root, 'app/public/index.html'), 'utf8');
  assert.ok(html.includes('type="module" src="/instalments-api.js"'));
});
