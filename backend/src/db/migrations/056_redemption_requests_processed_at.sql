-- Issue #1269: Add processed_at column to redemption_requests so the
-- redemption-queue ETA endpoint can compute historical throughput.
-- Rows already marked processed = TRUE get their created_at as a best-effort
-- back-fill (we know they were processed at some point, but the exact time
-- was not recorded before this migration).

ALTER TABLE redemption_requests
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

-- Back-fill: use created_at as a lower-bound approximation for rows that
-- were already processed before this column was added.
UPDATE redemption_requests
  SET processed_at = created_at
WHERE processed = TRUE AND processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_redemption_requests_processed_at
  ON redemption_requests (vault_id, processed_at)
  WHERE processed = TRUE;
