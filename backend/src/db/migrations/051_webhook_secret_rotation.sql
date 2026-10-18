-- Issue #1062: zero-downtime webhook secret rotation.
-- On rotation the current secret is demoted to `previous_secret` and stays
-- valid alongside the new one for SECRET_ROTATION_WINDOW_HOURS (default 24),
-- after which it is purged.
ALTER TABLE webhooks
  ADD COLUMN IF NOT EXISTS previous_secret TEXT;

ALTER TABLE webhooks
  ADD COLUMN IF NOT EXISTS secret_rotated_at TIMESTAMPTZ;

-- Issue #1063: replay a past delivery from the log. A replayed delivery is a
-- new row pointing back at the delivery it was cloned from.
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS replayed_from INT REFERENCES webhook_deliveries(id);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_replayed_from
  ON webhook_deliveries (replayed_from) WHERE replayed_from IS NOT NULL;
