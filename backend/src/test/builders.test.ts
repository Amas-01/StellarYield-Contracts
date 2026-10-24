// Builders for user / position / epoch test rows (#1297).
import { describe, it, expect } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  buildUser,
  buildPosition,
  buildEpoch,
  randomStellarAddress,
  randomStellarContractId,
} from "../../tests/builders/index.js";

describe("test data builders", () => {
  it("generates valid Stellar account addresses by default", () => {
    for (let i = 0; i < 25; i += 1) {
      expect(StrKey.isValidEd25519PublicKey(randomStellarAddress())).toBe(true);
      expect(StrKey.isValidEd25519PublicKey(buildUser().address)).toBe(true);
      expect(StrKey.isValidEd25519PublicKey(buildPosition().user_address)).toBe(true);
    }
  });

  it("generates valid stellar contract ids", () => {
    for (let i = 0; i < 5; i += 1) {
      const id = randomStellarContractId();
      expect(id).toMatch(/^C[A-Z0-9]{55}$/);
      // Round-trip: the contract id must decode through the SDK's StrKey.
      expect(() => StrKey.decodeContract(id)).not.toThrow();
    }
  });

  it("honors overrides on top of sensible defaults", () => {
    const overrides = {
      id: 7,
      address: Keypair.random().publicKey(),
      kyc_verified: false,
    };
    const user = buildUser(overrides);
    expect(user).toEqual({
      id: 7,
      address: overrides.address,
      kyc_verified: false,
      created_at: expect.any(Date),
      updated_at: expect.any(Date),
    });

    const position = buildPosition({ deposited: "9000", state: "Funding" });
    expect(position.deposited).toBe("9000");
    expect(position.state).toBe("Funding");
    expect(position.user_address).toMatch(/^G/);

    const epoch = buildEpoch({ epoch: 4, yield_amount: "400" });
    expect(epoch.id).toBe(4);
    expect(epoch.vault_id).toBe(1);
    expect(epoch.yield_amount).toBe("400");
    expect(epoch.net_yield).toBeNull();
  });
});
