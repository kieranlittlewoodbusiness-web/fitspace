-- RC-4 / D1: concurrency locks for the no-interactive-transaction model, plus additive
-- columns and tables so RC-5..RC-9 (TICKETS.md) need no table rebuilds later.
-- Everything here is additive (new tables, nullable or defaulted columns, new indexes).

-- ---- Locks (partial unique indexes stand in for BEGIN IMMEDIATE) -------------------------
-- One live booking or checkout per customer per block. Replaces the read-then-check in
-- app/payments.cjs:10 ("You already have a booking or checkout in progress").
CREATE UNIQUE INDEX bookings_one_live_per_customer
  ON bookings(block_id,customer_id) WHERE status IN ('pending','paid');

-- Webhook idempotency: webhook_events.id is already the PRIMARY KEY. The key is
-- '<credential_id>:<evt_id>' for per-PT endpoints or '<evt_id>' for the platform endpoint
-- (app/payments.cjs:138). Record what was applied, for support and RC-7 billing events.
ALTER TABLE webhook_events ADD COLUMN type TEXT;
ALTER TABLE webhook_events ADD COLUMN account TEXT;

-- ---- RC-5 Stripe Connect onboarding (Express/Standard accounts, account links) -------------
ALTER TABLE stripe_connections ADD COLUMN charges_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stripe_connections ADD COLUMN payouts_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stripe_connections ADD COLUMN details_submitted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stripe_connections ADD COLUMN requirements TEXT NOT NULL DEFAULT '{}';
ALTER TABLE stripe_connections ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

-- ---- RC-7 PT subscription on the platform account ---------------------------------------
CREATE TABLE pt_subscriptions(
  pt_id TEXT PRIMARY KEY REFERENCES pts(id),
  mode TEXT NOT NULL CHECK(mode IN ('stripe_test','stripe_live')),
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT UNIQUE,
  price_id TEXT,
  status TEXT NOT NULL DEFAULT 'none'
    CHECK(status IN ('none','incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused')),
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  grace_until INTEGER,                -- lapsed: bookings stop now, classes unpublish after this
  last_event_created INTEGER NOT NULL DEFAULT 0, -- ignore out-of-order Stripe events
  updated_at INTEGER NOT NULL,
  UNIQUE(mode,stripe_customer_id));

-- ---- RC-8 Discount codes (PT- or admin-owned; class or subscription scope) ----------------
CREATE TABLE discount_codes(
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL CHECK(length(code) BETWEEN 3 AND 40),
  owner TEXT NOT NULL CHECK(owner IN ('pt','admin')),
  pt_id TEXT REFERENCES pts(id),            -- owning PT, or the target PT of an admin class code; NULL = any PT
  scope TEXT NOT NULL CHECK(scope IN ('class','all_classes','subscription')),
  block_id TEXT REFERENCES blocks(id),      -- set when scope='class'
  kind TEXT NOT NULL CHECK(kind IN ('percent','fixed')),
  amount INTEGER NOT NULL CHECK(amount>0),  -- percent 1..100, or pence
  max_uses INTEGER CHECK(max_uses IS NULL OR max_uses>0),
  uses INTEGER NOT NULL DEFAULT 0 CHECK(uses>=0 AND (max_uses IS NULL OR uses<=max_uses)),
  expires_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  stripe_coupon_id TEXT, stripe_promotion_code_id TEXT,   -- RC-8(c) subscription codes
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  CHECK(kind<>'percent' OR amount<=100),
  CHECK(scope<>'class' OR block_id IS NOT NULL),
  CHECK(owner<>'pt' OR pt_id IS NOT NULL));
-- Case-insensitive code, unique per owning PT ('' = platform-wide admin codes).
CREATE UNIQUE INDEX discount_codes_unique ON discount_codes(coalesce(pt_id,''),lower(code));

CREATE TABLE discount_redemptions(
  id TEXT PRIMARY KEY,
  code_id TEXT NOT NULL REFERENCES discount_codes(id),
  booking_id TEXT REFERENCES bookings(id),
  pt_id TEXT REFERENCES pts(id),            -- subscription redemptions
  customer_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'held' CHECK(status IN ('held','used','released')),
  created_at INTEGER NOT NULL,
  UNIQUE(code_id,booking_id));

ALTER TABLE bookings ADD COLUMN list_price_pence INTEGER;
ALTER TABLE bookings ADD COLUMN discount_pence INTEGER NOT NULL DEFAULT 0;
-- No REFERENCES here: SQLite cannot DROP a foreign-key column, which would block the
-- down-migration. Integrity comes from discount_redemptions(code_id, booking_id) instead.
ALTER TABLE bookings ADD COLUMN discount_code_id TEXT;

-- ---- RC-9 Richer class model ------------------------------------------------------------
ALTER TABLE blocks ADD COLUMN kind TEXT NOT NULL DEFAULT 'weekly_block' CHECK(kind IN ('one_off','weekly_block'));
ALTER TABLE blocks ADD COLUMN weeks INTEGER CHECK(weeks IS NULL OR weeks BETWEEN 1 AND 52);
ALTER TABLE blocks ADD COLUMN duration_minutes INTEGER CHECK(duration_minutes IS NULL OR duration_minutes BETWEEN 15 AND 240);
ALTER TABLE blocks ADD COLUMN location_type TEXT NOT NULL DEFAULT 'in_person' CHECK(location_type IN ('in_person','online'));
ALTER TABLE blocks ADD COLUMN online_url TEXT;
ALTER TABLE blocks ADD COLUMN cancellation_policy TEXT NOT NULL DEFAULT '{}'; -- JSON: refund window, fee, etc.
ALTER TABLE blocks ADD COLUMN updated_at INTEGER;

-- ---- RC-11 Waitlist (automatic offers when a place frees up) ----------------------------
CREATE TABLE waitlist_entries(
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL REFERENCES blocks(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','offered','accepted','expired','cancelled')),
  offer_expires_at INTEGER,
  booking_id TEXT REFERENCES bookings(id),
  created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX waitlist_one_live_per_customer
  ON waitlist_entries(block_id,customer_id) WHERE status IN ('waiting','offered');
CREATE INDEX waitlist_queue ON waitlist_entries(block_id,status,created_at);

-- ---- Worker-side rate limiting (replaces the Postgres checkLimit and in-memory Map) -----
CREATE TABLE rate_limits(
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_ends INTEGER NOT NULL);
