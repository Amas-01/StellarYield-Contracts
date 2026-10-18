-- Issue #1103: fee rebate tracking table.
-- Operators may rebate part of the fee to large depositors. Recording rebates
-- separately keeps net-fee reporting accurate.

CREATE TABLE IF NOT EXISTS fee_rebates (
  id              SERIAL PRIMARY KEY,
  contract_id     TEXT NOT NULL REFERENCES vaults(contract_id) ON DELETE CASCADE,
  address         TEXT NOT NULL,
  rebate_amount   NUMERIC NOT NULL CHECK (rebate_amount > 0),
  reason          TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  tx_hash         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fee_rebates_contract_created_at
  ON fee_rebates(contract_id, created_at DESC);
