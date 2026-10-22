-- Issue #1222: Add unique constraint on event position to prevent duplicate
-- inserts by concurrent indexer writers.
--
-- Step 1: add the position columns if they don't already exist.
ALTER TABLE indexed_events
  ADD COLUMN IF NOT EXISTS tx_index    INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS event_index INT NOT NULL DEFAULT 0;

-- Step 2: remove any pre-existing duplicates, keeping the row with the
-- lowest id for each (contract_id, ledger, tx_index, event_index) tuple.
DELETE FROM indexed_events
WHERE id NOT IN (
  SELECT MIN(id)
  FROM   indexed_events
  GROUP  BY contract_id, ledger, tx_index, event_index
);

-- Step 3: add the unique constraint.
ALTER TABLE indexed_events
  ADD CONSTRAINT uq_indexed_events_position
  UNIQUE (contract_id, ledger, tx_index, event_index);
