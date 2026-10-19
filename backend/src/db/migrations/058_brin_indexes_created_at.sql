-- BRIN indexes on append-only, time-ordered tables.
-- BRIN is far smaller than B-tree for monotonically increasing columns and
-- makes range scans (e.g. "all events in the last hour") significantly cheaper.

CREATE INDEX IF NOT EXISTS idx_indexed_events_created_at_brin
    ON indexed_events USING brin (created_at);

CREATE INDEX IF NOT EXISTS idx_share_balance_snapshots_created_at_brin
    ON share_balance_snapshots USING brin (created_at);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at_brin
    ON webhook_deliveries USING brin (created_at);
