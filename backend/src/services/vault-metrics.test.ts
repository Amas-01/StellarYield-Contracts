/**
 * Tests for the four new vault metric endpoints introduced in:
 *  - Issue #1264: getHoldingDuration
 *  - Issue #1267: getWithdrawalRatios (snapshot augmentation)
 *  - Issue #1268: getFundingVelocity
 *  - Issue #1269: getRedemptionQueueEta
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./stellar.js", () => ({ getSorobanRpc: vi.fn() }));
vi.mock("./notifications.js", () => ({
  NotificationService: vi.fn().mockImplementation(() => ({})),
}));

import { VaultService } from "./vault.js";

const VAULT_CONTRACT = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";
const ACCOUNT = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

// ── #1264: Holding Duration ──────────────────────────────────────────────────

describe("VaultService - getHoldingDuration (#1264)", () => {
  let service: VaultService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new VaultService();
  });

  it("returns null when the vault does not exist", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]); // vault lookup

    const result = await service.getHoldingDuration(VAULT_CONTRACT);
    expect(result).toBeNull();
  });

  it("returns zero sampleSize when no holders have first_entry_at set", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: 1 }]) // vault lookup
      .mockResolvedValueOnce([{ average_days: null, median_days: null, sample_size: "0" }]); // stats

    const result = await service.getHoldingDuration(VAULT_CONTRACT);
    expect(result).toEqual({ averageDays: 0, medianDays: 0, sampleSize: 0 });
  });

  it("returns correct averageDays, medianDays and sampleSize", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: 1 }]) // vault lookup
      .mockResolvedValueOnce([
        { average_days: "14.5", median_days: "12.0", sample_size: "42" },
      ]);

    const result = await service.getHoldingDuration(VAULT_CONTRACT);
    expect(result).not.toBeNull();
    expect(result!.averageDays).toBe(14.5);
    expect(result!.medianDays).toBe(12);
    expect(result!.sampleSize).toBe(42);
  });

  it("rounds to two decimal places", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([
        { average_days: "7.12345", median_days: "6.98765", sample_size: "3" },
      ]);

    const result = await service.getHoldingDuration(VAULT_CONTRACT);
    expect(result!.averageDays).toBe(7.12);
    expect(result!.medianDays).toBe(6.99);
  });

  it("queries the correct vault_id derived from contract_id", async () => {
    const { query } = await import("../db/index.js");
    const mockQuery = query as ReturnType<typeof vi.fn>;
    mockQuery
      .mockResolvedValueOnce([{ id: 99 }])
      .mockResolvedValueOnce([{ average_days: "10.0", median_days: "10.0", sample_size: "5" }]);

    await service.getHoldingDuration(VAULT_CONTRACT);

    const statsCall = mockQuery.mock.calls[1];
    expect(statsCall[1]).toEqual([99]);
    expect(statsCall[0]).toContain("first_entry_at IS NOT NULL");
  });
});

// ── #1267: Withdrawal Ratios ──────────────────────────────────────────────────

describe("VaultService - getWithdrawalRatios (#1267)", () => {
  let service: VaultService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new VaultService();
  });

  it("returns null when vault does not exist", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]); // vault lookup

    const result = await service.getWithdrawalRatios(VAULT_CONTRACT);
    expect(result).toBeNull();
  });

  it("returns null ratios when no events in window (no rows from DB)", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([]); // no rows

    const result = await service.getWithdrawalRatios(VAULT_CONTRACT);
    expect(result).toEqual({ withdrawalRatio7d: null, withdrawalRatio30d: null });
  });

  it("returns null ratio when deposit volume is zero in a window", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([
        { period_days: "7", deposited: "0", withdrawn: "500" },
        { period_days: "30", deposited: "0", withdrawn: "1000" },
      ]);

    const result = await service.getWithdrawalRatios(VAULT_CONTRACT);
    expect(result!.withdrawalRatio7d).toBeNull();
    expect(result!.withdrawalRatio30d).toBeNull();
  });

  it("computes correct ratio for 7d window", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([
        { period_days: "7", deposited: "1000", withdrawn: "250" },
      ]);

    const result = await service.getWithdrawalRatios(VAULT_CONTRACT);
    // 250 / 1000 = 0.25
    expect(result!.withdrawalRatio7d).toBe(0.25);
    expect(result!.withdrawalRatio30d).toBeNull();
  });

  it("computes both 7d and 30d ratios when data exists for both windows", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([
        { period_days: "7", deposited: "2000", withdrawn: "400" },
        { period_days: "30", deposited: "8000", withdrawn: "2000" },
      ]);

    const result = await service.getWithdrawalRatios(VAULT_CONTRACT);
    expect(result!.withdrawalRatio7d).toBe(0.2);
    expect(result!.withdrawalRatio30d).toBe(0.25);
  });
});

// ── #1268: Funding Velocity ───────────────────────────────────────────────────

describe("VaultService - getFundingVelocity (#1268)", () => {
  let service: VaultService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new VaultService();
  });

  it("returns null when vault does not exist", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]); // vault lookup

    const result = await service.getFundingVelocity(VAULT_CONTRACT);
    expect(result).toBeNull();
  });

  it("returns null for a vault not in Funding state", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 1, state: "Active", total_assets: "5000", funding_target: "10000" },
    ]);

    const result = await service.getFundingVelocity(VAULT_CONTRACT);
    expect(result).toBeNull();
  });

  it("returns projectedFundingDate = null when velocity is zero", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { id: 1, state: "Funding", total_assets: "0", funding_target: "10000" },
      ])
      .mockResolvedValueOnce([{ total_deposited: "0" }]); // no deposits in 7d

    const result = await service.getFundingVelocity(VAULT_CONTRACT);
    expect(result).not.toBeNull();
    expect(result!.fundingVelocityPerDay).toBe(0);
    expect(result!.projectedFundingDate).toBeNull();
  });

  it("computes fundingVelocityPerDay as 7-day total deposits / 7", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { id: 1, state: "Funding", total_assets: "1000", funding_target: "10000" },
      ])
      .mockResolvedValueOnce([{ total_deposited: "700" }]); // 700 over 7 days

    const result = await service.getFundingVelocity(VAULT_CONTRACT);
    expect(result!.fundingVelocityPerDay).toBe(100); // 700/7
  });

  it("sets projectedFundingDate to now() when already at/past target", async () => {
    const { query } = await import("../db/index.js");
    const before = Date.now();
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { id: 1, state: "Funding", total_assets: "10000", funding_target: "10000" },
      ])
      .mockResolvedValueOnce([{ total_deposited: "700" }]);

    const result = await service.getFundingVelocity(VAULT_CONTRACT);
    expect(result!.projectedFundingDate).not.toBeNull();
    const projected = new Date(result!.projectedFundingDate!).getTime();
    expect(projected).toBeGreaterThanOrEqual(before);
  });

  it("computes a future projectedFundingDate when remaining > 0", async () => {
    const { query } = await import("../db/index.js");
    const before = Date.now();
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { id: 1, state: "Funding", total_assets: "0", funding_target: "700" },
      ])
      .mockResolvedValueOnce([{ total_deposited: "700" }]); // 100/day; 700 remaining → 7 days

    const result = await service.getFundingVelocity(VAULT_CONTRACT);
    const projected = new Date(result!.projectedFundingDate!).getTime();
    // Should be roughly 7 days from now
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(projected).toBeGreaterThan(before + sevenDaysMs - 5000);
    expect(projected).toBeLessThan(before + sevenDaysMs + 5000);
  });
});

// ── #1269: Redemption Queue ETA ───────────────────────────────────────────────

describe("VaultService - getRedemptionQueueEta (#1269)", () => {
  let service: VaultService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new VaultService();
  });

  it("returns null when vault does not exist", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]); // vault lookup

    const result = await service.getRedemptionQueueEta(VAULT_CONTRACT, ACCOUNT);
    expect(result).toBeNull();
  });

  it("returns null when address has no pending redemption request", async () => {
    const { query } = await import("../db/index.js");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: 1 }]) // vault
      .mockResolvedValueOnce([]); // no pending request for user

    const result = await service.getRedemptionQueueEta(VAULT_CONTRACT, ACCOUNT);
    expect(result).toBeNull();
  });

  it("returns position=1 and amountAhead=0 when user is first in queue", async () => {
    const { query } = await import("../db/index.js");
    const requestTime = new Date("2025-01-01T10:00:00Z");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: 1 }]) // vault
      .mockResolvedValueOnce([{ request_time: requestTime, shares: "500" }]) // user's request
      .mockResolvedValueOnce([{ position: "0", amount_ahead: "0" }]) // no requests ahead
      .mockResolvedValueOnce([{ processed_count: "0", span_seconds: null }]); // no history

    const result = await service.getRedemptionQueueEta(VAULT_CONTRACT, ACCOUNT);
    expect(result).not.toBeNull();
    expect(result!.position).toBe(1);
    expect(result!.amountAhead).toBe("0");
    expect(result!.estimatedProcessingDate).toBeNull(); // < 5 processed
  });

  it("accumulates amountAhead from requests submitted before the user's", async () => {
    const { query } = await import("../db/index.js");
    const requestTime = new Date("2025-01-01T10:00:00Z");
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ request_time: requestTime, shares: "200" }])
      .mockResolvedValueOnce([{ position: "3", amount_ahead: "1500" }]) // 3 before user
      .mockResolvedValueOnce([{ processed_count: "4", span_seconds: "86400" }]);

    const result = await service.getRedemptionQueueEta(VAULT_CONTRACT, ACCOUNT);
    expect(result!.position).toBe(4); // 3 ahead + 1
    expect(result!.amountAhead).toBe("1500");
    expect(result!.estimatedProcessingDate).toBeNull(); // only 4 processed, need >= 5
  });

  it("returns estimatedProcessingDate when >= 5 processed requests exist", async () => {
    const { query } = await import("../db/index.js");
    const requestTime = new Date("2025-01-01T10:00:00Z");
    const before = Date.now();
    (query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ request_time: requestTime, shares: "100" }])
      .mockResolvedValueOnce([{ position: "0", amount_ahead: "0" }]) // user is first
      .mockResolvedValueOnce([
        // 10 processed over 10 days = 1/day throughput
        { processed_count: "10", span_seconds: String(10 * 86400) },
      ]);

    const result = await service.getRedemptionQueueEta(VAULT_CONTRACT, ACCOUNT);
    expect(result!.estimatedProcessingDate).not.toBeNull();
    const estimated = new Date(result!.estimatedProcessingDate!).getTime();
    // position=1, throughput=1/day → ~1 day from now
    const oneDayMs = 86400 * 1000;
    expect(estimated).toBeGreaterThan(before + oneDayMs - 5000);
    expect(estimated).toBeLessThan(before + oneDayMs + 5000);
  });

  it("uses the correct vault_id and user_address in queries", async () => {
    const { query } = await import("../db/index.js");
    const mockQuery = query as ReturnType<typeof vi.fn>;
    const requestTime = new Date();
    mockQuery
      .mockResolvedValueOnce([{ id: 77 }])
      .mockResolvedValueOnce([{ request_time: requestTime, shares: "100" }])
      .mockResolvedValueOnce([{ position: "0", amount_ahead: "0" }])
      .mockResolvedValueOnce([{ processed_count: "0", span_seconds: null }]);

    await service.getRedemptionQueueEta(VAULT_CONTRACT, ACCOUNT);

    const userRequestCall = mockQuery.mock.calls[1];
    expect(userRequestCall[1]).toContain(77);
    expect(userRequestCall[1]).toContain(ACCOUNT);
  });
});
