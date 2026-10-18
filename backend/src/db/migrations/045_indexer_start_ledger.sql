-- Issue #1105: runtime-configurable indexer start block.
--
-- `last_ledger` is the indexing cursor (the resume point). `start_ledger` is the
-- block a fresh indexing run begins from, readable and writable through
-- GET/PUT /api/v1/admin/indexer/start-block. Keeping the two apart means moving
-- the start block never rewinds progress. NULL means "not configured", in which
-- case the indexer falls back to the INDEXER_START_LEDGER env var.

ALTER TABLE indexer_state
  ADD COLUMN IF NOT EXISTS start_ledger INT;
