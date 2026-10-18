-- #1094: record on-chain vault whitelist changes for audit.
-- Each `whitelist_updated` event the indexer sees becomes one row, exposed via
-- GET /api/v1/vaults/:contractId/whitelist-history.

CREATE TABLE IF NOT EXISTS whitelist_events (
  id          SERIAL PRIMARY KEY,
  contract_id TEXT NOT NULL,
  address     TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('added', 'removed')),
  tx_hash     TEXT NOT NULL,
  ledger      INT  NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The indexer re-reads a ledger range when it is asked to backfill, so the
-- natural key of an event has to be idempotent for the insert to be replay-safe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whitelist_events_unique
  ON whitelist_events (contract_id, tx_hash, ledger, address, action);

-- Serves the history endpoint, which always reads one contract newest-first.
CREATE INDEX IF NOT EXISTS idx_whitelist_events_contract_created_at
  ON whitelist_events (contract_id, created_at DESC);
