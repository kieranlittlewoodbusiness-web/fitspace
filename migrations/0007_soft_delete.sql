-- Soft-delete markers for admin PT removal (RC-31).
-- Existing rows stay live (deleted_at NULL). Bookings, payments and webhook rows are unchanged.
ALTER TABLE users ADD COLUMN deleted_at INTEGER;
ALTER TABLE pts ADD COLUMN deleted_at INTEGER;
