-- Issue #1061: per-endpoint webhook circuit breaker.
-- After CIRCUIT_BREAKER_THRESHOLD consecutive permanent failures the endpoint
-- is suspended (`circuit_open`) until an operator resets it via
-- POST /api/v1/admin/webhooks/:id/circuit-reset.
ALTER TABLE webhooks
  ADD COLUMN IF NOT EXISTS circuit_open BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE webhooks
  ADD COLUMN IF NOT EXISTS circuit_opened_at TIMESTAMPTZ;

-- Issue #1061: delivery outcomes. `failed_permanent` marks a delivery the
-- system has given up on (SSRF-rejected, or circuit opened on the endpoint).
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';

UPDATE webhook_deliveries
   SET status = CASE WHEN delivered_at IS NOT NULL THEN 'delivered' ELSE 'failed' END
 WHERE status = 'pending' AND delivered_at IS NOT NULL;

-- Fan-out and retry scans both filter out suspended endpoints.
CREATE INDEX IF NOT EXISTS idx_webhooks_open_delivery
  ON webhooks (priority, created_at DESC) WHERE active = TRUE AND circuit_open = FALSE;

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status
  ON webhook_deliveries (webhook_id, status);
