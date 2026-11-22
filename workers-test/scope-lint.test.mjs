// Scope lint, per query (CR 5940418854 condition 1). Every SQL literal touching a
// PT-owned table, in src/, worker/ and scripts/ (worker/index.mjs included: it must have
// none), is listed below by file::function with its query fingerprint and a reason. An
// unlisted query anywhere (new, moved to another function, or edited) fails; so does a
// stale entry. Everything else must go through scopeFor(). Regenerate fingerprints with:
//   node workers-test/scope-lint-core.mjs   (prints the current keys)
import { describe, it, expect } from 'vitest';
import { ptOwnedQueries, nonLiteralSqlCalls, rawAccess, sqlConstantUses, sqlCallCount, foreignReceiverCalls, lintSet } from './scope-lint-core.mjs';
import wranglerConfig from '../wrangler.jsonc?raw';

// QA D2 (f978692): every JS/TS file in the repo (not node_modules or dot folders) is loaded so
// the import graph can be resolved; the lint reads the graph from the Worker entries and the
// scripts plus the src/worker/scripts backstop (lintSet in scope-lint-core.mjs).
// Vite keys files next to this one as './x'; normalise every key to '../<repo path>'.
export const REPO = Object.fromEntries(Object.entries(import.meta.glob(['../**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}', './**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}', '!../node_modules/**', '!../.*/**', '!../**/.*/**'], { query: '?raw', import: 'default', eager: true }))
  .map(([k, v]) => [k.startsWith('./') ? '../workers-test/' + k.slice(2) : k, v]));
export const WORKER_MAIN = '../' + /"main"\s*:\s*"([^"]+)"/.exec(wranglerConfig)[1];
export const GRAPH = {
  // The Worker as wrangler deploys it, and the preview upload entry (docs §13), whose ./index.js
  // is the wrangler bundle of WORKER_MAIN.
  workerEntries: [WORKER_MAIN, '../docs/rc-4/preview/entry.mjs'],
  aliases: { '../docs/rc-4/preview/entry.mjs::./index.js': WORKER_MAIN },
  // Node CLI scripts that read the legacy Netlify app's SQLite/Postgres code (never D1). Each edge
  // into app/ or netlify/ is listed; a new one, or any from Worker code, fails.
  // CR 5943169048 C1: relative imports out of src/worker/scripts must be listed here.
  // Preview out-of-band reset and admin bootstrap reuse the shared production-id guard.
  outsideEdges: [
    '../src/ops/password-reset.mjs -> ../docs/rc-4/d1-rehearsal/guard.mjs',
    '../scripts/bootstrap-admin.mjs -> ../docs/rc-4/d1-rehearsal/guard.mjs'
  ],
  legacyEdges: [
    '../scripts/demo-snapshot.mjs -> ../app/db.cjs',
    '../scripts/dev.mjs -> ../netlify/functions/platform.mjs',
    '../scripts/dump-app-schema.cjs -> ../app/db.cjs',
    '../scripts/snapshot-import.mjs -> ../app/db.cjs'
  ]
};
export const lintFiles = (files = REPO) => lintSet(files, { ...GRAPH, entries: Object.keys(files).filter(f => f.startsWith('../scripts/')) });
const LINT = lintFiles();
const sources = LINT.sources;

