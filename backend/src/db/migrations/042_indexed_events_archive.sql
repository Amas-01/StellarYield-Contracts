-- Issue #918: archival table for old indexed_events.
-- Identical schema to indexed_events so rows can be moved without
-- transformation. Events older than the retention window are moved here
-- by the pruning job instead of being permanently deleted.

CREATE TABLE IF NOT EXISTS indexed_events_archive (
  id          INT PRIMARY KEY,
  ledger      INT NOT NULL,
  tx_hash     TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  payload     JSONB NOT NULL,
  parsed_data JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_indexed_events_archive_contract_event
  ON indexed_events_archive (contract_id, event_type);

CREATE INDEX IF NOT EXISTS idx_indexed_events_archive_created_at
  ON indexed_events_archive (created_at);
