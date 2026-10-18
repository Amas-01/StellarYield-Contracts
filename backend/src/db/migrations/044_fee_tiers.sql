-- Issue #1099: dynamic fee tier table.
-- Tier-based operator fee configuration per vault, managed through the admin
-- API without redeploying the contract. A tier covers the half-open balance
-- range [min_balance, max_balance); a NULL max_balance means "no upper bound".
-- Overlaps between tiers of one vault are rejected by the API (HTTP 422).

CREATE TABLE IF NOT EXISTS fee_tiers (
  id            SERIAL PRIMARY KEY,
  contract_id   TEXT NOT NULL REFERENCES vaults(contract_id) ON DELETE CASCADE,
  min_balance   NUMERIC NOT NULL CHECK (min_balance >= 0),
  max_balance   NUMERIC,
  fee_bps       INT NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (max_balance IS NULL OR max_balance > min_balance)
);

CREATE INDEX IF NOT EXISTS idx_fee_tiers_contract_min_balance
  ON fee_tiers(contract_id, min_balance);
