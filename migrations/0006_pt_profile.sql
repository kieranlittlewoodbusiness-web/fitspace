-- PT-editable contact and venue fields for the public site, legal pages and Reply-To.
-- Nullable only: existing pts rows and branding columns are left unchanged.
-- display_name is pts.brand_name; bio is pts.about (no duplicate columns).
ALTER TABLE pts ADD COLUMN business_name TEXT;
ALTER TABLE pts ADD COLUMN contact_email TEXT;
ALTER TABLE pts ADD COLUMN contact_phone TEXT;
ALTER TABLE pts ADD COLUMN reply_to_email TEXT;
ALTER TABLE pts ADD COLUMN reply_to_name TEXT;
ALTER TABLE pts ADD COLUMN venue_name TEXT;
ALTER TABLE pts ADD COLUMN venue_address TEXT;
ALTER TABLE pts ADD COLUMN cancellation_window_hours INTEGER
  CHECK(cancellation_window_hours IS NULL OR (cancellation_window_hours BETWEEN 0 AND 720));
ALTER TABLE pts ADD COLUMN photo_url TEXT;
