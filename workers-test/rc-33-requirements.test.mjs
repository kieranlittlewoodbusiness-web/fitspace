// RC-33: POST /api/pt/stripe/status must not wipe stored requirements when the v2 response carries none,
// and maps v2 `requirements.entries` (include[1]=requirements) into the card's v1 shape. fetch is mocked.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../worker/index.mjs';
import { accountRequirements, accountSnapshot } from '../src/connect-status.mjs';
import { db, seedBlock, seedUser, jsonRequest } from './helpers.mjs';
import nodeCrypto from 'node:crypto';

const live = () => Object.assign(Object.create(null), env, { PAYMENT_MODE: 'stripe_test', STRIPE_INTEGRATION: 'connect', MULTI_PT_ENABLED: 'false' });
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const status = async user => { const r = await worker.fetch(jsonRequest(user, 'POST', '/api/pt/stripe/status', {}), live()); return { status: r.status, body: await r.json() }; };
const STORED = { currently_due: ['business_profile.url', 'external_account'], past_due: ['business_profile.url', 'external_account'], disabled_reason: 'requirements.past_due' };
const restrictedCard = { status: 'restricted', status_details: [{ code: 'requirements_past_due', resolution: 'provide_info' }] };
const entry = (description, s, from = 'user') => ({ description, awaiting_action_from: from, minimum_deadline: { status: s }, errors: [], requested_reasons: [{ code: 'routine_onboarding' }] });

function mockAccount(account) {
  const paths = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin !== 'https://api.stripe.com') throw new Error('unexpected host in test: ' + url.origin);
    paths.push((init.method || 'GET') + ' ' + url.pathname + url.search);
    if (/^\/v2\/core\/accounts\//.test(url.pathname)) return typeof account === 'function' ? account(url) : json(200, account);
    return json(404, { error: { message: 'no mock' } });
  });
  return paths;
}

async function seeded() {
  const s = await seedBlock({ customers: 0 });
  const pt = await seedUser({ role: 'pt', ptId: s.ptId });
  const acct = 'acct_test_' + nodeCrypto.randomBytes(6).toString('hex');
  await db().run("INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready,charges_enabled,payouts_enabled,details_submitted,requirements) VALUES(?,'stripe_test',?,'connected',0,0,0,1,?)", s.ptId, acct, JSON.stringify(STORED));
  return { ptId: s.ptId, pt, acct };
}
const stored = async ptId => JSON.parse((await db().get('SELECT requirements FROM stripe_connections WHERE pt_id=?', ptId)).requirements);

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await db().batch([db().stmt('DELETE FROM stripe_connections'), db().stmt('UPDATE pts SET stripe_account=NULL, stripe_ready=0')]);
});

describe('RC-33 accountRequirements', () => {
  it('returns null when the response carries no requirements (absent, null, or an unrecognised object)', () => {
    expect(accountRequirements({ id: 'acct_1', configuration: { merchant: { capabilities: { card_payments: restrictedCard } } } })).toBeNull();
    expect(accountRequirements({ id: 'acct_1', requirements: null })).toBeNull();
    expect(accountRequirements({ id: 'acct_1', requirements: {} })).toBeNull();
    expect(accountRequirements({ id: 'acct_1', requirements: { entries: 'nope' } })).toBeNull();
    expect(accountSnapshot({ id: 'acct_1', configuration: { merchant: { capabilities: { card_payments: restrictedCard } } } }).requirements).toBeNull();
  });

  it('keeps v1 requirements as-is', () => {
    expect(accountRequirements({ requirements: { currently_due: ['tax_id'], past_due: [], disabled_reason: null } }))
      .toEqual({ currently_due: ['tax_id'], past_due: [], disabled_reason: null });
  });

  it('maps v2 entries: user-owned past_due/currently_due only; past_due also counts as currently_due; disabled reason from the capability', () => {
    const account = {
      configuration: { merchant: { capabilities: { card_payments: restrictedCard } } },
      requirements: {
        entries: [
          entry('business_profile.url', 'past_due'), entry('external_account', 'past_due'),
          entry('identity.individual.dob', 'currently_due'), entry('identity.business_details.tax_id', 'eventually_due'),
          entry('identity.individual.verification.document', 'past_due', 'stripe')
        ],
        summary: { minimum_deadline: { status: 'past_due', time: null } }
      }
    };
    expect(accountRequirements(account)).toEqual({
      currently_due: ['business_profile.url', 'external_account', 'identity.individual.dob'],
      past_due: ['business_profile.url', 'external_account'],
      disabled_reason: 'requirements.past_due'
    });
    expect(accountRequirements({ requirements: { entries: [], summary: null } })).toEqual({ currently_due: [], past_due: [], disabled_reason: null });
    expect(accountRequirements({ requirements: { entries: null, summary: null } })).toEqual({ currently_due: [], past_due: [], disabled_reason: null });
  });
});