export const ALLOWED = {
  '../src/sessions.mjs::signup': {
    why: 'public signup: role forced to customer',
    queries: [
      '4e0e7f76', // INSERT INTO users(id,name,email,password_hash,role,pt_id,must_change_p
    ]
  },
  '../src/sessions.mjs::login': {
    why: 'login by email; password verified before anything is returned',
    queries: [
      'e75aa28a', // SELECT * FROM users WHERE email=?
    ]
  },
  '../src/public.mjs::publishedPts': {
    why: 'public: published PTs only, public fields rendered by the view',
    queries: [
      '76b9bb78', // SELECT * FROM pts WHERE published=1 ORDER BY created_at
    ]
  },
  '../src/public.mjs::markWebhookSeen': {
    why: "PT webhook: after signature verification with this credential's secret",
    queries: [
      '652b1312', // UPDATE pt_stripe_credentials SET webhook_seen_at=? WHERE id=?
    ]
  },
  '../src/public.mjs::defaultSlug': {
    why: 'public: first published PT slug',
    queries: [
      '4b8c0975', // SELECT slug FROM pts WHERE published=1 ORDER BY created_at LIMIT 1
    ]
  },
  '../src/public.mjs::publishedCoach': {
    why: 'public: first published PT row for /api/public/site, slug routing and /trainers',
    queries: [
      'edb283f0', // SELECT * FROM pts WHERE published=1 ORDER BY created_at LIMIT 1
    ]
  },
  '../src/public.mjs::credentialById': {
    why: "PT webhook: credential by the id in the URL, verified by that credential's own signing secret",
    queries: [
      'e1aa6054', // SELECT * FROM pt_stripe_credentials WHERE id=?
    ]
  },
  '../src/public.mjs::adminSetupStatus': {
    why: 'admin-only route (requireUser admin in the Worker before the call); the credential query selects no cipher columns',
    queries: [
      'a5c09f8a', // SELECT id,pt_id,mode,account_id,enabled,charges_ready,webhook_seen_at 
      'b5a5e138', // SELECT c.*,p.brand_name FROM stripe_connections c JOIN pts p ON p.id=c
    ]
  },
  '../src/pt-credentials.mjs::loadCredential': {
    why: "credential by id; callers re-check ownership (runJob: booking/block pt_id binding; PT webhook: the URL's own credential)",
    queries: [
      'e1aa6054', // SELECT * FROM pt_stripe_credentials WHERE id=?
    ]
  },
  '../src/ops/stripe-jobs.mjs::prepareLink': {
    why: 'admin-only op (actor role checked first)',
    queries: [
      '4fe10a82', // SELECT id FROM pts WHERE id=? AND deleted_at IS NULL
    ]
  },
  '../src/ops/stripe-jobs.mjs::prepareConnect': {
    why: "PT owner or admin: pts row for the resolved pt_id; single-connect pre-check",
    queries: [
      'abf4ec84', // SELECT * FROM pts WHERE id=?
      'd8aa094b', // SELECT pt_id FROM stripe_connections WHERE NOT (pt_id=? AND mode=?) LI
    ]
  },
  '../src/ops/stripe-jobs.mjs::bindStmts': {
    why: "system: binds the account from a verified Stripe job to the job's pt_id",
    queries: [
      '4b9fd779', // NOT EXISTS(SELECT 1 FROM stripe_connections WHERE mode=? AND account_i
      '7b61835a', // NOT EXISTS(SELECT 1 FROM stripe_connections WHERE NOT (pt_id=? AND mod
      'b2681801', // UPDATE pts SET stripe_account=?,stripe_ready=? WHERE id=?
      'c50e14e5', // INSERT INTO stripe_connections(pt_id,mode,account_id,routing,ready) VA
    ]
  },
  '../src/ops/stripe-jobs.mjs::actor': {
    why: 'loads the signed-in user by id (the caller itself)',
    queries: [
      'cc279490', // SELECT id,role,pt_id,email,name,must_change_password FROM users WHERE 
    ]
  },
  '../src/ops/password-reset.mjs::resetPassword': {
    why: "reset by HMAC-verified token: touches only that token's user",
    queries: [
      '831b3b65', // EXISTS(SELECT 1 FROM password_resets r JOIN users u ON u.id=r.user_id 
      'ecf1970f', // UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?
      'faacb7da', // SELECT r.*,u.email,u.role,u.active,u.demo,u.password_hash current_hash
    ]
  },
  '../src/ops/password-reset.mjs::requestReset': {
    why: 'public reset request: generic response, nothing returned to the caller',
    queries: [
      'cafb0bdf', // SELECT * FROM users WHERE email=? AND active=1 AND demo=0 AND role IN 
    ]
  },
  '../src/ops/manage.mjs::createPt>replay': {
    why: 'admin-only op: replay lookup by create_key',
    queries: [
      '87bf779f', // SELECT p.id,p.slug,p.create_hash,u.email,u.must_change_password FROM p
    ]
  },
  '../src/ops/manage.mjs::createPt': {
    why: 'admin-only op (actor role checked first): creates the PT and its user',
    queries: [
      '33751c95', // INSERT INTO users(id,name,email,password_hash,role,pt_id,must_change_p
      '7190ef7c', // NOT EXISTS(SELECT 1 FROM pts WHERE deleted_at IS NULL)
      '93b0bb8a', // INSERT INTO pts(id,slug,brand_name,tagline,description,about,accent,ba
    ]
  },
  '../src/ops/manage.mjs::deletePt': {
    why: 'admin-only op (actor role checked first): soft-deletes a PT, keeps booking/payment rows',
    queries: [
      '21d34f50', // UPDATE users SET active=0,deleted_at=?,email='deleted+' || id || '@del
      'a1ad6c46', // UPDATE pts SET slug=?,published=0,deleted_at=?,stripe_ready=0,create_k
      '40a7eeb2', // UPDATE blocks SET published=0,closed=1 WHERE pt_id=?
      '5e125b5b', // DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE pt_i
      '791cef76', // SELECT id,role FROM users WHERE pt_id=? AND deleted_at IS NULL
      '81e31db3', // SELECT deleted_at FROM pts WHERE id=?
      '980dc246', // UPDATE pt_stripe_credentials SET enabled=0 WHERE pt_id=?
      '9860104e', // DELETE FROM stripe_connections WHERE pt_id=?
      'a986e2bf', // EXISTS(SELECT 1 FROM pts WHERE id=? AND deleted_at IS NULL)
      'b9ea3965', // SELECT * FROM pts WHERE id=? AND deleted_at IS NULL
    ]
  },
  '../src/ops/manage.mjs::upcomingBookingsSql': {
    why: 'admin deletePt: count upcoming paid/pending bookings for this pt_id',
    queries: [
      'aa2b2344', // SELECT count(*) n FROM bookings b JOIN blocks bl ON bl.id=b.block_id W
    ]
  },
  '../src/ops/manage.mjs::noUpcomingSql': {
    why: 'admin deletePt: commit-time guard, same upcoming booking predicate for this pt_id',
    queries: [
      'f0b5ee57', // NOT EXISTS(SELECT 1 FROM bookings b JOIN blocks bl ON bl.id=b.block_id
    ]
  },
  '../src/ops/manage.mjs::actor': {
    why: 'loads the signed-in user by id (the caller itself)',
    queries: [
      '67051a79', // SELECT id,role,pt_id,active,must_change_password FROM users WHERE id=?
    ]
  },
  '../src/ops/bookings.mjs::stripeConnection': {
    why: "payment routing for the block's own pt_id (block already scoped)",
    queries: [
      '7c8afa9c', // SELECT stripe_account,stripe_ready FROM pts WHERE id=?
      'a49c8539', // SELECT * FROM pt_stripe_credentials WHERE pt_id=? AND mode=?
      'e4408298', // SELECT account_id,routing,ready,charges_enabled,payouts_enabled,detail
    ]
  },
  '../src/ops/accounts.mjs::updatePtBranding': {
    why: 'admin-only op (actor role checked first)',
    queries: [
      '7f093749', // UPDATE pts SET slug=?,brand_name=?,tagline=?,description=?,about=?,acc
      'e9162fed', // SELECT id,role FROM users WHERE id=? AND active=1
    ]
  },
  '../src/ops/accounts.mjs::changePassword': {
    why: 'own account only: id is the signed-in user',
    queries: [
      'a825c7d7', // EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND password_hash=?
      'ecf1970f', // UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?
    ]
  },
  '../src/ops/accounts.mjs::bindConnection': {
    why: 'PT owner or admin: persist the Connect snapshot for the resolved pt_id',
    queries: [
      '5f50fda9', // SELECT id,role,pt_id FROM users WHERE id=? AND active=1
      '704793ed', // UPDATE stripe_connections SET ready=?,charges_enabled=?,payouts_enable
      'd54e1a4c', // UPDATE pts SET stripe_ready=? WHERE id=? AND stripe_account=?
    ]
  },
  '../src/connect-status.mjs::resolveConnectPtId': {
    why: 'PT owner (own pt_id) or admin (explicit pt_id, or the one PT in single-PT mode)',
    queries: [
      '32ab894c', // SELECT id FROM pts WHERE deleted_at IS NULL ORDER BY created_at LIMIT
      '4fe10a82', // SELECT id FROM pts WHERE id=? AND deleted_at IS NULL
    ]
  },
  '../src/mail.mjs::deliverAuthMail': {
    why: 'system (Cron Trigger): recipient of a queued auth mail job, by id',
    queries: [
      '6deccc12', // SELECT * FROM users WHERE id=? AND active=1
    ]
  },
  '../src/auth.mjs::currentUser': {
    why: "session lookup by token hash: returns only the session's own user",
    queries: [
      '12c5eecc', // SELECT u.*,s.csrf,s.expires_at FROM sessions s JOIN users u ON u.id=s.
    ]
  },
  '../scripts/bootstrap-admin.mjs::main': {
    why: 'owner-only CLI: refuses when an admin already exists',
    queries: [
      '62c6dc0a', // SELECT count(*) AS admins FROM users WHERE role='admin'
    ]
  },
  '../scripts/bootstrap-admin.mjs::bootstrapAdminSql': {
    why: 'owner-only CLI: one-off admin bootstrap SQL (no tenant)',
    queries: [
      'cf8a91d8', // INSERT INTO users(id,name,email,password_hash,role,created_at) SELECT 
    ]
  },
  '../scripts/seed-dev-pt.mjs::main': {
    why: 'local-only CLI: counts pts after a dev seed; never run with --remote',
    queries: [
      '593c9201', // SELECT count(*) AS pts FROM pts
    ]
  },
  '../scripts/seed-dev-pt.mjs::seedDevPtSql': {
    why: 'local-only CLI: one published PT and its user if none exist (no tenant; no admin change)',
    queries: [
      '4635d793', // INSERT INTO pts(...) SELECT ... WHERE NOT EXISTS(SELECT 1 FROM pts); INSERT INTO users(...)
    ]
  },
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
      'a9f8c51f', // SELECT id, ROW_NUMBER() OVER (PARTITION BY block_id, customer_id ${}) A
    ]
  },
  '../src/emails.mjs::confirmationInsert': {
    why: "system: outbox insert for a booking id the caller already authorised (webhook/payment op)",
    queries: [
      '4479630c', // SELECT starts_at FROM class_sessions WHERE block_id=? ORDER BY starts_
      '89ee9507', // SELECT * FROM blocks WHERE id=?
      '91231c6d', // SELECT * FROM bookings WHERE id=?
      '9b4cb986', // INSERT OR IGNORE INTO email_outbox(id,pt_id,customer_id,dedupe_key,rec
      'abf4ec84', // SELECT * FROM pts WHERE id=?
      'fe0a9ecc', // SELECT name,email FROM users WHERE id=?
    ]
  },
  '../src/emails.mjs::noShowInsert': {
    why: "system: outbox insert inside markAttendance after scopeFor().booking()",
    queries: [
      '2e285986', // INSERT OR IGNORE INTO email_outbox(id,pt_id,customer_id,dedupe_key,rec
    ]
  },
  '../src/profile.mjs::readPtProfile': {
    why: 'PT-only route: the signed-in PT reads their own pts row by user.pt_id',
    queries: [
      'abf4ec84', // SELECT * FROM pts WHERE id=?
    ]
  },
  '../src/ops/profile.mjs::updatePtProfile': {
    why: 'PT-only writer op: re-reads the actor, then updates only their own pts row by user.pt_id',
    queries: [
      '5f50fda9', // SELECT id,role,pt_id FROM users WHERE id=? AND active=1
      'abf4ec84', // SELECT * FROM pts WHERE id=?
      'abf4ec84', // SELECT * FROM pts WHERE id=?
      '5f6b88e1', // UPDATE pts SET brand_name=?,about=?,business_name=?,contact_email=?,co
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
      '0041d856', // SELECT u.email AS login_email, p.reply_to_email, p.reply_to_name FROM 
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
      '5f50fda9', // SELECT id,role,pt_id FROM users WHERE id=? AND active=1
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
      '4fe10a82', // SELECT id FROM pts WHERE id=? AND deleted_at IS NULL
      'ba9eb617', // INSERT INTO blocks(id,pt_id,title,description,venue,price_pence,capaci
    ]
  },
  '../src/ops/manage.mjs::markAttendance': {
    why: "keyed by booking/session ids first returned by scopeFor()",
    queries: [
      '4bb67f23', // EXISTS(SELECT 1 FROM bookings WHERE id=? AND status='paid')
      '4ccb536b', // SELECT * FROM class_sessions WHERE id=? AND block_id=?
      '594f42e1', // INSERT INTO attendance VALUES(?,?,?,?,?) ON CONFLICT(booking_id,sessio
      'c968da9a', // SELECT id,status,subject,body FROM email_outbox WHERE dedupe_key=?
      '6ec86903', // SELECT * FROM users WHERE id=?
      'abf4ec84', // SELECT * FROM pts WHERE id=?
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
  '../src/ops/theme.mjs::readPtTheme': {
    why: 'PT-only route: the signed-in PT reads their own pts row by user.pt_id',
    queries: [
      '213549cf', // SELECT accent,background,foreground FROM pts WHERE id=?
    ]
  },
  '../src/ops/theme.mjs::updatePtTheme': {
    why: 'PT-only writer op: re-reads the actor, then updates only their own pts colour columns by user.pt_id',
    queries: [
      '5f50fda9', // SELECT id,role,pt_id FROM users WHERE id=? AND active=1
      '4b1f8101', // SELECT id FROM pts WHERE id=?
      '5a88c258', // UPDATE pts SET accent=?,background=?,foreground=? WHERE id=?
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
      '3a8f6ced', // UPDATE pt_stripe_credentials SET charges_ready=?,payouts_ready=?,enabl
      '8aa04ec6', // UPDATE stripe_connections SET ready=?,charges_enabled=?,payouts_enable
      'cf4ab232', // UPDATE pts SET stripe_ready=? WHERE stripe_account=?
      'f0b8d0cd', // SELECT stripe_account FROM pts WHERE id=?
      'fcc80658', // SELECT id,account_id FROM pt_stripe_credentials WHERE id=?
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
      'aa1044ba', // SELECT * FROM pt_stripe_credentials WHERE pt_id=? AND mode IN ('stripe
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
      '61a62fb3', // SELECT * FROM pts WHERE slug=? AND published=1
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
      '02bd1c35', // SELECT p.*,u.name owner_name,u.email owner_email,u.active owner_active
      '0e3720a6', // SELECT count(*) n FROM attendance a JOIN bookings b ON b.id=a.booking_
      'abf4ec84', // SELECT * FROM pts WHERE id=?
      'b2e884bd', // SELECT count(*) n FROM users WHERE role='customer'
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

// CR 5940914487 M4: SQL calls whose SQL is not one plain literal (concatenated, interpolated
// template, identifier, other expression) must each be listed here too. Fingerprints for
// dynamic/expr entries are of the argument text, so editing one fails until re-reviewed.
export const NONLITERAL = {
  '../src/cutover.mjs::importGate::ident:DUPLICATE_REPORT_SQL': 'cutover CLI: module constant from the same file (fingerprinted above)',
  '../src/cutover.mjs::markDuplicatesForReview::ident:sql': 'cutover CLI: runs MARK_SQL() statements (fingerprinted above)',
  '../src/db.mjs::createDb>stmt::ident:sql': 'the D1 wrapper itself: every caller is linted at its own call site',
  '../src/ops/password-reset.mjs::requestReset::dynamic::0067fc82': '${limited} is a constant rate-limit predicate built in the same function; values are bound',
  '../src/ops/password-reset.mjs::requestReset::dynamic::aa8ad8ff': '${limited} is a constant rate-limit predicate built in the same function; values are bound',
  '../src/ops/stripe-jobs.mjs::prepareRefund::ident:activeSql': 'local constant literal in the same function (stripe_jobs by booking id already scoped)',
  '../src/ops/manage.mjs::deletePt::ident:noUpcomingSql': 'local constant literal in the same file (upcoming paid/pending bookings for this pt_id)',
  '../src/ops/manage.mjs::deletePt::ident:upcomingBookingsSql': 'local constant literal in the same file (upcoming paid/pending bookings for this pt_id)',
  '../src/ops/webhooks.mjs::refundWrites::dynamic::75b0d86d': '${total}/${pending} are constant SQL sub-expressions defined in the same function',
  '../src/scope.mjs::scopeFor>block::dynamic::bc8ac335': 'scopeFor: ${} is the role scope predicate',
  '../src/scope.mjs::scopeFor>booking::dynamic::36684df0': 'scopeFor: base select + role scope predicate',
  '../src/scope.mjs::scopeFor>booking::dynamic::7281c458': 'scopeFor: base select, customer-scoped',
  '../src/scope.mjs::scopeFor>bookings::dynamic::1c68967c': 'scopeFor: base select + role scope predicate',
  '../src/scope.mjs::scopeFor>bookings::dynamic::b9bffe24': 'scopeFor: base select, customer-scoped',
  '../src/scope.mjs::scopeFor>outbox::dynamic::f2773b8b': 'scopeFor: role scope predicate',
  '../src/scope.mjs::scopeFor>updateBlockStmt::dynamic::46ab8046': 'scopeFor: whitelisted column list; admin form',
  '../src/scope.mjs::scopeFor>updateBlockStmt::dynamic::a709c197': 'scopeFor: whitelisted column list; PT form with pt_id',
  '../scripts/snapshot-import.mjs::columns::dynamic::6c71ef31': 'local import CLI (node:sqlite scratch copy): table name from the fixed TABLE_ORDER list',
  '../scripts/snapshot-import.mjs::insertStatements::dynamic::a5a8a63d': 'local import CLI: column list and table name from the fixed schema/TABLE_ORDER',
  '../scripts/snapshot-import.mjs::prepareImport::ident:DUPLICATE_REPORT_SQL': 'local import CLI: same duplicate report as the cutover gate',
  '../scripts/snapshot-import.mjs::prepareImport::ident:sql': 'local import CLI: runs MARK_SQL() statements on the scratch copy (opt-in phrase)',
  '../scripts/snapshot-import.mjs::rowCounts::dynamic::fac7f363': 'local import CLI: table name from the fixed TABLE_ORDER list',
  '../src/views.mjs::inChunks::expr::4eef12a7': 'expands (?*) to ? placeholders for chunked IN lists; callers pass literals (fingerprinted)'
};
// CR 5941600057 M4: get/all/run/exec/... calls on a receiver that is not the db wrapper.
export const RECEIVERS = {
  '../scripts/snapshot-import.mjs::expectedSchema::receiver:mem.exec': 'local import CLI: node:sqlite in-memory DB built from migrations/ (schema only)',
  '../scripts/snapshot-import.mjs::prepareImport::receiver:upgraded.exec': 'local import CLI: node:sqlite scratch copy, runs the migration files',
  '../src/writer.mjs::write::receiver:binding.get': 'Durable Object namespace get(id), not SQL',
  '../src/writer.mjs::write::receiver:stub.run': 'Writer RPC run(name, args), not SQL'
};
// Uses of a module-level SQL constant outside the file that defines it.
export const CONST_USES = {
  '../scripts/cutover-import.mjs::uses:DUPLICATE_REPORT_SQL': 'cutover CLI (local scratch DB): same report as the gate',
  '../scripts/cutover-import.mjs::uses:MARK_SQL': 'cutover CLI: writes the opt-in mark SQL to a 0600 file',
  '../scripts/snapshot-import.mjs::uses:DUPLICATE_REPORT_SQL': 'local snapshot import: duplicate gate on the scratch copy',
  '../scripts/snapshot-import.mjs::uses:MARK_SQL': 'local snapshot import: opt-in duplicate marking on the scratch copy'
};

/** Everything the lint reports for a source map (empty = clean). */
export function violations(src, problems = []) {
  return [
    ...problems.map(p => 'graph ' + p),
    ...ptOwnedQueries(src).filter(q => !allowedKeys().includes(q.key)).map(q => 'query ' + q.key),
    ...nonLiteralSqlCalls(src).filter(q => !(q.key in NONLITERAL)).map(q => 'nonliteral ' + q.key),
    ...rawAccess(src).map(r => 'raw ' + r),
    ...foreignReceiverCalls(src).filter(k => !(k in RECEIVERS)).map(k => 'receiver ' + k),
    ...sqlConstantUses(src).filter(k => !(k in CONST_USES)).map(k => 'uses ' + k),
    ...(sqlCallCount(src['../worker/index.mjs'] || '') ? ['worker/index.mjs makes SQL calls'] : [])
  ];
}

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

  it('non-literal SQL calls, raw D1 access and SQL-constant reuse are all allowlisted; nothing stale', () => {
    const nl = [...new Set(nonLiteralSqlCalls(sources).map(q => q.key))].sort();
    expect(nl).toEqual(Object.keys(NONLITERAL).sort());
    expect(rawAccess(sources)).toEqual([]);
    expect(foreignReceiverCalls(sources)).toEqual(Object.keys(RECEIVERS).sort());
    expect(sqlConstantUses(sources)).toEqual(Object.keys(CONST_USES).sort());
    expect(sqlCallCount(sources['../worker/index.mjs'])).toBe(0);
    expect(violations(sources)).toEqual([]);
  });

  // CR 5940914487 M4: each reported bypass, plus aliasing, injected into the Worker entry and
  // into an allowlisted src function; every one must be reported by a rule other than the
  // "worker makes no SQL calls" rule as well.
  const BYPASSES = {
    concatenated: "db.all('SELECT * FROM ' + 'bookings')",
    template: "db.all(`SELECT * FROM ${'bookings'}`)",
    quoted: 'db.all(\'SELECT * FROM "bookings"\')',
    backtick_quoted: "db.all('SELECT * FROM `bookings`')",
    schema_qualified: "db.all('SELECT * FROM main.bookings')",
    block_comment: "db.all('SELECT * FROM/**/bookings')",
    line_comment: "db.all('SELECT * FROM -- x\\n bookings')",
    credentials: "db.all('SELECT * FROM pt_stripe_credentials')",
    users: "db.all('SELECT * FROM users')",
    pts: "db.get('SELECT * FROM pts WHERE id=?', id)",
    allowlisted_constant: 'db.all(DUPLICATE_REPORT_SQL)',
    method_alias: "(0, db.all)('SELECT 1')",
    computed_member: "db['all']('SELECT 1')",
    destructured: "(({ all }) => all)(db)",
    raw_binding: "env.DB.prepare('SELECT 1').all()",
    raw_wrapper_d1: "db.d1.prepare('SELECT 1').all()",
    variable: "db.all(q)",
    // CR 5941600057 M4: each of these passed the lint at 036cb53 and leaked at runtime.
    cr_db_alias: "(() => { const h = db; return h.all(q); })()",
    cr_object_property_alias: "(() => { const o = { h: db }; return o.h.all(q); })()",
    cr_env_destructuring: "(() => { const { DB: x } = env; return x.prepare(q).all(); })()",
    cr_comma_join: "db.all('SELECT b.* FROM (SELECT 1) z, bookings b')",
    cr_unicode_escape: "db.all('SELECT * FROM \\u0062ookings')",
    cr_hex_escape: "db.all('SELECT * FROM \\x62ookings')",
    // and their neighbours
    unicode_brace_escape: "db.all(`SELECT * FROM \\u{62}ookings`)",
    line_continuation: "db.all('SELECT * FROM book\\\nings')",
    arrow_alias: "((h => h)(db)).all(q)",
    call_result_receiver: "(await Promise.resolve(db)).all(q)",
    raw_binding_argument: "createDbLike(env.DB)",
    computed_env: "env[q].prepare('SELECT 1').all()",
    reflect: "Reflect.get(db, 'all')(q)",
    durable_object_env: "this.env.DB.prepare(q).all()",
    platform_env_import: "(await import('cloudflare:workers')).env"
  };
  for (const [name, call] of Object.entries(BYPASSES)) {
    it(`bypass "${name}" is caught in worker/index.mjs and in an allowlisted src function`, () => {
      const inWorker = { ...sources, '../worker/index.mjs': sources['../worker/index.mjs'] + `\nexport async function leak(db, env, id, q) {\n  return ${call};\n}\n` };
      const w = violations(inWorker);
      expect(w.filter(v => v !== 'worker/index.mjs makes SQL calls').length, name + ': ' + w.join('; ')).toBeGreaterThan(0);
      const views = sources['../src/views.mjs'].replace('export async function dashboard(', `export async function dashboard(db, env, id, q) { await ${call}; }\nasync function dashboardOld(`);
      const v = violations({ ...sources, '../src/views.mjs': views });
      expect(v.length, name).toBeGreaterThan(0);
    });
  }
});

// QA D2 (f978692): file discovery. QA's two misses (unscoped SQL in src/*.js imported by the
// Worker; a file outside src/worker/scripts imported into them) plus every JS/TS extension,
// index files, TS-style './x.js' -> x.ts, and the graph's own fail-closed rules.
describe('scope lint file discovery (import graph + backstop)', () => {
  const LEAK = "export async function hiddenLeak(db) {\n  return db.all('SELECT * FROM bookings');\n}\n";
  const ENV_LEAK = "export async function envLeak(env) {\n  return env.DB.prepare('SELECT * FROM bookings').all();\n}\n";
  const lint = (extra = {}, edit = {}) => {
    const files = { ...REPO, ...extra };
    for (const [f, fn] of Object.entries(edit)) files[f] = fn(files[f]);
    const r = lintFiles(files);
    return { v: violations(r.sources, r.problems), linted: Object.keys(r.sources), problems: r.problems };
  };
  const importInto = (target, spec) => ({ [target]: src => `import * as qaLeak from '${spec}';\n` + src });

  it('the real tree: graph resolves with no problems; Worker, preview entry and scripts are covered', () => {
    expect(LINT.problems).toEqual([]);
    for (const f of [WORKER_MAIN, '../docs/rc-4/preview/entry.mjs', '../src/writer.mjs', '../src/ops/index.mjs', '../scripts/dump-app-schema.cjs']) expect(LINT.graph.concat(Object.keys(sources))).toContain(f);
    expect(Object.keys(sources).some(f => /^\.\.\/(app|netlify)\//.test(f))).toBe(false);
    expect(Object.keys(REPO).filter(f => !f.startsWith('../'))).toEqual([]);
    expect(Object.keys(REPO)).toEqual(expect.arrayContaining(['../workers-test/helpers.mjs', '../workers-test/scope-lint-core.mjs', '../app/server.cjs', '../lib/storage.mjs']));
    console.log('scope lint files:', Object.keys(sources).length, 'of', Object.keys(REPO).length, 'JS/TS files; legacy edges', LINT.legacy.length);
  });

  it('(a) unscoped SQL in src/*.js imported from the Worker entry is caught (QA miss 1), and also when not imported', () => {
    const imported = lint({ '../src/qa-leak-hidden.js': LEAK + ENV_LEAK }, importInto(WORKER_MAIN, '../src/qa-leak-hidden.js'));
    expect(imported.linted).toContain('../src/qa-leak-hidden.js');
    expect(imported.v.filter(x => x.includes('qa-leak-hidden.js'))).toEqual(expect.arrayContaining([expect.stringMatching(/^query \.\.\/src\/qa-leak-hidden\.js::hiddenLeak::/), expect.stringMatching(/raw \.\.\/src\/qa-leak-hidden\.js::envLeak::raw DB binding/)]));
    expect(lint({ '../src/qa-leak-hidden.js': LEAK }).v.some(x => x.startsWith('query ../src/qa-leak-hidden.js'))).toBe(true); // backstop
  });

  it('(b) a file outside src/worker/scripts imported into them is caught (QA miss 2), extensionless and index imports too', () => {
    for (const [file, spec, into] of [
      ['../lib/qa-leak.mjs', '../lib/qa-leak.mjs', '../src/views.mjs'],
      ['../outside/leak.mjs', '../outside/leak', WORKER_MAIN],
      ['../lib/qa/index.js', '../../lib/qa', '../src/ops/bookings.mjs'],
      ['../docs/qa-deep.cjs', '../docs/qa-deep.cjs', '../scripts/bootstrap-admin.mjs'],
      ['../workers-test/qa-helper.mjs', '../workers-test/qa-helper.mjs', WORKER_MAIN]
    ]) {
      const r = lint({ [file]: LEAK }, importInto(into, spec));
      expect(r.linted, file).toContain(file);
      expect(r.v.some(x => x.startsWith('query ' + file + '::hiddenLeak::')), file).toBe(true);
    }
    // Transitive: worker -> src/a.js -> lib/b.ts
    const t = lint({ '../src/qa-a.js': "export { hiddenLeak } from '../lib/qa-b.js';\n", '../lib/qa-b.ts': LEAK.replace('(db)', '(db: any)') }, importInto(WORKER_MAIN, '../src/qa-a.js'));
    expect(t.v.some(x => x.startsWith('query ../lib/qa-b.ts::'))).toBe(true);
  });

  it('every JS/TS extension is linted, in the backstop and through the graph', () => {
    for (const ext of ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']) {
      expect(lint({ ['../src/qa-ext' + ext]: LEAK }).v.some(x => x.startsWith(`query ../src/qa-ext${ext}::`)), 'backstop ' + ext).toBe(true);
      expect(lint({ ['../worker/qa-ext' + ext]: LEAK }).v.some(x => x.startsWith(`query ../worker/qa-ext${ext}::`)), 'worker ' + ext).toBe(true);
      const g = lint({ ['../lib/qa-ext' + ext]: LEAK }, importInto('../src/views.mjs', '../lib/qa-ext' + ext));
      expect(g.v.some(x => x.startsWith(`query ../lib/qa-ext${ext}::`)), 'graph ' + ext).toBe(true);
    }
  });

  it('.ts cases: TS-style "./x.js" import resolves to x.ts; type-annotated env.DB access is caught', () => {
    const r = lint({ '../lib/qa-ts.ts': 'export async function tsLeak(env: { DB: D1Database }): Promise<unknown> {\n  return env.DB.prepare(`SELECT * FROM bookings`).all();\n}\n' }, importInto('../src/views.mjs', '../lib/qa-ts.js'));
    expect(r.problems).toEqual(['../src/views.mjs -> ../lib/qa-ts.ts::import outside the scanned roots (src/, worker/, scripts/)']); // resolved (not 'unresolved')
    expect(r.v).toEqual(expect.arrayContaining([expect.stringMatching(/^query \.\.\/lib\/qa-ts\.ts::tsLeak::/), expect.stringMatching(/^raw \.\.\/lib\/qa-ts\.ts::tsLeak::raw DB binding/)]));
  });

  it('fails closed on what the graph cannot follow', () => {
    const cases = {
      unresolved: [{}, importInto(WORKER_MAIN, '../nowhere/leak.mjs'), /unresolved import \.\.\/nowhere\/leak\.mjs/],
      dynamic: [{}, { [WORKER_MAIN]: s => s + "\nexport const qaLoad = (p) => import(p);\n" }, /non-literal import\(p\)/],
      require_dynamic: [{}, { '../src/views.mjs': s => s + "\nexport const qaReq = (p) => require('../' + p);\n" }, /non-literal require/],
      absolute: [{}, importInto(WORKER_MAIN, '/tmp/leak.mjs'), /absolute specifier/],
      subpath: [{}, importInto(WORKER_MAIN, '#leak'), /unsupported specifier #leak/],
      worker_imports_legacy: [{}, importInto('../src/views.mjs', '../app/db.cjs'), /Worker code imports legacy code/],
      new_legacy_edge: [{}, importInto('../scripts/bootstrap-admin.mjs', '../app/db.cjs'), /unlisted import of legacy code/]
    };
    for (const [name, [extra, edit, re]] of Object.entries(cases)) {
      const r = lint(extra, edit);
      expect(r.v.some(x => x.startsWith('graph ') && re.test(x)), name + ': ' + JSON.stringify(r.problems)).toBe(true);
    }
  });
  it('CR 5943169048 C1 exact repro: lib/zzhelper.mjs `q=(db,s)=>db.all(s)` imported into src/views.mjs is caught twice', () => {
    const r = lint({ '../lib/zzhelper.mjs': 'export const q=(db,s)=>db.all(s)\n' }, {
      '../src/views.mjs': src => "import { q } from '../lib/zzhelper.mjs';\n" + src.replace('await scope.bookings()', "await q(db,'SELECT * FROM '+'bookings')")
    });
    expect(r.linted).toContain('../lib/zzhelper.mjs');
    expect(r.v).toEqual(expect.arrayContaining([
      'graph ../src/views.mjs -> ../lib/zzhelper.mjs::import outside the scanned roots (src/, worker/, scripts/)',
      expect.stringMatching(/^nonliteral \.\.\/lib\/zzhelper\.mjs::/)
    ]));
  });

  it('CR 5943169048 C1: any relative import resolving outside src/worker/scripts fails, even with harmless content, unless listed', () => {
    const harmless = lint({ '../lib/qa-pure.mjs': 'export const add = (a, b) => a + b;\n' }, importInto('../src/util.mjs', '../lib/qa-pure.mjs'));
    expect(harmless.v).toEqual(['graph ../src/util.mjs -> ../lib/qa-pure.mjs::import outside the scanned roots (src/, worker/, scripts/)']);
    const listed = lintSet({ ...REPO, '../lib/qa-pure.mjs': 'export const add = (a, b) => a + b;\n', '../src/util.mjs': "import '../lib/qa-pure.mjs';\n" + REPO['../src/util.mjs'] },
      { ...GRAPH, outsideEdges: [...GRAPH.outsideEdges, '../src/util.mjs -> ../lib/qa-pure.mjs'], entries: Object.keys(REPO).filter(f => f.startsWith('../scripts/')) });
    expect(violations(listed.sources, listed.problems)).toEqual([]);
    expect(Object.keys(listed.sources)).toContain('../lib/qa-pure.mjs'); // listed, but still scanned
  });
});

