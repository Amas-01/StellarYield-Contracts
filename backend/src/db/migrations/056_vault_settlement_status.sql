-- Issue #1274: Post-maturity settlement status
-- settlement_status is derived by the indexer from post-maturity withdrawals
-- and the remaining total_supply:
--   not_started  vault has matured but no redemptions have occurred
--   in_progress  at least one redemption has occurred, supply still > 0
--   complete     total_supply = 0 (all shares redeemed)
-- NULL means the vault has not yet reached Matured state.
ALTER TABLE vaults
  ADD COLUMN IF NOT EXISTS settlement_status TEXT
    CHECK (settlement_status IN ('not_started', 'in_progress', 'complete'));

-- Backfill existing matured vaults with a best-effort status based on supply.
UPDATE vaults
SET settlement_status = CASE
  WHEN state = 'Matured' AND (total_supply = 0 OR state = 'Closed') THEN 'complete'
  WHEN state IN ('Matured', 'Closed') AND total_supply > 0 THEN 'in_progress'
  ELSE NULL
END
WHERE state IN ('Matured', 'Closed');
