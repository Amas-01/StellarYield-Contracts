-- Issue #1113: transfers table for transfer tracking and sanctions screening
CREATE TABLE IF NOT EXISTS transfers (
  id              SERIAL PRIMARY KEY,
  vault_id        INT REFERENCES vaults(id),
  from_address    TEXT NOT NULL,
  to_address      TEXT NOT NULL,
  amount          NUMERIC NOT NULL,
  tx_hash         TEXT,
  ledger          INT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfers_from_address ON transfers(from_address);
CREATE INDEX IF NOT EXISTS idx_transfers_to_address ON transfers(to_address);
CREATE INDEX IF NOT EXISTS idx_transfers_vault_id ON transfers(vault_id);
