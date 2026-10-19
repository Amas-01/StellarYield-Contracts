-- Issue #1275: redeemed percentage for matured vaults
-- supply_at_maturity freezes total_supply at the moment a vault enters the
-- Matured state, giving redeemedPct a fixed baseline to divide against as
-- shares are redeemed afterwards. NULL means the vault has not yet matured
-- (or matured before this column existed).
ALTER TABLE vaults
  ADD COLUMN IF NOT EXISTS supply_at_maturity NUMERIC;

-- Backfill vaults already in Matured/Closed state with their current
-- total_supply as a best-effort baseline, so redeemedPct is available
-- immediately rather than only for vaults that mature after this migration.
UPDATE vaults
SET supply_at_maturity = total_supply
WHERE state IN ('Matured', 'Closed') AND supply_at_maturity IS NULL;