describe('RC-33 POST /api/pt/stripe/status', () => {
  it('requests include[1]=requirements and keeps the stored list when the v2 response has no requirements; card stays restricted', async () => {
    const { ptId, pt, acct } = await seeded();
    const paths = mockAccount({ id: acct, livemode: false, configuration: { merchant: { capabilities: { card_payments: restrictedCard } } } });
    const r = await status(pt);
    expect(r.status).toBe(200);
    expect(paths).toEqual([`GET /v2/core/accounts/${acct}?include[0]=configuration.merchant&include[1]=requirements`]);
    expect(r.body).toMatchObject({ state: 'restricted', charges_enabled: false, payouts_enabled: false, details_submitted: true, requirements: STORED });
    expect(await stored(ptId)).toEqual(STORED);
    // Repeated taps do not erode it either.
    expect((await status(pt)).body).toMatchObject({ state: 'restricted', requirements: STORED });
    expect(await stored(ptId)).toEqual(STORED);
  });

  it('replaces the stored list with mapped v2 requirements when the response carries them', async () => {
    const { ptId, pt, acct } = await seeded();
    mockAccount({
      id: acct, livemode: false,
      configuration: { merchant: { capabilities: { card_payments: restrictedCard, transfers: { status: 'inactive' } } } },
      requirements: { entries: [entry('external_account', 'past_due'), entry('identity.individual.dob', 'currently_due')], summary: { minimum_deadline: { status: 'past_due' } } }
    });
    const want = { currently_due: ['external_account', 'identity.individual.dob'], past_due: ['external_account'], disabled_reason: 'requirements.past_due' };
    const r = await status(pt);
    expect(r.body).toMatchObject({ state: 'restricted', requirements: want });
    expect(await stored(ptId)).toEqual(want);
  });

  it('clears the list and goes active when v2 says nothing is due and card_payments is active', async () => {
    const { ptId, pt, acct } = await seeded();
    mockAccount({
      id: acct, livemode: false,
      configuration: { merchant: { capabilities: { card_payments: { status: 'active', status_details: [] }, transfers: { status: 'active' } } } },
      requirements: { entries: [], summary: null }
    });
    const r = await status(pt);
    expect(r.body).toMatchObject({ state: 'active', ready: true, charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [], past_due: [], disabled_reason: null } });
    expect(await stored(ptId)).toEqual({ currently_due: [], past_due: [], disabled_reason: null });
    expect(await db().get('SELECT ready,charges_enabled,payouts_enabled,details_submitted FROM stripe_connections WHERE pt_id=?', ptId)).toEqual({ ready: 1, charges_enabled: 1, payouts_enabled: 1, details_submitted: 1 });
  });

  it('CR m1: ready + no requirements in the response clears a stale past_due list (card goes active)', async () => {
    const { ptId, pt, acct } = await seeded();
    mockAccount({ id: acct, livemode: false, configuration: { merchant: { capabilities: { card_payments: { status: 'active' }, transfers: { status: 'active' } } } } });
    const r = await status(pt);
    expect(r.body).toMatchObject({ state: 'active', ready: true, requirements: { currently_due: [], past_due: [], disabled_reason: null } });
    expect(await stored(ptId)).toEqual({ currently_due: [], past_due: [], disabled_reason: null });
  });

  it('CR m1: not ready + no requirements in the response keeps the stored list', async () => {
    const { ptId, pt, acct } = await seeded();
    mockAccount({ id: acct, livemode: false, configuration: { merchant: { capabilities: { card_payments: { status: 'pending' }, transfers: { status: 'pending' } } } } });
    const r = await status(pt);
    expect(r.body).toMatchObject({ state: 'restricted', ready: false, requirements: STORED });
    expect(await stored(ptId)).toEqual(STORED);
  });

  it('a 400 on include[1]=requirements retries once without it and keeps the stored list', async () => {
    const { ptId, pt, acct } = await seeded();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const paths = mockAccount(url => url.search.includes('include[1]=requirements')
      ? json(400, { error: { type: 'invalid_request_error', code: 'invalid_value', message: 'bad include' } })
      : json(200, { id: acct, livemode: false, configuration: { merchant: { capabilities: { card_payments: restrictedCard } } } }));
    const r = await status(pt);
    expect(r.status).toBe(200);
    expect(paths).toEqual([
      `GET /v2/core/accounts/${acct}?include[0]=configuration.merchant&include[1]=requirements`,
      `GET /v2/core/accounts/${acct}?include[0]=configuration.merchant`
    ]);
    expect(r.body).toMatchObject({ state: 'restricted', requirements: STORED });
    expect(await stored(ptId)).toEqual(STORED);
  });

  it('a non-400 Stripe error (404) is not retried and leaves the row untouched', async () => {
    const { ptId, pt, acct } = await seeded();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const paths = mockAccount(() => json(404, { error: { type: 'invalid_request_error', code: 'not_found', message: 'nope' } }));
    const r = await status(pt);
    expect(r.status).toBe(409);
    expect(r.body).not.toHaveProperty('stripeStatus');
    expect(paths).toHaveLength(1);
    expect(await stored(ptId)).toEqual(STORED);
  });
});
