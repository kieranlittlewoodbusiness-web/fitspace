-- RC-30 block instalment payments (MVP). PREVIEW/LOCAL ONLY until Kieran OKs production.
-- Additive: every existing block stays upfront-only (upfront_enabled defaults to 1 and it has
-- no block_payment_plans rows); every existing booking is an 'upfront' booking whose
-- total_pence equals its amount_pence. No existing row changes meaning.

-- Per-block instalment options. One row per plan; a block without rows offers upfront only.
CREATE TABLE block_payment_plans(
  block_id TEXT NOT NULL REFERENCES blocks(id),
  plan TEXT NOT NULL CHECK(plan IN ('weekly','monthly')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  amount_pence INTEGER NOT NULL CHECK(amount_pence BETWEEN 30 AND 1000000),
  count INTEGER NOT NULL CHECK(count BETWEEN 2 AND 52 AND (plan<>'monthly' OR count<=12)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(block_id,plan));

ALTER TABLE blocks ADD COLUMN upfront_enabled INTEGER NOT NULL DEFAULT 1 CHECK(upfront_enabled IN (0,1));

-- Per-booking price snapshot (written once at reserve time; block edits never change it).
-- Reuses 0002's list_price_pence / discount_pence / discount_code_id (RC-8 hook).
-- amount_pence stays "what this checkout charges today" (payment 1 for a plan).
ALTER TABLE bookings ADD COLUMN plan TEXT NOT NULL DEFAULT 'upfront' CHECK(plan IN ('upfront','weekly','monthly'));
ALTER TABLE bookings ADD COLUMN plan_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bookings ADD COLUMN total_pence INTEGER;
ALTER TABLE bookings ADD COLUMN plan_status TEXT CHECK(plan_status IS NULL OR plan_status IN ('active','past_due','completed','stopped'));
ALTER TABLE bookings ADD COLUMN plan_anchor INTEGER;          -- unix seconds: start of payment 1's billing period (Stripe)
ALTER TABLE bookings ADD COLUMN stripe_customer_id TEXT;      -- cus_ on the PT's connected account
ALTER TABLE bookings ADD COLUMN stripe_subscription_id TEXT;  -- sub_ on the PT's connected account
ALTER TABLE bookings ADD COLUMN stripe_schedule_id TEXT;      -- sub_sched_ that ends billing after the last payment
UPDATE bookings SET total_pence=amount_pence WHERE total_pence IS NULL;
CREATE UNIQUE INDEX bookings_subscription ON bookings(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- One row per scheduled payment of a plan booking (all rows are written with the booking).
CREATE TABLE booking_instalments(
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  seq INTEGER NOT NULL CHECK(seq>=1),
  amount_pence INTEGER NOT NULL CHECK(amount_pence>=0),
  due_at INTEGER NOT NULL,                 -- epoch ms (projected; corrected from the Stripe invoice period)
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK(status IN ('upcoming','paid','failed','void')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,                   -- epoch ms; NULL on a failed row = Stripe stopped retrying
  paid_at INTEGER,
  failure TEXT,
  stripe_invoice_id TEXT,
  stripe_payment_intent TEXT,
  event_time INTEGER NOT NULL DEFAULT 0,   -- Stripe event.created of the last applied event (out-of-order guard)
  created_at INTEGER NOT NULL,
  UNIQUE(booking_id,seq));
CREATE UNIQUE INDEX booking_instalments_invoice ON booking_instalments(stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;
CREATE INDEX booking_instalments_status ON booking_instalments(status,due_at);
