CREATE TABLE IF NOT EXISTS vault_admin_notes (
  id          SERIAL PRIMARY KEY,
  contract_id TEXT NOT NULL,
  author      TEXT NOT NULL,
  note        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vault_admin_notes_contract_id_created_at
  ON vault_admin_notes (contract_id, created_at DESC);
