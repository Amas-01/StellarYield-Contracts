import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({
  query: vi.fn(),
  pool: {},
  readPool: null,
}));

vi.mock("../config.js", () => ({
  config: {
    transferVelocityThreshold: 500,
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { query } from "../db/index.js";
import { checkTransferVelocity } from "./transferVelocityWorker.js";

describe("Transfer velocity anomaly worker (#1078)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects a velocity spike and creates a VELOCITY_SPIKE transfer alert when count > threshold", async () => {
    (query as any)
      .mockResolvedValueOnce([
        { vault_id: 1, contract_id: "CA111", count: "550" },
      ])
      .mockResolvedValueOnce([{ id: 42 }]);

    const result = await checkTransferVelocity();

    expect(result.checkedVaults).toBe(1);
    expect(result.alertsCreated).toHaveLength(1);
    expect(result.alertsCreated[0]).toEqual({
      vaultId: 1,
      contractId: "CA111",
      transferCount: 550,
      threshold: 500,
      alertId: 42,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO transfer_alerts"),
      [
        1,
        "CA111",
        JSON.stringify({
          transferCount: 550,
          threshold: 500,
          timeWindow: "1 hour",
        }),
      ],
    );
  });

  it("does not create alerts when no vault exceeds the velocity threshold", async () => {
    (query as any).mockResolvedValueOnce([]);

    const result = await checkTransferVelocity(500);

    expect(result.checkedVaults).toBe(0);
    expect(result.alertsCreated).toHaveLength(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("respects customThreshold override", async () => {
    (query as any)
      .mockResolvedValueOnce([
        { vault_id: 2, contract_id: "CB222", count: "150" },
      ])
      .mockResolvedValueOnce([{ id: 99 }]);

    const result = await checkTransferVelocity(100);

    expect(result.alertsCreated).toHaveLength(1);
    expect(result.alertsCreated[0].threshold).toBe(100);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("HAVING COUNT(*) > $1"),
      [100],
    );
  });
});
