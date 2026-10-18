-- Track factory vault-WASM hash updates so operators can verify the running
-- contract version without an RPC call (#837, #835)

CREATE TABLE IF NOT EXISTS factory_wasm_history (
  id           SERIAL PRIMARY KEY,
  old_hash     TEXT NOT NULL,
  new_hash     TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  ledger       INT NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_factory_wasm_history_recorded_at ON factory_wasm_history (recorded_at DESC);
