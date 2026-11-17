// Scope lint, per query (CR 5940418854 condition 1). Every SQL literal touching a
// PT-owned table, in src/, worker/ and scripts/ (worker/index.mjs included: it must have
// none), is listed below by file::function with its query fingerprint and a reason. An
// unlisted query anywhere (new, moved to another function, or edited) fails; so does a
// stale entry. Everything else must go through scopeFor(). Regenerate fingerprints with:
//   node workers-test/scope-lint-core.mjs   (prints the current keys)
import { describe, it, expect } from 'vitest';
import { ptOwnedQueries } from './scope-lint-core.mjs';

const sources = {
  ...import.meta.glob('../src/**/*.mjs', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('../worker/**/*.mjs', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('../scripts/**/*.mjs', { query: '?raw', import: 'default', eager: true })
};

export const ALLOWED = {
  '../src/cutover.mjs::DUPLICATE_REPORT_SQL': {
    why: "cutover tool (scratch DB, CLI only): global duplicate report, PM ruling",
    queries: [
      '6fbfbe26', // SELECT b.id AS booking_id, b.customer_id, b.block_id, b.status AS paym
    ]
  },
  '../src/cutover.mjs::MARK_SQL': {
    why: "cutover tool opt-in (explicit confirm phrase), CLI only",
    queries: [
      'f69b9e13', // UPDATE bookings SET status='review' WHERE id IN (SELECT id FROM (${}) 
    ]
  },
  '../src/cutover.mjs::RANKED': {
    why: "cutover tool ranking subquery, CLI only",
    queries: [
      '5e66c3fc', // SELECT id, ROW_NUMBER() OVER (PARTITION BY block_id, customer_id ORDER
    ]
  },
  '../src/emails.mjs::confirmationInsert': {
    why: "system: outbox insert for a booking id the caller already authorised (webhook/payment op)",
    queries: [
      '4479630c', // SELECT starts_at FROM class_sessions WHERE block_id=? ORDER BY starts_
      '89ee9507', // SELECT * FROM blocks WHERE id=?
      '91231c6d', // SELECT * FROM bookings WHERE id=?
      '9b4cb986', // INSERT OR IGNORE INTO email_outbox(id,pt_id,customer_id,dedupe_key,rec
    ]
  },
  '../src/emails.mjs::noShowInsert': {
    why: "system: outbox insert inside markAttendance after scopeFor().booking()",
    queries: [
      '2e285986', // INSERT OR IGNORE INTO email_outbox(id,pt_id,customer_id,dedupe_key,rec
    ]
  },
  '../src/mail.mjs::deliverOutbox': {
    why: "system (Cron Trigger): delivery of queued rows by id; nothing returned to a caller",
    queries: [
      '069786df', // UPDATE email_outbox SET status='failed',attempts=attempts+1,last_error
      'cf28ec74', // UPDATE email_outbox SET status='preview',last_error='Demo example.com 
      'de588a69', // UPDATE email_outbox SET status='sending',next_attempt_at=? WHERE id=? 
      'e17b2f90', // UPDATE email_outbox SET status='sent',provider_id=?,sent_at=?,last_err
      'e77454e4', // SELECT id FROM email_outbox WHERE status IN ('queued','failed','sendin
    ]
  },
  '../src/mail.mjs::runScheduled': {
    why: "system (Cron Trigger): global hold expiry, no reads returned",
    queries: [
      '5bec359e', // UPDATE bookings SET status='expired' WHERE status='pending' AND expire
    ]
  },
  '../src/ops/accounts.mjs::cancelDemoBooking': {
    why: "keyed by a booking id first returned by scopeFor().booking()",
    queries: [
      '62e5858a', // UPDATE bookings SET status='cancelled' WHERE id=? AND status IN ('paid
    ]
  },
  '../src/ops/bookings.mjs::available': {
    why: "public capacity count for a published block (no row data returned)",
    queries: [
      '02e461ae', // SELECT count(*) n FROM bookings WHERE block_id=? AND (status='paid' OR
    ]
  },
  '../src/ops/bookings.mjs::completeDemo': {
    why: "customer-own rows: WHERE customer_id=? (+ global expiry sweep)",
    queries: [
      '39e061e4', // UPDATE bookings SET status='expired' WHERE id=? AND status='pending' A
      '4782f97b', // UPDATE bookings SET status=?,paid_at=CASE WHEN ?='paid' THEN ? ELSE pa
      '5bec359e', // UPDATE bookings SET status='expired' WHERE status='pending' AND expire
    ]
  },
  '../src/ops/bookings.mjs::completeDemo>load': {
    why: "customer-own row: WHERE customer_id=?",
    queries: [
      '8e6b0c48', // SELECT * FROM bookings WHERE id=? AND customer_id=?
    ]
  },
  '../src/ops/bookings.mjs::reserve': {
    why: "public published-block lookup; customer-own bookings by customer_id; insert for the caller",
    queries: [
      '24050166', // SELECT min(starts_epoch) starts FROM class_sessions WHERE block_id=?
      '54748dd4', // SELECT b.*,p.published pt_published FROM blocks b JOIN pts p ON p.id=b
      '5bec359e', // UPDATE bookings SET status='expired' WHERE status='pending' AND expire
      '5dc7a5b6', // SELECT id FROM bookings WHERE block_id=? AND customer_id=? AND (status
      'a5475576', // INSERT INTO bookings(id,block_id,customer_id,reference,status,amount_p
    ]
  },
  '../src/ops/bookings.mjs::reserve>replay': {
    why: "checkout_token replay, then checked customer_id === caller before returning",
    queries: [
      '1889e1e2', // SELECT * FROM bookings WHERE checkout_token=?
    ]
  },
  '../src/ops/codes.mjs::claimCode': {
    why: "RC-8 claim keyed by code + a booking id owned by the caller",
    queries: [
      '31a20a19', // EXISTS(SELECT 1 FROM discount_codes WHERE id=? AND active=1 AND (max_u
      '428956ca', // UPDATE discount_codes SET uses=uses+1 WHERE id=? RETURNING uses,max_us
      '60b9baab', // INSERT INTO discount_redemptions(id,code_id,booking_id,customer_id,sta
    ]
  },
  '../src/ops/codes.mjs::claimCode>replay': {
    why: "RC-8 idempotent replay keyed by code + booking",
    queries: [
      'de537188', // SELECT r.id redemption_id,c.uses,c.max_uses FROM discount_redemptions 
    ]
  },
  '../src/ops/manage.mjs::createBlock': {
    why: "insert with pt_id = caller PT (admin: named PT); replay goes through scopeFor().blockByCreateKey",
    queries: [
      '2f711107', // INSERT INTO blocks(id,pt_id,title,description,venue,price_pence,capaci
    ]
  },
  '../src/ops/manage.mjs::markAttendance': {
    why: "keyed by booking/session ids first returned by scopeFor()",
    queries: [
      '4bb67f23', // EXISTS(SELECT 1 FROM bookings WHERE id=? AND status='paid')
      '4ccb536b', // SELECT * FROM class_sessions WHERE id=? AND block_id=?
      '594f42e1', // INSERT INTO attendance VALUES(?,?,?,?,?) ON CONFLICT(booking_id,sessio
      'c968da9a', // SELECT id,status,subject,body FROM email_outbox WHERE dedupe_key=?
    ]
  },
  '../src/ops/manage.mjs::sessionRows': {
    why: "session rows for a block id created or scoped by the caller",
    queries: [
      '4d3b6940', // INSERT INTO class_sessions VALUES(?,?,?,?,?)
    ]
  },
  '../src/ops/manage.mjs::updateBlock': {
    why: "counts/sessions/guards keyed by a block id first returned by scopeFor().block()",
    queries: [
      '15da34ef', // SELECT sum(status='paid') paid, sum(status='pending' AND expires_at>?)
      '1c6b9bf0', // DELETE FROM class_sessions WHERE block_id=?
      '599af982', // SELECT starts_at,duration_minutes FROM class_sessions WHERE block_id=?
      '5bec359e', // UPDATE bookings SET status='expired' WHERE status='pending' AND expire
      '9d1bda76', // (SELECT count(*) FROM bookings WHERE block_id=? AND status IN ('paid',
      'fa3ac64d', // SELECT count(*) n FROM bookings WHERE block_id=?
      'fc0ed12c', // NOT EXISTS(SELECT 1 FROM bookings WHERE block_id=?)
    ]
  },
  '../src/ops/stripe-jobs.mjs::completeJob': {
    why: "system: job commit keyed by a job id the Worker created after scopeFor()",
    queries: [
      '4a00bdd9', // SELECT * FROM stripe_jobs WHERE id=?
      '538c06c6', // EXISTS(SELECT 1 FROM stripe_jobs WHERE id=? AND status<>'done')
      '817ee51d', // EXISTS(SELECT 1 FROM bookings WHERE id=? AND (checkout_session IS NULL
      '91231c6d', // SELECT * FROM bookings WHERE id=?
      'a12e4b5d', // UPDATE bookings SET checkout_session=?,checkout_url=? WHERE id=?
      'cd72c8af', // UPDATE bookings SET status='cancelled' WHERE id=? AND status='pending'
      'd5168560', // SELECT status,result FROM stripe_jobs WHERE id=?
      'dfd197e6', // UPDATE stripe_jobs SET status='done',result=?,last_error=NULL WHERE id
    ]
  },
  '../src/ops/stripe-jobs.mjs::expireStmt': {
    why: "system: global hold expiry, no reads returned",
    queries: [
      '5bec359e', // UPDATE bookings SET status='expired' WHERE status='pending' AND expire
    ]
  },
  '../src/ops/stripe-jobs.mjs::failJob': {
    why: "system: job failure keyed by job id",
    queries: [
      '2051fbe0', // UPDATE stripe_jobs SET status=?,last_error=? WHERE id=? AND status<>'d
      '4a00bdd9', // SELECT * FROM stripe_jobs WHERE id=?
      '58fad074', // UPDATE bookings SET refund_status='failed',refund_error=? WHERE id=? A
      'aa1ec2c6', // UPDATE bookings SET status='failed',payment_error=? WHERE id=? AND sta
    ]
  },
  '../src/ops/stripe-jobs.mjs::jobStmt': {
    why: "system: deterministic job insert",
    queries: [
      '50dae9ec', // INSERT OR IGNORE INTO stripe_jobs(id,kind,target_id,actor_id,payload,c
    ]
  },
  '../src/ops/stripe-jobs.mjs::prepareCheckout': {
    why: "job lookup by deterministic id after scopeFor().booking()",
    queries: [
      'c782b604', // SELECT id FROM stripe_jobs WHERE id=?
    ]
  },
  '../src/ops/stripe-jobs.mjs::prepareRefund': {
    why: "keyed by a booking id first returned by scopeFor().booking() (PT/admin)",
    queries: [
      '24a0f45e', // NOT EXISTS(SELECT 1 FROM stripe_jobs WHERE target_id=? AND kind='refun
      '50851eae', // SELECT id FROM stripe_jobs WHERE target_id=? AND kind='refund' AND sta
      'aabc8d1d', // UPDATE bookings SET refund_status='requested',refund_error=NULL WHERE 
      'c782b604', // SELECT id FROM stripe_jobs WHERE id=?
    ]
  },
  '../src/ops/webhooks.mjs::handleWebhook': {
    why: "system: Stripe-signed events, matched by session/payment/account ids",
    queries: [
      '1e80b702', // UPDATE bookings SET status=CASE WHEN status='pending' AND expires_at>?
      '28667957', // UPDATE bookings SET payment_error=? WHERE id=? AND paid_at IS NULL
      '7c940452', // UPDATE bookings SET charge_refunded_pence=max(charge_refunded_pence,?)
      '90866b2e', // UPDATE bookings SET payment_intent=?,paid_at=coalesce(paid_at,?),payme
      'a250b4c5', // SELECT id,payment_intent,paid_at FROM bookings WHERE id=? AND mode=?
      'c782b604', // SELECT id FROM stripe_jobs WHERE id=?
      'c9b55156', // SELECT b.*,c.pt_id FROM bookings b JOIN blocks c ON c.id=b.block_id WH
      'd00ff2da', // UPDATE bookings SET checkout_session=coalesce(checkout_session,?),stri
      'f375f377', // SELECT b.* FROM bookings b WHERE b.id=?
      'f987b4b2', // UPDATE bookings SET status=?,payment_error=? WHERE id=? AND paid_at IS
      'fe09232b', // SELECT * FROM bookings WHERE payment_intent=? AND mode=?
    ]
  },
  '../src/ops/webhooks.mjs::refundWrites': {
    why: "system: refund rows keyed by a booking matched by handleWebhook/completeJob",
    queries: [
      '1d7c52db', // max((SELECT coalesce(sum(amount_pence),0) FROM stripe_refunds WHERE bo
      '75b0d86d', // UPDATE bookings SET refunded_pence=${}, refund_status=CASE WHEN ${}>=a
      'd9d7614c', // (SELECT count(*) FROM stripe_refunds WHERE booking_id=bookings.id AND 
      'da33ebfa', // INSERT INTO stripe_refunds VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE
      'e4a275be', // (SELECT coalesce(sum(amount_pence),0) FROM stripe_refunds WHERE bookin
      'fbfadd42', // SELECT * FROM stripe_refunds WHERE id=?
    ]
  },
  '../src/pt-credentials.mjs::credentialStatus': {
    why: "scoped by c.pt_id = the caller PT id (route passes user.pt_id)",
    queries: [
      '5ebbfa29', // SELECT b.id FROM bookings b JOIN blocks c ON c.id=b.block_id WHERE c.p
    ]
  },
  '../src/public.mjs::expireHolds': {
    why: "system: global hold expiry, no reads returned",
    queries: [
      '5bec359e', // UPDATE bookings SET status='expired' WHERE status='pending' AND expire
    ]
  },
  '../src/public.mjs::publishedPtPage': {
    why: "public: published, open blocks of a published PT only",
    queries: [
      '065588a7', // SELECT * FROM blocks WHERE pt_id=? AND published=1 AND closed=0
    ]
  },
  '../src/scope.mjs::BOOKING_VIEW': {
    why: "the scoping layer: view used only with scopeFor predicates",
    queries: [
      'bd25dbfa', // SELECT b.*,c.title,c.venue,c.description,c.pt_id,p.slug,p.brand_name,u
    ]
  },
  '../src/scope.mjs::scopeFor>block': {
    why: "the scoping layer",
    queries: [
      'bc8ac335', // SELECT c.* FROM blocks c WHERE c.id=? AND ${}
    ]
  },
  '../src/scope.mjs::scopeFor>blockByCreateKey': {
    why: "the scoping layer (other PT -> undefined)",
    queries: [
      '055cecdd', // SELECT c.* FROM blocks c WHERE c.create_key=?
    ]
  },
  '../src/scope.mjs::scopeFor>blocks': {
    why: "the scoping layer (admin all / PT own)",
    queries: [
      '18a4e4c7', // SELECT * FROM blocks ORDER BY created_at DESC
      '4c5cc54e', // SELECT * FROM blocks WHERE pt_id=? ORDER BY created_at DESC
      '4c5cc54e', // SELECT * FROM blocks WHERE pt_id=? ORDER BY created_at DESC
    ]
  },
  '../src/scope.mjs::scopeFor>outbox': {
    why: "the scoping layer",
    queries: [
      'f2773b8b', // SELECT o.* FROM email_outbox o WHERE ${} ORDER BY o.created_at DESC LI
    ]
  },
  '../src/scope.mjs::scopeFor>updateBlockStmt': {
    why: "the scoping layer (admin by id / PT AND pt_id=?)",
    queries: [
      '46ab8046', // UPDATE blocks SET ${} WHERE id=?
      'a709c197', // UPDATE blocks SET ${} WHERE id=? AND pt_id=?
    ]
  },
  '../src/scope.mjs::viewBooking': {
    why: "the scoping layer: sessions of a booking already scoped",
    queries: [
      'd90f8090', // SELECT s.*,coalesce(a.status,'unmarked') attendance_status FROM class_
    ]
  },
  '../src/stripe-jobs.mjs::runJob': {
    why: "system: job runner, rows keyed by a job id; ownership re-checked for pt_direct",
    queries: [
      '4a00bdd9', // SELECT * FROM stripe_jobs WHERE id=?
      '53faff38', // SELECT b.stripe_credential_id,b.stripe_account_id,c.pt_id FROM booking
      '91231c6d', // SELECT * FROM bookings WHERE id=?
      '91231c6d', // SELECT * FROM bookings WHERE id=?
      'c782b604', // SELECT id FROM stripe_jobs WHERE id=?
    ]
  },
  '../src/views.mjs::dashboard': {
    why: "PT dashboard count scoped by c.pt_id = user.pt_id",
    queries: [
      '0e3720a6', // SELECT count(*) n FROM attendance a JOIN bookings b ON b.id=a.booking_
    ]
  },
  '../src/views.mjs::viewBlocks': {
    why: "child rows for block ids first returned by scopeFor().blocks()",
    queries: [
      '8fc10288', // SELECT id,block_id,starts_at,starts_epoch,duration_minutes FROM class_
      '9cfde015', // SELECT block_id, sum(status='paid') paid, sum(status='paid' OR (status
    ]
  },
  '../src/views.mjs::withSessions': {
    why: "child rows for booking/block ids first returned by scopeFor().bookings()",
    queries: [
      '709e41c6', // SELECT * FROM class_sessions WHERE block_id IN (?*)
      '87b914fc', // SELECT booking_id,session_id,status FROM attendance WHERE booking_id I
    ]
  }
};

const allowedKeys = () => Object.entries(ALLOWED).flatMap(([fn, v]) => v.queries.map(h => `${fn}::${h}`)).sort();

describe('scope lint (per query)', () => {
  it('every PT-owned query is individually allowlisted, and no allowlist entry is stale', () => {
    const found = ptOwnedQueries(sources);
    const keys = found.map(q => q.key).sort();
    const unlisted = found.filter(q => !allowedKeys().includes(q.key));
    const stale = allowedKeys().filter(k => !keys.includes(k));
    console.log('scope lint:', found.length, 'PT-owned queries in', new Set(found.map(q => q.key.split('::').slice(0, 2).join('::'))).size, 'functions;', Object.keys(sources).length, 'files scanned; unlisted', unlisted.length, 'stale', stale.length);
    for (const q of unlisted) console.log('UNLISTED', q.key, q.sql);
    expect(keys).toEqual(allowedKeys());
  });

  it('worker/index.mjs is scanned and has no PT-owned SQL', () => {
    expect(Object.keys(sources)).toContain('../worker/index.mjs');
    expect(ptOwnedQueries({ '../worker/index.mjs': sources['../worker/index.mjs'] })).toEqual([]);
  });

  it('catches a synthetic unscoped query, including inside an allowlisted function', () => {
    const fake = { ...sources, '../worker/index.mjs': sources['../worker/index.mjs'] + "\nexport async function leak(db) {\n  return db.all('SELECT * FROM bookings');\n}\n" };
    const leaked = ptOwnedQueries(fake).filter(q => !allowedKeys().includes(q.key));
    expect(leaked.map(q => q.key)).toEqual([expect.stringMatching(/^\.\.\/worker\/index\.mjs::leak::[0-9a-f]{8}$/)]);
    // Same function, extra query: an allowlisted function does not whitelist new SQL.
    const scope = sources['../src/views.mjs'].replace('export async function dashboard(', "export async function dashboard(...a) { await a[0].all(`SELECT * FROM bookings`); }\nasync function dashboardOld(");
    const extra = ptOwnedQueries({ ...sources, '../src/views.mjs': scope }).filter(q => !allowedKeys().includes(q.key));
    expect(extra.length).toBeGreaterThan(0);
    expect(extra.some(q => q.key.startsWith('../src/views.mjs::dashboard::') && q.sql === 'SELECT * FROM bookings')).toBe(true);
  });
});
