-- #1065 / #1068: audit trail of vault status and manager changes.
--
-- `vaults.status` mirrors the factory's active/inactive flag (`v_status`
-- event) and `vaults.manager_address` the vault's current manager
-- (`vault_manager_changed` event). Every transition the indexer sees becomes
-- one vault_status_history row, exposed via
-- GET /api/v1/vaults/:contractId/status-history.

ALTER TABLE vaults
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS manager_address TEXT;

CREATE TABLE IF NOT EXISTS vault_status_history (
  id               SERIAL PRIMARY KEY,
  contract_id      TEXT NOT NULL,
  event_type       TEXT NOT NULL DEFAULT 'status_changed'
                   CHECK (event_type IN ('status_changed', 'manager_changed')),
  previous_status  TEXT,
  new_status       TEXT,
  previous_manager TEXT,
  new_manager      TEXT,
  changed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tx_hash          TEXT NOT NULL,
  ledger           INT  NOT NULL
);

-- A backfill re-reads ledger ranges that were already indexed, so the insert
-- must be replay-safe: one row per on-chain transition.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_status_history_unique
  ON vault_status_history (contract_id, event_type, tx_hash, ledger);

-- Serves the history endpoint, which always reads one contract newest-first.
CREATE INDEX IF NOT EXISTS idx_vault_status_history_contract_changed_at
  ON vault_status_history (contract_id, changed_at DESC);
