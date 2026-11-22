import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(join(root, 'app/public/app.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unterminated ' + name);
}

test('customer Cancel is hidden on paid bookings in every mode, including demo, and kept for pending checkouts', () => {
  const src = extractFunction(appJs, 'bookingTable');
  assert.equal(src.includes("['paid','pending'].includes(b.status)&&b.mode==='demo'"), false, 'paid demo bookings must not get Cancel');
  assert.ok(src.includes("b.status==='pending'&&(b.mode==='demo'||(stripeMode(b.mode)&&b.mode===config.payment_mode))"));
  assert.ok(src.includes('data-action="cancel-booking"'));

  const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const emptyState = () => '';
  const money = (pence) => `£${(pence / 100).toFixed(2)}`;
  const modeName = (mode) => mode;
  const statusPill = (status) => status;
  const stripeMode = (mode) => mode === 'stripe_test' || mode === 'stripe_live';
  const dateText = () => '1 Dec';
  const timeText = () => '18:30';
  const bookingTable = new Function('esc', 'emptyState', 'money', 'modeName', 'statusPill', 'stripeMode', 'dateText', 'timeText', 'config',
    extractFunction(appJs, 'bookingTable') + ';return bookingTable;')(esc, emptyState, money, modeName, statusPill, stripeMode, dateText, timeText, { payment_mode: 'demo' });

  const session = { starts_at: '2026-12-01T18:30', starts_epoch: Date.parse('2026-12-01T18:30:00Z') };
  const base = { id: 'b1', customer_name: 'Alex', customer_email: 'a@example.com', title: 'Class', reference: 'REF', sessions: [session], amount_pence: 1000, refunded_pence: 0, refund_status: null, payment_intent: null, slug: 'coach' };

  const paidDemo = bookingTable([{ ...base, status: 'paid', mode: 'demo' }], true);
  assert.equal(paidDemo.includes('cancel-booking'), false, 'paid demo must not show Cancel');
  const paidLive = bookingTable([{ ...base, status: 'paid', mode: 'stripe_live' }], true);
  assert.equal(paidLive.includes('cancel-booking'), false, 'paid live must not show Cancel');
  const paidTest = bookingTable([{ ...base, status: 'paid', mode: 'stripe_test' }], true);
  assert.equal(paidTest.includes('cancel-booking'), false, 'paid sandbox must not show Cancel');

  const pendingDemo = bookingTable([{ ...base, status: 'pending', mode: 'demo' }], true);
  assert.ok(pendingDemo.includes('cancel-booking'), 'pending demo checkout should still be cancellable');
  const pendingStripe = bookingTable([{ ...base, status: 'pending', mode: 'stripe_test' }], true);
  const stripeTable = new Function('esc', 'emptyState', 'money', 'modeName', 'statusPill', 'stripeMode', 'dateText', 'timeText', 'config',
    extractFunction(appJs, 'bookingTable') + ';return bookingTable;')(esc, emptyState, money, modeName, statusPill, stripeMode, dateText, timeText, { payment_mode: 'stripe_test' });
  const pendingInTest = stripeTable([{ ...base, status: 'pending', mode: 'stripe_test' }], true);
  assert.ok(pendingInTest.includes('cancel-booking'), 'pending stripe checkout should still be cancellable');
  void pendingStripe;
});

test('PT account tab has a profile form for the public and reply-to fields, with slug read-only', () => {
  assert.ok(appJs.includes('data-form="pt-profile"'));
  assert.ok(appJs.includes("method:'PATCH'"));
  assert.ok(appJs.includes("'/api/pt/profile'"));
  for (const name of ['display_name', 'business_name', 'contact_email', 'contact_phone', 'venue_name', 'venue_address', 'cancellation_window_hours', 'reply_to_name', 'reply_to_email']) {
    assert.ok(appJs.includes(`name="${name}"`) || appJs.includes(`name=${name}`) || appJs.includes(`'${name}'`), 'missing field ' + name);
  }
  assert.ok(appJs.includes('readonly') && appJs.includes('This cannot be changed here.'));
  assert.ok(appJs.includes('Replies to booking emails go here; never shown publicly.'));
  assert.equal(appJs.includes('name="bio"'), false, 'bio should be skipped; existing UI does not handle it on this tab');
  assert.equal(appJs.includes('name="photo_url"'), false, 'photo_url should be skipped; existing UI does not handle it');
  assert.ok(appJs.includes('error.fields=result.fields'));
  assert.ok(appJs.includes('aria-live="polite"'));
  assert.ok(appJs.includes('they appear on your terms, privacy and refund pages.'));
  assert.ok(appJs.includes('data-action="dismiss-profile-prompt"'));
  const start=appJs.indexOf('const PROFILE_MISSING_LABELS');
  const end=appJs.indexOf('function profilePromptDismissed');
  const profileMissingCopy=new Function(appJs.slice(start,end)+';return profileMissingCopy;')();
  assert.equal(
    profileMissingCopy(['business_name','contact_email']),
    'Add your business name and contact email; they appear on your terms, privacy and refund pages.'
  );
  assert.equal(
    profileMissingCopy(['contact_email']),
    'Add your contact email; it appears on your terms, privacy and refund pages.'
  );
});
