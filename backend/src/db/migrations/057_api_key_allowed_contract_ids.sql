-- Restrict an API key to a set of vault contract IDs (#1243).
-- NULL (the default, and the value for every existing key) means the key may
-- access every vault, so this is backwards compatible. An empty array means the
-- key may access no vaults.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_contract_ids TEXT[];
