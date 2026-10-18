import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../cache/redis.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

import { YieldService } from "./yield.js";
import * as db from "../db/index.js";

const CONTRACT_ID = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";

/** A finalized epoch row, overridable per test. */
function epochRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    vault_id: 10,
    epoch: 3,
    yield_amount: "5000000",
    total_shares: "2000000",
    closed_at: new Date("2025-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("YieldService.getEpochYieldPerShare (#1071)", () => {
  let service: YieldService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new YieldService();
    vi.mocked(db.query).mockResolvedValue([epochRow()]);
  });

  it("returns the epoch id, an 18-decimal ratio string and the decimal count", async () => {
    const result = await service.getEpochYieldPerShare(CONTRACT_ID, 3);

    expect(result).toEqual({
      epochId: 3,
      yieldPerShare: "2.500000000000000000",
      decimals: 18,
    });
  });

  it("returns the ratio as a string so a JS number cannot round it", async () => {
    const result = await service.getEpochYieldPerShare(CONTRACT_ID, 3);

    expect(typeof result?.yieldPerShare).toBe("string");
  });

  it("keeps full precision when the ratio exceeds Number.MAX_SAFE_INTEGER", async () => {
    // A share supply small enough that yield/shares is a ~19-digit integer.
    vi.mocked(db.query).mockResolvedValue([
      epochRow({ yield_amount: "170141183460469231731687303715884105727", total_shares: "1" }),
    ]);

    const result = await service.getEpochYieldPerShare(CONTRACT_ID, 3);

    expect(result?.yieldPerShare).toBe(
      "170141183460469231731687303715884105727.000000000000000000",
    );
  });

  it("returns zero rather than dividing by zero when no shares were issued", async () => {
    vi.mocked(db.query).mockResolvedValue([epochRow({ total_shares: "0" })]);

    const result = await service.getEpochYieldPerShare(CONTRACT_ID, 3);

    expect(result?.yieldPerShare).toBe("0.000000000000000000");
  });

  it("returns null when the vault has no such epoch", async () => {
    vi.mocked(db.query).mockResolvedValue([]);

    expect(await service.getEpochYieldPerShare(CONTRACT_ID, 99)).toBeNull();
  });

  it("returns null for an epoch that exists but is not yet finalized", async () => {
    // closed_at is the finalization marker; while it is null the epoch can still
    // take claims, so the ratio could still move and must not be published.
    vi.mocked(db.query).mockResolvedValue([epochRow({ closed_at: null })]);

    expect(await service.getEpochYieldPerShare(CONTRACT_ID, 3)).toBeNull();
  });

  it("binds the contract id and epoch as parameters", async () => {
    await service.getEpochYieldPerShare(CONTRACT_ID, 3);

    const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("e.epoch = $2");
    expect(params).toEqual([CONTRACT_ID, 3]);
    expect(sql).not.toContain(CONTRACT_ID);
  });

  it("scopes the lookup to the vault so an epoch from another vault cannot match", async () => {
    await service.getEpochYieldPerShare(CONTRACT_ID, 3);

    const [sql] = vi.mocked(db.query).mock.calls[0] as [string];
    expect(sql).toContain("JOIN vaults v ON e.vault_id = v.id");
    expect(sql).toContain("v.contract_id = $1");
  });

  it("selects closed_at so finalization can be enforced in the query result", async () => {
    await service.getEpochYieldPerShare(CONTRACT_ID, 3);

    const [sql] = vi.mocked(db.query).mock.calls[0] as [string];
    expect(sql).toContain("e.closed_at");
  });
});
