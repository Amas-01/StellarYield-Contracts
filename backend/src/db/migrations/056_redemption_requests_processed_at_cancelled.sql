-- Add processed_at timestamp and cancelled flag to redemption_requests.
-- processed_at: when the request was fulfilled (null = not yet processed).
-- cancelled: true when the user withdrew the request before processing.
-- Required by #1271 (processing-latency stats) and #1272 (cancellation-rate metric).

ALTER TABLE redemption_requests
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled     BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_redemption_requests_processed_at
  ON redemption_requests(vault_id, processed_at)
  WHERE processed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_redemption_requests_cancelled
  ON redemption_requests(vault_id, cancelled);
