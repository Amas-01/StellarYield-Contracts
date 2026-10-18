-- Issue #1064: structured details on admin audit entries (e.g. the block and tx
-- hash a vault creation was indexed from).
ALTER TABLE admin_audit_log
  ADD COLUMN IF NOT EXISTS details JSONB;

-- A vault is created once, so a ledger re-scan must not duplicate its audit
-- entry. The partial unique index is what makes the insert idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_audit_log_vault_indexed
  ON admin_audit_log (target) WHERE action = 'VAULT_INDEXED';

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
  ON admin_audit_log (created_at DESC);
