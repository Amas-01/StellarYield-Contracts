// Test data builders (#1297).
//
// Existing tests repeat long user object literals, so the defaults here mirror
// the `users` table rows produced by application code (snake_case columns).
// Every builder returns a plain object that can be passed straight into a
// mocked `db.query` result, and accepts partial overrides for the columns a
// test actually cares about.
import { Keypair } from "@stellar/stellar-sdk";

/**
 * Generate a random, always-valid Stellar account address (`G...` 56 chars).
 * Use the `address` / `user_address` overrides to pin a deterministic value.
 */
export function randomStellarAddress(): string {
  return Keypair.random().publicKey();
}

/** Row shape returned by `SELECT id, address, kyc_verified, ...` from `users`. */
export interface UserRow {
  id: number;
  address: string;
  kyc_verified: boolean;
  created_at: Date;
  updated_at: Date;
}

export function buildUser(overrides: Partial<UserRow> = {}): UserRow {
  const address = overrides.address ?? randomStellarAddress();
  return {
    id: overrides.id ?? 1,
    address,
    kyc_verified: overrides.kyc_verified ?? true,
    created_at: overrides.created_at ?? new Date("2024-01-01T00:00:00.000Z"),
    updated_at: overrides.updated_at ?? new Date("2024-01-01T00:00:00.000Z"),
  };
}
