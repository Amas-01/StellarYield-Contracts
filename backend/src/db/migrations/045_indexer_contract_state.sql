-- Issues #1106 / #1107: per-contract indexer controls.
-- One row per contract an operator has configured; contracts without a row are
-- indexed normally.
--   indexing_paused      skip the contract in every polling cycle (#1107)
--   paused_at_ledger     global indexer ledger when the contract was paused.
--                        On resume the indexer replays the contract's events
--                        from here up to the global cursor, then clears it.
--   allowed_event_types  event types to store; an empty array means all (#1106)

CREATE TABLE IF NOT EXISTS indexer_contract_state (
  contract_id          TEXT PRIMARY KEY,
  indexing_paused      BOOLEAN NOT NULL DEFAULT FALSE,
  paused_at_ledger     INT,
  allowed_event_types  TEXT[] NOT NULL DEFAULT '{}',
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
