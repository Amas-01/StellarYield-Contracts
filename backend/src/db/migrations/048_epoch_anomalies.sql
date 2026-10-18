-- #1073: epoch_anomalies records epochs whose total yield sits more than 3
-- standard deviations away from the rolling mean of the previous 30 epochs.
--
-- Only finalized epochs (closed_at IS NOT NULL) are scored, so an anomaly is
-- never raised against a yield that can still change as claims come in.
--
-- The z-score and the statistics that produced it are stored alongside the
-- epoch so a reviewer can see *why* the epoch was flagged without re-running
-- the query, and so the verdict is auditable after the fact.
CREATE TABLE IF NOT EXISTS epoch_anomalies (
  id            SERIAL PRIMARY KEY,
  vault_id      INT NOT NULL REFERENCES vaults(id),
  epoch         INT NOT NULL,
  -- Gross yield distributed for the epoch, and the rolling window it was
  -- compared against. NUMERIC throughout: an i128-adjacent amount must not be
  -- squeezed through a double.
  yield_amount  NUMERIC NOT NULL,
  mean_yield    NUMERIC NOT NULL,
  stddev_yield  NUMERIC NOT NULL,
  -- How many prior epochs the statistics were computed from. Kept so a flag
  -- raised on a thin sample can be discounted.
  sample_size   INT NOT NULL,
  -- Signed distance from the mean in standard deviations. NULL when
  -- stddev_yield is 0, where the ratio is undefined (any deviation from a
  -- perfectly flat window is an infinite number of sigma, and storing a huge
  -- sentinel would misrepresent that as a measured value).
  z_score       NUMERIC,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One record per epoch. The daily job re-scores on every run, so uniqueness
  -- is what makes re-runs and retries idempotent instead of duplicating rows.
  UNIQUE (vault_id, epoch)
);

-- Serves the admin listing, which reads newest epoch first for one vault.
CREATE INDEX IF NOT EXISTS idx_epoch_anomalies_vault_epoch
  ON epoch_anomalies(vault_id, epoch DESC);
