-- RC-4 phase 3.
-- 1. Cron mail delivery claims a row before sending (a lease), so overlapping cron runs or
--    a retry after a crash never send the same email twice (Resend also gets an
--    Idempotency-Key). email_outbox already has next_attempt_at, used as its lease.
ALTER TABLE auth_mail_jobs ADD COLUMN claimed_until INTEGER NOT NULL DEFAULT 0;
CREATE INDEX email_outbox_due ON email_outbox(status, next_attempt_at);
-- 2. Retry-safe creates (CR 5940418854 finding 2): a client key per create request, like
--    bookings.checkout_token. NULL for rows created before RC-4.
ALTER TABLE pts ADD COLUMN create_key TEXT;
CREATE UNIQUE INDEX pts_create_key ON pts(create_key) WHERE create_key IS NOT NULL;
ALTER TABLE blocks ADD COLUMN create_key TEXT;
CREATE UNIQUE INDEX blocks_create_key ON blocks(create_key) WHERE create_key IS NOT NULL;
