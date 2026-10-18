-- Issues #1076, #1077, #1078: transfer alerts and transfer fees tables

CREATE TABLE IF NOT EXISTS transfer_alerts (
  id              SERIAL PRIMARY KEY,
  vault_id        INT REFERENCES vaults(id),
  contract_id     TEXT,
  type            TEXT NOT NULL,
  amount          NUMERIC,
  from_address    TEXT,
  to_address      TEXT,
  tx_hash         TEXT,
  details         JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_transfer_alerts_vault_id ON transfer_alerts(vault_id);
CREATE INDEX IF NOT EXISTS idx_transfer_alerts_contract_id ON transfer_alerts(contract_id);
CREATE INDEX IF NOT EXISTS idx_transfer_alerts_type ON transfer_alerts(type);
CREATE INDEX IF NOT EXISTS idx_transfer_alerts_acknowledged_at ON transfer_alerts(acknowledged_at);
CREATE INDEX IF NOT EXISTS idx_transfer_alerts_created_at ON transfer_alerts(created_at);

DROP VIEW IF EXISTS transfer_fees CASCADE;

CREATE TABLE IF NOT EXISTS transfer_fees (
  id              SERIAL PRIMARY KEY,
  contract_id     TEXT NOT NULL,
  from_address    TEXT NOT NULL,
  to_address      TEXT NOT NULL,
  fee_amount      NUMERIC NOT NULL,
  tx_hash         TEXT,
  ledger          INT,
  fee_type        TEXT DEFAULT 'transfer_fee',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  collected_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfer_fees_contract_id ON transfer_fees(contract_id);
CREATE INDEX IF NOT EXISTS idx_transfer_fees_created_at ON transfer_fees(created_at);
CREATE INDEX IF NOT EXISTS idx_transfer_fees_collected_at ON transfer_fees(collected_at);
