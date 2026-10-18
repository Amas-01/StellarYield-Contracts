-- Issues #1083 / #1086: per-user vault entry and exit tracking.
-- The indexer stores raw on-chain events, which cannot be queried by user, so the
-- entry/exit timestamps are kept on the position row itself:
--   first_entry_at  set by the first deposit into the vault
--   last_exit_at    set when a withdrawal takes the position to zero shares and
--                   cleared again by a later deposit (NULL while the user holds shares)

ALTER TABLE user_vault_positions
  ADD COLUMN IF NOT EXISTS first_entry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_exit_at   TIMESTAMPTZ;

-- Backfill rows that existed before this migration with the best evidence left.
-- first_entry_at: the earliest epoch balance snapshot, else the last update time
-- (a lower bound on how early the user entered). last_exit_at: fully exited
-- positions were last touched by their exit. New activity is exact.
UPDATE user_vault_positions uvp
SET first_entry_at = COALESCE(
      (SELECT MIN(s.recorded_at)
         FROM share_balance_snapshots s
        WHERE s.user_address = uvp.user_address AND s.vault_id = uvp.vault_id),
      uvp.updated_at
    ),
    last_exit_at = CASE WHEN uvp.shares = 0 THEN uvp.updated_at ELSE NULL END
WHERE uvp.first_entry_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_vault_positions_updated_at
  ON user_vault_positions (updated_at);
