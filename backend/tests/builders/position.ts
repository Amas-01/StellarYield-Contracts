// Test data builders (#1297).
//
// Mirrors the row shape `UserService.getUserPortfolio` / `getPortfoliosBatch`
// consume: `user_vault_positions` joined with `vaults` for the contract id and
// current state.
import { Keypair, StrKey } from "@stellar/stellar-sdk";

/** Row shape returned by the portfolio queries (`user_vault_positions` ⋈ `vaults`). */
export interface PositionRow {
  id: number;
  user_address: string;
  vault_id: number;
  contract_id: string;
  state: string;
  shares: string;
  deposited: string;
  last_claimed_epoch: number;
  updated_at: Date;
}

/** Default 56-char contract id (`C...`) used when a test doesn't care. */
export const DEFAULT_CONTRACT_ID =
  "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3BMNOP";

/** Distinct, valid contract ids (`C...`) for tests that need unique rows. */
export function randomStellarContractId(): string {
  return StrKey.encodeContract(Keypair.random().rawPublicKey());
}

export function buildPosition(overrides: Partial<PositionRow> = {}): PositionRow {
  return {
    id: overrides.id ?? 1,
    user_address: overrides.user_address ?? randomStellarAddress(),
    vault_id: overrides.vault_id ?? 1,
    contract_id: overrides.contract_id ?? DEFAULT_CONTRACT_ID,
    state: overrides.state ?? "Active",
    shares: overrides.shares ?? "1000",
    deposited: overrides.deposited ?? "5000",
    last_claimed_epoch: overrides.last_claimed_epoch ?? 0,
    updated_at: overrides.updated_at ?? new Date("2024-01-01T00:00:00.000Z"),
  };
}
