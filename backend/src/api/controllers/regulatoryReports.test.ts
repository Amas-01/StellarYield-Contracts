import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../db/index.js", () => ({ query: mocks.query }));
vi.mock("../../services/metrics.js", () => ({ recordHttpError: vi.fn() }));

import { errorHandler } from "../middleware/errors.js";
import { getHolderConcentrationReport } from "./regulatoryReports.js";

const VAULT_ID = "C" + "B".repeat(55);

function buildApp() {
  const app = express();
  app.get("/api/v1/admin/regulatory/holder-concentration", getHolderConcentrationReport);
  app.use(errorHandler);
  return app;
}

const vaultRow = {
  id: 9,
  contract_id: VAULT_ID,
  name: "Treasury Vault",
  state: "Active",
  total_supply: "1000",
  total_assets: "50000",
};

const holders = [
  { address: "GAAA", shares: "400", value_locked: "20000" },
  { address: "GBBB", shares: "200", value_locked: "10000" },
  { address: "GCCC", shares: "100", value_locked: "5000" },
];

/** HHI of the fixture above: (0.4² + 0.2² + 0.1²) = 0.21. */
const aggregates = { holder_count: "3", holder_shares: "700", hhi: "0.21" };

function mockReport(rows = holders, totals = aggregates) {
  mocks.query.mockResolvedValueOnce([vaultRow]);
  mocks.query.mockResolvedValueOnce(rows);
  mocks.query.mockResolvedValueOnce([totals]);
}

beforeEach(() => {
  mocks.query.mockReset();
});

describe("GET /api/v1/admin/regulatory/holder-concentration (#1112)", () => {
  it("reports cumulative top-1/5/10 shares and the HHI against the vault supply", async () => {
    mockReport();

    const res = await supertest(buildApp()).get(
      `/api/v1/admin/regulatory/holder-concentration?vaultId=${VAULT_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.vault).toEqual({
      contractId: VAULT_ID,
      name: "Treasury Vault",
      state: "Active",
      totalSupply: "1000",
      totalValueLocked: "50000",
    });
    expect(res.body.holders).toEqual({ holderCount: 3, trackedShares: "700", coverage: 70 });
    expect(res.body.concentration).toEqual({
      top1SharePct: 40,
      top5SharePct: 70,
      top10SharePct: 70,
      hhi: 0.21,
      hhiIndex: 2100,
      riskLevel: "moderate",
    });
    expect(res.body.topHolders).toEqual([
      { rank: 1, address: "GAAA", shares: "400", sharePct: 40, valueLocked: "20000" },
      { rank: 2, address: "GBBB", shares: "200", sharePct: 20, valueLocked: "10000" },
      { rank: 3, address: "GCCC", shares: "100", sharePct: 10, valueLocked: "5000" },
    ]);
  });

  it("always reads the top 10 rows so the cumulative shares are complete", async () => {
    mockReport();

    await supertest(buildApp()).get(
      `/api/v1/admin/regulatory/holder-concentration?vaultId=${VAULT_ID}&topN=1`,
    );

    const [sql, params] = mocks.query.mock.calls[1];
    expect(sql).toContain("ORDER BY uvp.shares DESC");
    expect(params).toEqual([9, 10]);
  });

  it("returns only the requested number of holders", async () => {
    mockReport();

    const res = await supertest(buildApp()).get(
      `/api/v1/admin/regulatory/holder-concentration?vaultId=${VAULT_ID}&topN=2`,
    );

    expect(res.body.topHolders).toHaveLength(2);
  });

  it("falls back to the tracked shares when the vault has no supply", async () => {
    mocks.query.mockResolvedValueOnce([{ ...vaultRow, total_supply: "0" }]);
    mocks.query.mockResolvedValueOnce(holders);
    mocks.query.mockResolvedValueOnce([aggregates]);

    const res = await supertest(buildApp()).get(
      `/api/v1/admin/regulatory/holder-concentration?vaultId=${VAULT_ID}`,
    );

    expect(res.body.concentration.top1SharePct).toBe(57.1429);
    expect(res.body.holders.coverage).toBe(100);
  });

  it("classifies a concentrated vault as high risk", async () => {
    mockReport(holders, { holder_count: "3", holder_shares: "700", hhi: "0.4512" });

    const res = await supertest(buildApp()).get(
      `/api/v1/admin/regulatory/holder-concentration?vaultId=${VAULT_ID}`,
    );

    expect(res.body.concentration).toEqual(
      expect.objectContaining({ hhiIndex: 4512, riskLevel: "high" }),
    );
  });

  it("returns zeroed concentration for a vault with no holders", async () => {
    mockReport([], { holder_count: "0", holder_shares: "0", hhi: "0" });

    const res = await supertest(buildApp()).get(
      `/api/v1/admin/regulatory/holder-concentration?vaultId=${VAULT_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.holders).toEqual({ holderCount: 0, trackedShares: "0", coverage: 0 });
    expect(res.body.concentration).toEqual({
      top1SharePct: 0,
      top5SharePct: 0,
      top10SharePct: 0,
      hhi: 0,
      hhiIndex: 0,
      riskLevel: "low",
    });
    expect(res.body.topHolders).toEqual([]);
  });

  it("404s for an unknown or archived vault", async () => {
    mocks.query.mockResolvedValueOnce([]);

    const res = await supertest(buildApp()).get(
      `/api/v1/admin/regulatory/holder-concentration?vaultId=${VAULT_ID}`,
    );

    expect(res.status).toBe(404);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["", "missing vaultId"],
    [`&vaultId=nope`, "malformed vaultId"],
    [`&vaultId=${VAULT_ID}&topN=0`, "topN below range"],
    [`&vaultId=${VAULT_ID}&topN=101`, "topN above range"],
    [`&vaultId=${VAULT_ID}&topN=abc`, "non-numeric topN"],
  ])("rejects %s with 400 (%s)", async (qs) => {
    const res = await supertest(buildApp()).get(
      `/api/v1/admin/regulatory/holder-concentration?${qs}`,
    );

    expect(res.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
