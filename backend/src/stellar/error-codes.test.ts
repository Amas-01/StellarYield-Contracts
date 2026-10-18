import { describe, it, expect } from "vitest";
import { translateErrorCode } from "./error-codes.js";

/**
 * Locks the translation table to the `#[contracterror]` enum in
 * `soroban-contracts/contracts/single_rwa_vault/src/errors.rs` (#870). A new
 * variant added on the Rust side must be mirrored here, and a code that was
 * never assigned must not be invented.
 */
describe("translateErrorCode", () => {
  it("translates every code assigned by the Rust contract", () => {
    const assigned = [
      1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
      24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42,
      43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
    ];

    for (const code of assigned) {
      const translation = translateErrorCode(code);
      expect(translation.code).toBe(code);
      expect(translation.name).not.toBe("UnknownError");
      expect(translation.description.length).toBeGreaterThan(0);
      expect(translation.suggestedAction.length).toBeGreaterThan(0);
    }
  });

  it("uses the exact Rust variant names", () => {
    expect(translateErrorCode(1).name).toBe("NotKYCVerified");
    expect(translateErrorCode(6).name).toBe("BelowMinimumDeposit");
    expect(translateErrorCode(11).name).toBe("VaultPaused");
    expect(translateErrorCode(15).name).toBe("Reentrant");
    expect(translateErrorCode(31).name).toBe("MigrationRequired");
    expect(translateErrorCode(46).name).toBe("FundingTargetExceeded");
    expect(translateErrorCode(52).name).toBe("InsufficientShortfall");
  });

  it("falls back to UnknownError for codes the contract never assigns", () => {
    // 2 and 23 are gaps in the Rust enum, not renumbered away.
    for (const code of [2, 23, 53, 0, -1]) {
      const translation = translateErrorCode(code);
      expect(translation.code).toBe(code);
      expect(translation.name).toBe("UnknownError");
    }
  });
});
