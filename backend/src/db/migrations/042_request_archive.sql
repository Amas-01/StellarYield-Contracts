CREATE TABLE IF NOT EXISTS request_archive (
  id            BIGSERIAL PRIMARY KEY,
  request_id    TEXT NOT NULL,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  status        INT NOT NULL,
  request_body  JSONB NOT NULL,
  response_body JSONB NOT NULL,
  duration_ms   DOUBLE PRECISION NOT NULL,
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_archive_timestamp
  ON request_archive (timestamp DESC, id DESC);