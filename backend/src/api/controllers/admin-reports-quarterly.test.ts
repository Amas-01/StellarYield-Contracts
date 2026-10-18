import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../db/index.js", () => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM epochs")) {
      return [{ total_yield: "1500000000" }];
    }
    if (sql.includes("FROM transfer_fees")) {
      return [{ total_fees: "75000" }];
    }
    if (sql.includes("FROM vault_tvl_snapshots")) {
      return [{ peak_tvl: "10000000" }];
    }
    if (sql.includes("FROM user_vault_positions")) {
      return [{ count: "128" }];
    }
    return [];
  }),
  pool: {},
  readPool: null,
}));
vi.mock("../../services/indexerSingleton.js", () => ({ indexer: {} }));
vi.mock("../../services/jobQueue.js", () => ({ jobQueue: {} }));
vi.mock("../../services/sseManager.js", () => ({ sseManager: {} }));

import { getQuarterlyYieldReport } from "./admin.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/v1/admin/reports/quarterly", getQuarterlyYieldReport);
  return app;
}

describe("GET /api/v1/admin/reports/quarterly (#1114)", () => {
  const app = makeApp();

  it("returns quarterly report with yield, fees, peak TVL, and unique holders", async () => {
    const res = await request(app).get("/api/v1/admin/reports/quarterly?year=2026&quarter=1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      year: 2026,
      quarter: 1,
      totalYieldPaid: "1500000000",
      totalFeesEarned: "75000",
      peakTvlUsd: "10000000",
      uniqueHolders: 128,
    });
  });

  it("rejects invalid quarter numbers", async () => {
    const res = await request(app).get("/api/v1/admin/reports/quarterly?year=2026&quarter=5");

    expect(res.status).toBe(400);
  });
});
