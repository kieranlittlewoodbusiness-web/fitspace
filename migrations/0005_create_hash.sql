-- RC-4, CR 5940914487 minor 1: a create_key reused with a DIFFERENT payload is refused with
-- 409 CREATE_KEY_REUSED instead of silently replaying the first record. sha256 of the
-- normalised create payload. NULL for rows created before this migration (no check).
ALTER TABLE pts ADD COLUMN create_hash TEXT;
ALTER TABLE blocks ADD COLUMN create_hash TEXT;
