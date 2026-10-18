-- #1074: the transfer-volume endpoint aggregates the `transfers` table for one
-- vault over a trailing window, filtered on created_at and ordered by recency.
--
-- The existing single-column indexes (from #1113) cannot serve that: a filter on
-- vault_id alone still has to read every row for that vault and discard the ones
-- outside the window. A composite index on (vault_id, created_at DESC) lets the
-- planner seek straight to the window's lower bound and read only the rows that
-- fall inside it, which is what keeps the endpoint cheap as the table grows.
--
-- DESC matches the newest-first access pattern; a btree can still be scanned
-- backwards, so the direction costs nothing either way.
CREATE INDEX IF NOT EXISTS idx_transfers_vault_created_at
  ON transfers(vault_id, created_at DESC);
