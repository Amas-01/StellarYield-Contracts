-- Add COMMENT ON descriptions for the core tables and their key columns so
-- that pg_catalog and tools like pgAdmin, DBeaver, and pg_dump show intent
-- inline with the schema, reducing the need to cross-reference external docs.
-- (#1228)

COMMENT ON TABLE vaults IS
  'On-chain Soroban vaults tracked by the indexer. One row per unique contract_id.';
COMMENT ON COLUMN vaults.contract_id IS 'Soroban contract address (C-prefixed strkey).';
COMMENT ON COLUMN vaults.state IS 'Lifecycle state: Funding | Active | Matured | Settled | Paused.';
COMMENT ON COLUMN vaults.total_assets IS 'Current total deposited assets (in asset base units).';
COMMENT ON COLUMN vaults.total_supply IS 'Current total share supply.';
COMMENT ON COLUMN vaults.operator_fee_bps IS 'Annual operator fee in basis points (1 bps = 0.01 %).';
COMMENT ON COLUMN vaults.expected_apy IS 'Expected annual percentage yield, in basis points.';
COMMENT ON COLUMN vaults.maturity_date IS 'Date after which the vault can move to Matured state.';

COMMENT ON TABLE users IS
  'Stellar accounts that have interacted with at least one vault.';
COMMENT ON COLUMN users.address IS 'Stellar account address (G-prefixed strkey).';
COMMENT ON COLUMN users.kyc_verified IS 'Whether the account has passed KYC for any vault.';

COMMENT ON TABLE user_vault_positions IS
  'Per-user, per-vault share balances and accumulated deposit amounts.';
COMMENT ON COLUMN user_vault_positions.shares IS 'Current share balance (in share base units).';
COMMENT ON COLUMN user_vault_positions.deposited IS 'Cumulative amount deposited (in asset base units).';
COMMENT ON COLUMN user_vault_positions.last_claimed_epoch IS 'Epoch number of the most recent yield claim.';

COMMENT ON TABLE indexed_events IS
  'Raw Soroban contract events processed by the indexer. Payload is stored as JSONB.';
COMMENT ON COLUMN indexed_events.event_type IS 'Normalised event name, e.g. deposit, withdraw, yield_claimed.';
COMMENT ON COLUMN indexed_events.ledger IS 'Stellar ledger sequence number at which the event was emitted.';
COMMENT ON COLUMN indexed_events.tx_hash IS 'Transaction hash (hex) containing the event.';
COMMENT ON COLUMN indexed_events.payload IS 'Full event payload as JSONB.';
