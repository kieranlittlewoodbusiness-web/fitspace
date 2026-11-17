-- RC-4 / D1: the 17 tables from app/db.cjs, as they stand after the in-app v5 and v6
-- migrations (main 7cebef2). SQLite dialect, unchanged column names and CHECKs, so the
-- ported data-access code keeps the same SQL. D1 enforces foreign keys by default.
-- Differences from app/db.cjs (intentional):
--   * bookings carries the v5 columns inline and the v6 mode CHECK (incl. 'stripe_live');
--   * the runtime PRAGMAs (WAL, busy_timeout) and table-rebuild migration are dropped:
--     D1 manages journaling and rejects BEGIN/SAVEPOINT.

CREATE TABLE pts(
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, brand_name TEXT NOT NULL, tagline TEXT NOT NULL,
  description TEXT NOT NULL, about TEXT NOT NULL, accent TEXT NOT NULL DEFAULT '#ffd43b',
  background TEXT NOT NULL DEFAULT '#ffffff', foreground TEXT NOT NULL DEFAULT '#111111',
  features TEXT NOT NULL DEFAULT '[]', published INTEGER NOT NULL DEFAULT 1, stripe_account TEXT,
  stripe_ready INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);

CREATE TABLE users(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('customer','pt','admin')), pt_id TEXT REFERENCES pts(id),
  active INTEGER NOT NULL DEFAULT 1, must_change_password INTEGER NOT NULL DEFAULT 0,
  demo INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX users_pt ON users(pt_id);

CREATE TABLE sessions(
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL);

CREATE TABLE blocks(
  id TEXT PRIMARY KEY, pt_id TEXT NOT NULL REFERENCES pts(id), title TEXT NOT NULL,
  description TEXT NOT NULL, venue TEXT NOT NULL, price_pence INTEGER NOT NULL CHECK(price_pence>=0),
  capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 100), published INTEGER NOT NULL DEFAULT 1,
  closed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);

CREATE TABLE class_sessions(
  id TEXT PRIMARY KEY, block_id TEXT NOT NULL REFERENCES blocks(id), starts_at TEXT NOT NULL,
  starts_epoch INTEGER NOT NULL, duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 15 AND 240),
  UNIQUE(block_id,starts_at));

CREATE TABLE bookings(
  id TEXT PRIMARY KEY, block_id TEXT NOT NULL REFERENCES blocks(id),
  customer_id TEXT NOT NULL REFERENCES users(id), reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending','paid','failed','cancelled','expired','review')),
  amount_pence INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('demo','stripe_test','stripe_live')),
  checkout_token TEXT NOT NULL UNIQUE, checkout_session TEXT UNIQUE, checkout_url TEXT,
  expires_at INTEGER NOT NULL, paid_at INTEGER, created_at INTEGER NOT NULL,
  stripe_credential_id TEXT, stripe_account_id TEXT, payment_intent TEXT, payment_error TEXT,
  refund_status TEXT NOT NULL DEFAULT 'none', refunded_pence INTEGER NOT NULL DEFAULT 0,
  charge_refunded_pence INTEGER NOT NULL DEFAULT 0, refund_error TEXT,
  stripe_routing TEXT NOT NULL DEFAULT 'connected',
  UNIQUE(customer_id,checkout_token));
CREATE INDEX bookings_block_status ON bookings(block_id,status,expires_at);
CREATE UNIQUE INDEX booking_payment_intent ON bookings(payment_intent) WHERE payment_intent IS NOT NULL;

CREATE TABLE attendance(
  booking_id TEXT NOT NULL REFERENCES bookings(id), session_id TEXT NOT NULL REFERENCES class_sessions(id),
  status TEXT NOT NULL CHECK(status IN ('attended','no_show','unmarked')),
  marked_by TEXT NOT NULL REFERENCES users(id), marked_at INTEGER NOT NULL,
  PRIMARY KEY(booking_id,session_id));

CREATE TABLE email_outbox(
  id TEXT PRIMARY KEY, pt_id TEXT REFERENCES pts(id), customer_id TEXT REFERENCES users(id),
  dedupe_key TEXT NOT NULL UNIQUE, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  kind TEXT NOT NULL, quote_index INTEGER, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT, last_error TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, sent_at INTEGER);

CREATE TABLE webhook_events(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);

CREATE TABLE audit_log(
  id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, target_id TEXT, created_at INTEGER NOT NULL);

CREATE TABLE stripe_jobs(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, last_error TEXT,
  created_at INTEGER NOT NULL);

CREATE TABLE stripe_refunds(
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES bookings(id), amount_pence INTEGER NOT NULL,
  status TEXT NOT NULL, event_time INTEGER NOT NULL DEFAULT 0);

CREATE TABLE stripe_connections(
  pt_id TEXT NOT NULL REFERENCES pts(id), mode TEXT NOT NULL CHECK(mode IN ('stripe_test','stripe_live')),
  account_id TEXT NOT NULL, routing TEXT NOT NULL CHECK(routing IN ('connected','platform')),
  ready INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(pt_id,mode), UNIQUE(mode,account_id));

CREATE TABLE password_resets(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL);

CREATE TABLE password_reset_limits(id TEXT PRIMARY KEY, email_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX reset_limits_email ON password_reset_limits(email_hash,created_at);

CREATE TABLE auth_mail_jobs(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), reset_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('link','changed')), recipient TEXT NOT NULL, sender TEXT NOT NULL,
  origin TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', last_error TEXT, created_at INTEGER NOT NULL);

CREATE TABLE pt_stripe_credentials(
  id TEXT PRIMARY KEY, pt_id TEXT NOT NULL REFERENCES pts(id),
  mode TEXT NOT NULL CHECK(mode IN ('stripe_test','stripe_live')), account_id TEXT NOT NULL,
  api_cipher TEXT, webhook_cipher TEXT, enabled INTEGER NOT NULL DEFAULT 0,
  charges_ready INTEGER NOT NULL DEFAULT 0, payouts_ready INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER, webhook_seen_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(pt_id,mode), UNIQUE(mode,account_id));
