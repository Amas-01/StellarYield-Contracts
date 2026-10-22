-- Issue #1221: Narrow amount columns to NUMERIC(39,0) so values up to 10^30
-- (the full i128 range) round-trip exactly and the type documents intent.
-- Unbounded NUMERIC accepts any precision; NUMERIC(39,0) is an explicit
-- integer-only contract column that still fits all i128 values.

-- vaults
ALTER TABLE vaults
  ALTER COLUMN total_assets TYPE NUMERIC(39,0) USING total_assets::NUMERIC(39,0),
  ALTER COLUMN total_supply  TYPE NUMERIC(39,0) USING total_supply::NUMERIC(39,0);

-- user_vault_positions
ALTER TABLE user_vault_positions
  ALTER COLUMN shares    TYPE NUMERIC(39,0) USING shares::NUMERIC(39,0),
  ALTER COLUMN deposited TYPE NUMERIC(39,0) USING deposited::NUMERIC(39,0);

-- epochs
ALTER TABLE epochs
  ALTER COLUMN yield_amount TYPE NUMERIC(39,0) USING yield_amount::NUMERIC(39,0),
  ALTER COLUMN total_shares TYPE NUMERIC(39,0) USING total_shares::NUMERIC(39,0);
