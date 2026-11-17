// Scoping is enforced by convention in code review PLUS this check (CR 5940135102 minor 6):
// only the modules below may query PT-owned tables directly; everything else must go
// through scopeFor(). Adding a module that touches these tables fails until it is reviewed
// and listed here with a reason.
import { describe, it, expect } from 'vitest';

const sources = {
  ...import.meta.glob('../src/**/*.mjs', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('../worker/**/*.mjs', { query: '?raw', import: 'default', eager: true })
};
const PT_OWNED = /\b(FROM|JOIN|UPDATE|INTO)\s+(blocks|bookings|class_sessions|attendance|email_outbox|discount_codes|discount_redemptions|waitlist_entries|stripe_refunds)\b/i;

export const ALLOWED_DIRECT_ACCESS = {
  '../src/scope.mjs': 'the scoping layer itself',
  '../src/emails.mjs': 'system: outbox inserts keyed by a booking already authorised by the caller',
  '../src/ops/bookings.mjs': 'public block lookup for reserve; customer-own rows by user id; demo pay keyed by booking + customer',
  '../src/ops/webhooks.mjs': 'system: Stripe-signed events, matched by payment/account ids',
  '../src/ops/manage.mjs': 'counts/sessions keyed by a block or booking id first returned by scopeFor()',
  '../src/ops/codes.mjs': 'RC-8 claim keyed by code + booking id; route-level scoping arrives with RC-8 routes',
  '../worker/index.mjs': 'system: the global expiry sweep (no reads returned to callers)'
};

describe('scope lint', () => {
  it('only allowlisted modules query PT-owned tables directly', () => {
    const touching = Object.entries(sources).filter(([, code]) => PT_OWNED.test(code)).map(([file]) => file).sort();
    console.log('modules with direct PT-owned SQL:', touching.join(', '));
    expect(touching).toEqual(Object.keys(ALLOWED_DIRECT_ACCESS).sort());
  });
});
