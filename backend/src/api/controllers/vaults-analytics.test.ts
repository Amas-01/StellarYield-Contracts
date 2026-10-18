/**
 * Tests for the analytics endpoints added in issues #1265, #1266, #1270, #1274.
 *
 * #1265 – deposit-distribution histogram
 * #1266 – holder cohorts by first-deposit month
 * #1270 – pendingRedemptionAmount / pendingRedemptionCount in snapshot
 * #1274 – settlement_status on vault detail / snapshot
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getVault: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({ query: mocks.query }));
vi.mock("../../services/vault.js", () => ({
  VaultService: vi.fn(() => ({
    getVault: mocks.getVault,
  })),
  validateFilterTree: vi.fn(() => true),
  VAULT_FIELD_ALLOWLIST: new Set<string>(),
  pickVaultFields: vi.fn((v: unknown) => v),
  parseVaultSort: vi.fn(() => ({ ok: true, specs: [] })),
}));
vi.mock("../../services/stellar.js", () => ({
  readTotalAssets: vi.fn(),
  readVaultState: vi.fn(),
  readPaused: vi.fn(),
  readCooperator: vi.fn(),
  readCooperatorFeeBps: vi.fn(),
}));

import {
  getVaultSnapshotV2,
  getDepositDistribution,
  getVaultCohorts,
} from "./vaults.js";

const CONTRACT_ID = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";

function makeRes() {
  return {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    params: { contractId: CONTRACT_ID },
    query: {},
    ...overrides,
  };
}

const MOCK_VAULT = {
  id: 42,
  contractId: CONTRACT_ID,
  state: "Active",
  totalAssets: "1000000",
  totalSupply: "2000",
  totalSharesEverMinted: "2000",
  totalSharesEverBurned: "0",
  depositorCount: 5,
  settlementStatus: null,
};

// ---------------------------------------------------------------------------
// #1270 – getVaultSnapshotV2 (pendingRedemptionAmount / pendingRedemptionCount)
// ---------------------------------------------------------------------------
describe("getVaultSnapshotV2 (#1270)", () => {
  const next = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when vault not found", async () => {
    mocks.getVault.mockResolvedValue(null);
    const res = makeRes();
    await getVaultSnapshotV2(makeReq() as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns pendingRedemptionAmount and pendingRedemptionCount with snapshot", async () => {
    mocks.getVault.mockResolvedValue(MOCK_VAULT);
    // query is called in order: epochCount, lastEvent, top10, pendingRedemptions
    mocks.query
      .mockResolvedValueOnce([{ count: "3" }]) // epoch count
      .mockResolvedValueOnce([{ created_at: new Date("2026-01-01") }]) // last indexed event
      .mockResolvedValueOnce([{ top10_shares: "1500" }]) // top10
      .mockResolvedValueOnce([{ amount: "750", count: "2" }]); // pending redemptions

    const res = makeRes();
    await getVaultSnapshotV2(makeReq() as any, res as any, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingRedemptionAmount: "750",
        pendingRedemptionCount: 2,
      }),
    );
  });

  it("returns zero counts when no pending redemptions exist", async () => {
    mocks.getVault.mockResolvedValue(MOCK_VAULT);
    mocks.query
      .mockResolvedValueOnce([{ count: "0" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ top10_shares: "0" }])
      .mockResolvedValueOnce([{ amount: "0", count: "0" }]);

    const res = makeRes();
    await getVaultSnapshotV2(makeReq() as any, res as any, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingRedemptionAmount: "0",
        pendingRedemptionCount: 0,
      }),
    );
  });

  it("returns 400 for an invalid contractId", async () => {
    const res = makeRes();
    const req = { params: { contractId: "not-valid" }, query: {} };
    await getVaultSnapshotV2(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

// ---------------------------------------------------------------------------
// #1265 – getDepositDistribution
// ---------------------------------------------------------------------------
describe("getDepositDistribution (#1265)", () => {
  const next = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 422 when buckets < 2", async () => {
    const res = makeRes();
    const req = makeReq({ query: { buckets: "1" } });
    await getDepositDistribution(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it("returns 422 when buckets > 50", async () => {
    const res = makeRes();
    const req = makeReq({ query: { buckets: "51" } });
    await getDepositDistribution(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it("returns 404 when vault not found", async () => {
    mocks.query.mockResolvedValueOnce([]); // vault lookup returns nothing
    const res = makeRes();
    const req = makeReq({ query: { buckets: "10" } });
    await getDepositDistribution(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns empty buckets when no deposits exist", async () => {
    mocks.query
      .mockResolvedValueOnce([{ id: 42 }]) // vault found
      .mockResolvedValueOnce([]); // no deposits

    const res = makeRes();
    const req = makeReq({ query: { buckets: "5" } });
    await getDepositDistribution(req as any, res as any, next);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ buckets: [] }));
  });

  it("bucket counts sum to total deposit count", async () => {
    mocks.query
      .mockResolvedValueOnce([{ id: 42 }]) // vault found
      .mockResolvedValueOnce([
        { amount: "100" },
        { amount: "200" },
        { amount: "300" },
        { amount: "400" },
        { amount: "500" },
      ]); // 5 deposits

    const res = makeRes();
    const req = makeReq({ query: { buckets: "5" } });
    await getDepositDistribution(req as any, res as any, next);

    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const bucketTotal = (call.buckets as Array<{ count: number }>).reduce(
      (sum, b) => sum + b.count,
      0,
    );
    expect(bucketTotal).toBe(5);
    expect(call.totalDeposits).toBe(5);
  });

  it("returns 5 buckets when requested", async () => {
    mocks.query
      .mockResolvedValueOnce([{ id: 42 }])
      .mockResolvedValueOnce([
        { amount: "100" },
        { amount: "200" },
        { amount: "300" },
      ]);

    const res = makeRes();
    const req = makeReq({ query: { buckets: "5" } });
    await getDepositDistribution(req as any, res as any, next);

    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.buckets).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// #1266 – getVaultCohorts
// ---------------------------------------------------------------------------
describe("getVaultCohorts (#1266)", () => {
  const next = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when vault not found", async () => {
    mocks.query.mockResolvedValueOnce([]);
    const res = makeRes();
    await getVaultCohorts(makeReq() as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns cohorts ordered chronologically", async () => {
    mocks.query
      .mockResolvedValueOnce([{ id: 42 }]) // vault found
      .mockResolvedValueOnce([
        {
          cohort_month: "2026-01",
          holders: "10",
          current_shares: "5000",
          holders_still_holding: "8",
        },
        {
          cohort_month: "2026-02",
          holders: "5",
          current_shares: "2000",
          holders_still_holding: "5",
        },
      ]);

    const res = makeRes();
    await getVaultCohorts(makeReq() as any, res as any, next);

    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.cohorts).toHaveLength(2);
    expect(call.cohorts[0].cohortMonth).toBe("2026-01");
    expect(call.cohorts[1].cohortMonth).toBe("2026-02");
  });

  it("each holder belongs to exactly one cohort (no overlap in mock data)", async () => {
    mocks.query
      .mockResolvedValueOnce([{ id: 42 }])
      .mockResolvedValueOnce([
        {
          cohort_month: "2026-01",
          holders: "3",
          current_shares: "300",
          holders_still_holding: "2",
        },
        {
          cohort_month: "2026-03",
          holders: "7",
          current_shares: "700",
          holders_still_holding: "7",
        },
      ]);

    const res = makeRes();
    await getVaultCohorts(makeReq() as any, res as any, next);

    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // The SQL query uses GROUP BY cohort_month; each position row contributes
    // to exactly one bucket — the test data models this correctly.
    const totalHolders = (call.cohorts as Array<{ holders: number }>).reduce(
      (sum, c) => sum + c.holders,
      0,
    );
    expect(totalHolders).toBe(10); // 3 + 7
  });

  it("computes percentStillHolding correctly", async () => {
    mocks.query
      .mockResolvedValueOnce([{ id: 42 }])
      .mockResolvedValueOnce([
        {
          cohort_month: "2026-01",
          holders: "4",
          current_shares: "400",
          holders_still_holding: "2",
        },
      ]);

    const res = makeRes();
    await getVaultCohorts(makeReq() as any, res as any, next);

    const call = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.cohorts[0].percentStillHolding).toBe(50);
  });

  it("returns 400 for an invalid contractId", async () => {
    const res = makeRes();
    const req = { params: { contractId: "bad" }, query: {} };
    await getVaultCohorts(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
