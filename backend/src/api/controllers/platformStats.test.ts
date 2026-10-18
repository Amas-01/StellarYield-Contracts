import { vi, describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../db/index.js", () => ({ query: mocks.query }));
vi.mock("../../services/metrics.js", () => ({ recordHttpError: vi.fn() }));

import { errorHandler } from "../middleware/errors.js";
import { platformStatsRouter, userVaultActivityRouter } from "../routes/platformStats.js";

const USER = "G" + "A".repeat(55);

function makeApp() {
  const app = express();
  app.use("/api/v1/platform", platformStatsRouter);
  app.use("/api/v1/users", userVaultActivityRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => mocks.query.mockReset());

describe("GET /api/v1/platform/tvl (#1084)", () => {
  it("returns the sum of every vault's latest snapshot, the vault count and the newest timestamp", async () => {
    mocks.query.mockResolvedValueOnce([
      { total: "3500000", vault_count: "3", last_updated_at: "2026-09-26T10:00:00.000Z" },
    ]);

    const res = await request(makeApp()).get("/api/v1/platform/tvl");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalTvlUsd: "3500000",
      vaultCount: 3,
      lastUpdatedAt: "2026-09-26T10:00:00.000Z",
    });
    const sql: string = mocks.query.mock.calls[0][0];
    expect(sql).toContain("DISTINCT ON (vault_id)");
    expect(sql).toContain("ORDER BY vault_id, recorded_at DESC");
    expect(sql).toContain("MAX(recorded_at)");
  });

  it("returns zeros and a null timestamp when there are no snapshots", async () => {
    mocks.query.mockResolvedValueOnce([{ total: "0", vault_count: "0", last_updated_at: null }]);

    const res = await request(makeApp()).get("/api/v1/platform/tvl");

    expect(res.body).toEqual({ totalTvlUsd: "0", vaultCount: 0, lastUpdatedAt: null });
  });
});

describe("GET /api/v1/platform/tvl/history (#1085)", () => {
  it("returns one point per day for the requested range", async () => {
    mocks.query.mockResolvedValueOnce([
      { date: "2026-09-01", total_tvl: "100" },
      { date: "2026-09-02", total_tvl: "150" },
      { date: "2026-09-03", total_tvl: "150" },
    ]);

    const res = await request(makeApp()).get(
      "/api/v1/platform/tvl/history?from=2026-09-01&to=2026-09-03&interval=1d",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { date: "2026-09-01", totalTvlUsd: "100" },
      { date: "2026-09-02", totalTvlUsd: "150" },
      { date: "2026-09-03", totalTvlUsd: "150" },
    ]);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(params).toEqual(["2026-09-01", "2026-09-03"]);
    // one row per calendar day, each summing the latest snapshot per vault
    expect(sql).toContain("generate_series");
    expect(sql).toContain("DISTINCT ON (vault_id)");
    expect(sql).toContain("GROUP BY d.day");
  });

  it("accepts full ISO timestamps and truncates them to UTC days", async () => {
    mocks.query.mockResolvedValueOnce([]);
    const res = await request(makeApp()).get(
      "/api/v1/platform/tvl/history?from=2026-09-01T23:30:00Z&to=2026-09-02T01:00:00Z",
    );
    expect(res.status).toBe(200);
    expect(mocks.query.mock.calls[0][1]).toEqual(["2026-09-01", "2026-09-02"]);
  });

  it("defaults to the last 30 days ending today", async () => {
    mocks.query.mockResolvedValueOnce([]);
    const res = await request(makeApp()).get("/api/v1/platform/tvl/history");
    expect(res.status).toBe(200);
    const [from, to] = mocks.query.mock.calls[0][1] as string[];
    expect(Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1).toBe(30);
    expect(to).toBe(new Date().toISOString().slice(0, 10));
  });

  it.each([
    ["from=nope", "invalid date"],
    ["from=2026-09-05&to=2026-09-01", "from after to"],
    ["from=2024-01-01&to=2026-01-01", "range over 366 days"],
    ["interval=1h", "unsupported interval"],
  ])("rejects %s (%s) with 400", async (qs) => {
    const res = await request(makeApp()).get(`/api/v1/platform/tvl/history?${qs}`);
    expect(res.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/platform/users/count (#1086)", () => {
  it("returns total, active and new counts as numbers", async () => {
    mocks.query.mockResolvedValueOnce([{ total: "120", active: "45", new_users: "12" }]);

    const res = await request(makeApp()).get("/api/v1/platform/users/count");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 120, activeThisMonth: 45, newThisMonth: 12 });
    const sql: string = mocks.query.mock.calls[0][0];
    // distinct addresses, rolling 30-day windows
    expect(sql).toContain("GROUP BY user_address");
    expect(sql).toContain("INTERVAL '30 days'");
    expect(sql).toContain("MIN(first_entry_at)");
    expect(sql).toContain("MAX(updated_at)");
  });

  it("returns zeros for an empty platform", async () => {
    mocks.query.mockResolvedValueOnce([{ total: "0", active: "0", new_users: "0" }]);
    const res = await request(makeApp()).get("/api/v1/platform/users/count");
    expect(res.body).toEqual({ total: 0, activeThisMonth: 0, newThisMonth: 0 });
  });
});

describe("GET /api/v1/users/:address/vault-activity (#1083)", () => {
  it("lists every vault with history, with zero balance and an exit time for exited vaults", async () => {
    mocks.query.mockResolvedValueOnce([
      {
        contract_id: "CEXITED",
        first_entry_at: "2026-08-01T00:00:00.000Z",
        last_exit_at: "2026-09-10T00:00:00.000Z",
        shares: "0",
      },
      { contract_id: "CHELD", first_entry_at: "2026-08-15T00:00:00.000Z", last_exit_at: null, shares: "2500" },
    ]);

    const res = await request(makeApp()).get(`/api/v1/users/${USER}/vault-activity`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        contractId: "CEXITED",
        firstEntryAt: "2026-08-01T00:00:00.000Z",
        lastExitAt: "2026-09-10T00:00:00.000Z",
        currentBalance: "0",
      },
      {
        contractId: "CHELD",
        firstEntryAt: "2026-08-15T00:00:00.000Z",
        lastExitAt: null,
        currentBalance: "2500",
      },
    ]);
    expect(mocks.query.mock.calls[0][1]).toEqual([USER]);
  });

  it("never reports lastExitAt while the user still holds a balance", async () => {
    mocks.query.mockResolvedValueOnce([
      { contract_id: "CHELD", first_entry_at: "2026-08-15T00:00:00.000Z", last_exit_at: "2026-09-01T00:00:00.000Z", shares: "10" },
    ]);

    const res = await request(makeApp()).get(`/api/v1/users/${USER}/vault-activity`);

    expect(res.body[0].lastExitAt).toBeNull();
  });

  it("returns an empty list for an address with no history", async () => {
    mocks.query.mockResolvedValueOnce([]);
    const res = await request(makeApp()).get(`/api/v1/users/${USER}/vault-activity`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("rejects a malformed address with 400", async () => {
    const res = await request(makeApp()).get("/api/v1/users/not-an-address/vault-activity");
    expect(res.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
