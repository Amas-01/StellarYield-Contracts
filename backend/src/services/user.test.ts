import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { UserService } from "./user.js";
import * as db from "../db/index.js";
import { buildUser, buildPosition, randomStellarAddress } from "../../tests/builders/index.js";

// Mock the database module
vi.mock("../db/index.js");

// Mock the logger to avoid pino-pretty issues in tests
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock("./yield.js", () => ({
  YieldService: vi.fn(() => ({
    getUserPendingYield: vi.fn().mockResolvedValue({
      pendingYield: "0",
      epochs: [],
    }),
  })),
}));

const TEST_ADDRESS = randomStellarAddress();

describe("UserService", () => {
  let userService: UserService;

  beforeEach(() => {
    userService = new UserService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getUser", () => {
    it("should return a user with kycVerified status when user exists", async () => {
      const mockUser = buildUser({ address: TEST_ADDRESS, kyc_verified: true });

      vi.mocked(db.query).mockResolvedValueOnce([mockUser]);

      const result = await userService.getUser(TEST_ADDRESS);

      expect(result).toEqual({
        id: 1,
        address: TEST_ADDRESS,
        kycVerified: true,
        createdAt: mockUser.created_at,
        updatedAt: mockUser.updated_at,
      });
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT id, address, kyc_verified"),
        [TEST_ADDRESS],
      );
    });

    it("should return null when user does not exist", async () => {
      vi.mocked(db.query).mockResolvedValueOnce([]);

      const result = await userService.getUser(TEST_ADDRESS);

      expect(result).toBeNull();
    });
  });

  describe("upsertUser", () => {
    it("upserts and overwrites kycVerified on conflict", async () => {
      vi.mocked(db.query).mockResolvedValueOnce([]);

      await userService.upsertUser(TEST_ADDRESS, true);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("ON CONFLICT (address) DO UPDATE"),
        [TEST_ADDRESS, true],
      );
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("kyc_verified = EXCLUDED.kyc_verified"),
        [TEST_ADDRESS, true],
      );
    });
  });

  describe("getUserPortfolio", () => {
    it("should return portfolio with positions and totalDeposited sum", async () => {
      const mockPositions = [
        buildPosition({
          id: 1,
          user_address: TEST_ADDRESS,
          vault_id: 1,
          contract_id: "CCONTRACT11111111111111111111111111111111111111111111",
          state: "Active",
          shares: "1000",
          deposited: "5000",
          last_claimed_epoch: 0,
        }),
        buildPosition({
          id: 2,
          user_address: TEST_ADDRESS,
          vault_id: 2,
          contract_id: "CCONTRACT22222222222222222222222222222222222222222222",
          state: "Funding",
          shares: "2000",
          deposited: "3000",
          last_claimed_epoch: 1,
        }),
      ];

      vi.mocked(db.query).mockResolvedValueOnce(mockPositions);

      const result = await userService.getUserPortfolio(TEST_ADDRESS);

      expect(result.positions).toHaveLength(2);
      expect(result.positions[0]).toEqual({
        id: 1,
        userAddress: TEST_ADDRESS,
        vaultId: 1,
        contractId: "CCONTRACT11111111111111111111111111111111111111111111",
        state: "Active",
        shares: "1000",
        deposited: "5000",
        lastClaimedEpoch: 0,
        updatedAt: mockPositions[0].updated_at,
      });
      expect(result.positions[1]).toEqual({
        id: 2,
        userAddress: TEST_ADDRESS,
        vaultId: 2,
        contractId: "CCONTRACT22222222222222222222222222222222222222222222",
        state: "Funding",
        shares: "2000",
        deposited: "3000",
        lastClaimedEpoch: 1,
        updatedAt: mockPositions[1].updated_at,
      });
      expect(result.totalDeposited).toBe("8000");
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("JOIN vaults"),
        [TEST_ADDRESS],
      );
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY uvp.deposited DESC"),
        [TEST_ADDRESS],
      );
    });

    it("should return empty portfolio with zero totalDeposited when user has no positions", async () => {
      vi.mocked(db.query).mockResolvedValueOnce([]);

      const result = await userService.getUserPortfolio(TEST_ADDRESS);

      expect(result.positions).toHaveLength(0);
      expect(result.totalDeposited).toBe("0");
    });
  });

  describe("getPortfoliosBatch", () => {
    const ADDR_A = randomStellarAddress();
    const ADDR_B = randomStellarAddress();

    it("groups positions by address using a single ANY query", async () => {
      vi.mocked(db.query).mockResolvedValueOnce([
        buildPosition({
          user_address: ADDR_A,
          contract_id: "CCONTRACT11111111111111111111111111111111111111111111",
        }),
      ]);

      const result = await userService.getPortfoliosBatch([ADDR_A, ADDR_B]);

      expect(Object.keys(result)).toEqual([ADDR_A, ADDR_B]);
      expect(result[ADDR_A]).toHaveLength(1);
      expect(result[ADDR_A][0].contractId).toBe(
        "CCONTRACT11111111111111111111111111111111111111111111",
      );
      // Addresses with no positions return an empty array, not undefined.
      expect(result[ADDR_B]).toEqual([]);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("= ANY($1)"),
        [[ADDR_A, ADDR_B]],
      );
    });

    it("returns empty arrays for every address when there are no positions", async () => {
      vi.mocked(db.query).mockResolvedValueOnce([]);

      const result = await userService.getPortfoliosBatch([ADDR_A, ADDR_B]);

      expect(result).toEqual({ [ADDR_A]: [], [ADDR_B]: [] });
    });

    it("does not hit the database when no addresses are provided", async () => {
      const result = await userService.getPortfoliosBatch([]);

      expect(result).toEqual({});
      expect(db.query).not.toHaveBeenCalled();
    });
  });

  describe("getShareBalanceHistory", () => {
    it("returns a user's share snapshots for a specific vault ordered by epoch", async () => {
      const recordedAt = new Date("2025-01-01T00:00:00.000Z");
      vi.mocked(db.query).mockResolvedValueOnce([
        { epoch: 1, shares: "100", recorded_at: recordedAt },
        { epoch: 2, shares: "150", recorded_at: recordedAt },
      ]);

      const result = await userService.getShareBalanceHistory(
        TEST_ADDRESS,
        "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
      );

      expect(result).toEqual([
        { epoch: 1, shares: "100", recordedAt },
        { epoch: 2, shares: "150", recordedAt },
      ]);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("JOIN vaults v ON sbs.vault_id = v.id"),
        [TEST_ADDRESS, "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B"],
      );
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("ORDER BY sbs.epoch ASC"),
        [TEST_ADDRESS, "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B"],
      );
    });

    it("aggregates share snapshots across all vaults when vaultId is omitted", async () => {
      const recordedAt = new Date("2025-01-02T00:00:00.000Z");
      vi.mocked(db.query).mockResolvedValueOnce([
        { epoch: 1, shares: "350", recorded_at: recordedAt },
      ]);

      const result = await userService.getShareBalanceHistory(TEST_ADDRESS);

      expect(result).toEqual([
        { epoch: 1, shares: "350", recordedAt },
      ]);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("SUM(shares)::text AS shares"),
        [TEST_ADDRESS],
      );
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("GROUP BY epoch"),
        [TEST_ADDRESS],
      );
    });
  });
});
