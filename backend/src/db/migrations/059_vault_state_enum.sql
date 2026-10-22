-- Issue #1225: Replace free-text vaults.state column with a Postgres enum so
-- invalid values (e.g. typos like "actve") are rejected at the database level.

-- Create the enum type if it doesn't already exist.
DO $$ BEGIN
  CREATE TYPE vault_state AS ENUM (
    'Funding',
    'Active',
    'Matured',
    'Closed',
    'Cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Migrate the column: cast existing text values to the new enum.
ALTER TABLE vaults
  ALTER COLUMN state DROP DEFAULT;

ALTER TABLE vaults
  ALTER COLUMN state TYPE vault_state
  USING state::vault_state;

ALTER TABLE vaults
  ALTER COLUMN state SET DEFAULT 'Funding'::vault_state;
