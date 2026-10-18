import { vi, describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../db/index.js", () => ({ query: mocks.query }));
// The admin API-key check itself is covered by its own tests; here it passes through.
vi.mock("../middleware/auth.js", () => ({
  requireApiKey: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../services/metrics.js", () => ({ recordHttpError: vi.fn() }));

import { errorHandler } from "../middleware/errors.js";
import { adminFeesRouter, platformFeesRouter, vaultFeesRouter } from "../routes/fees.js";

const VAULT = "C" + "A".repeat(55);
const OWNER = "G" + "A".repeat(55);
const TX = "a".repeat(64);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/platform", platformFeesRouter);
  app.use("/api/v1/vaults", vaultFeesRouter);
  app.use("/api/v1/admin/vaults", adminFeesRouter);
  app.use(errorHandler);
  return app;
}

const vaultExists = () => mocks.query.mockResolvedValueOnce([{ id: 1 }]);
const vaultMissing = () => mocks.query.mockResolvedValueOnce([]);

beforeEach(() => mocks.query.mockReset());

describe("GET /api/v1/platform/fees (#1101)", () => {
  it("returns the total and the per-vault fees, with the total equal to the sum of the rows", async () => {
    mocks.query.mockResolvedValueOnce([
      { contract_id: VAULT, fees: "700", total: "1000" },
      { contract_id: "C" + "B".repeat(55), fees: "300", total: "1000" },
    ]);

    const res = await request(makeApp()).get("/api/v1/platform/fees?period=30d");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      period: "30d",
      totalFeesUsd: "1000",
      byVault: [
        { contractId: VAULT, feesUsd: "700" },
        { contractId: "C" + "B".repeat(55), feesUsd: "300" },
      ],
    });
    const byVaultSum = res.body.byVault.reduce((s: number, v: { feesUsd: string }) => s + Number(v.feesUsd), 0);
    expect(byVaultSum).toBe(Number(res.body.totalFeesUsd));
  });

  it("queries the requested period and omits vaults with no fees in the SQL", async () => {
    mocks.query.mockResolvedValueOnce([]);

    const res = await request(makeApp()).get("/api/v1/platform/fees?period=7d");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ period: "7d", totalFeesUsd: "0", byVault: [] });
    const [sql, params] = mocks.query.mock.calls[0];
    expect(params).toEqual([7]);
    expect(sql).toContain("HAVING SUM(fees) > 0");
    expect(sql).toContain("indexed_events");
    expect(sql).toContain("redemption_requests");
  });

  it("defaults to 30d", async () => {
    mocks.query.mockResolvedValueOnce([]);
    const res = await request(makeApp()).get("/api/v1/platform/fees");
    expect(res.body.period).toBe("30d");
    expect(mocks.query.mock.calls[0][1]).toEqual([30]);
  });

  it.each(["abc", "0d", "30", "5000d", "-3d"])("rejects period=%s with 400", async (period) => {
    const res = await request(makeApp()).get(`/api/v1/platform/fees?period=${period}`);
    expect(res.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/vaults/:contractId/fee-accrual-estimate (#1102)", () => {
  it("returns the estimate from the latest snapshot and the current fee rate", async () => {
    mocks.query.mockResolvedValueOnce([{ tvl: "1000000", fee_bps: 200, estimate: "1643.8356164" }]);

    const res = await request(makeApp()).get(`/api/v1/vaults/${VAULT}/fee-accrual-estimate?days=30`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      estimatedFeeUsd: "1643.8356164",
      basedOnTvlUsd: "1000000",
      feeBps: 200,
      projectionDays: 30,
    });
    const [sql, params] = mocks.query.mock.calls[0];
    expect(params).toEqual([VAULT, 30]);
    // tvl x (feeBps / 10000) x (days / 365)
    expect(sql).toContain("total_assets * COALESCE(v.operator_fee_bps, 0) * $2::numeric / (10000 * 365)");
    expect(sql).toContain("ORDER BY recorded_at DESC");
  });

  it("defaults to a 30 day projection", async () => {
    mocks.query.mockResolvedValueOnce([{ tvl: "1", fee_bps: 0, estimate: "0" }]);
    const res = await request(makeApp()).get(`/api/v1/vaults/${VAULT}/fee-accrual-estimate`);
    expect(res.body.projectionDays).toBe(30);
  });

  it("returns 404 when the vault has no TVL snapshot", async () => {
    mocks.query.mockResolvedValueOnce([{ tvl: null, fee_bps: 200, estimate: null }]);
    const res = await request(makeApp()).get(`/api/v1/vaults/${VAULT}/fee-accrual-estimate`);
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/no tvl snapshot/i);
  });

  it("returns 404 for an unknown vault", async () => {
    mocks.query.mockResolvedValueOnce([]);
    const res = await request(makeApp()).get(`/api/v1/vaults/${VAULT}/fee-accrual-estimate`);
    expect(res.status).toBe(404);
  });

  it.each(["0", "abc", "4000", "-5"])("rejects days=%s with 400", async (days) => {
    const res = await request(makeApp()).get(`/api/v1/vaults/${VAULT}/fee-accrual-estimate?days=${days}`);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed contract id", async () => {
    const res = await request(makeApp()).get("/api/v1/vaults/nope/fee-accrual-estimate");
    expect(res.status).toBe(400);
  });
});

describe("fee rebates (#1103)", () => {
  const row = {
    id: 5,
    contract_id: VAULT,
    address: OWNER,
    rebate_amount: "12.5",
    reason: "Large depositor",
    tx_hash: TX,
    created_at: "2026-09-01T00:00:00.000Z",
  };

  it("lists rebates newest first", async () => {
    vaultExists();
    mocks.query.mockResolvedValueOnce([row, { ...row, id: 4 }]);

    const res = await request(makeApp()).get(`/api/v1/vaults/${VAULT}/fee-rebates`);

    expect(res.status).toBe(200);
    expect(res.body.rebates.map((r: { id: number }) => r.id)).toEqual([5, 4]);
    expect(res.body.rebates[0]).toEqual({
      id: 5,
      contractId: VAULT,
      address: OWNER,
      rebateAmount: "12.5",
      reason: "Large depositor",
      txHash: TX,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    expect(mocks.query.mock.calls[1][0]).toContain("ORDER BY created_at DESC");
  });

  it("returns 404 listing rebates for an unknown vault", async () => {
    vaultMissing();
    const res = await request(makeApp()).get(`/api/v1/vaults/${VAULT}/fee-rebates`);
    expect(res.status).toBe(404);
  });

  it("creates a rebate that the list endpoint then returns", async () => {
    vaultExists();
    mocks.query.mockResolvedValueOnce([row]);

    const created = await request(makeApp())
      .post(`/api/v1/admin/vaults/${VAULT}/fee-rebates`)
      .send({ address: OWNER, rebateAmount: "12.5", reason: "  Large depositor  ", txHash: TX });

    expect(created.status).toBe(201);
    expect(created.body.id).toBe(5);
    expect(mocks.query.mock.calls[1][1]).toEqual([VAULT, OWNER, "12.5", "Large depositor", TX]);

    vaultExists();
    mocks.query.mockResolvedValueOnce([row]);
    const list = await request(makeApp()).get(`/api/v1/vaults/${VAULT}/fee-rebates`);
    expect(list.body.rebates).toHaveLength(1);
    expect(list.body.rebates[0].id).toBe(created.body.id);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("rejects a %s reason with 400 and writes nothing", async (_label, reason) => {
    const res = await request(makeApp())
      .post(`/api/v1/admin/vaults/${VAULT}/fee-rebates`)
      .send({ address: OWNER, rebateAmount: "1", ...(reason === undefined ? {} : { reason }) });

    expect(res.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects an invalid address, a non-positive amount and a bad tx hash", async () => {
    const app = makeApp();
    const post = (body: object) => request(app).post(`/api/v1/admin/vaults/${VAULT}/fee-rebates`).send(body);
    expect((await post({ address: "bad", rebateAmount: "1", reason: "x" })).status).toBe(400);
    expect((await post({ address: OWNER, rebateAmount: "0", reason: "x" })).status).toBe(400);
    expect((await post({ address: OWNER, rebateAmount: "-1", reason: "x" })).status).toBe(400);
    expect((await post({ address: OWNER, rebateAmount: "1", reason: "x", txHash: "zz" })).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("fee tiers (#1099)", () => {
  const tier = (id: number, min: string, max: string | null, bps: number) => ({
    id,
    contract_id: VAULT,
    min_balance: min,
    max_balance: max,
    fee_bps: bps,
    created_at: "2026-09-01T00:00:00.000Z",
  });

  it("lists tiers sorted by minimum balance ascending", async () => {
    vaultExists();
    mocks.query.mockResolvedValueOnce([tier(2, "0", "1000", 100), tier(1, "1000", "50000", 50), tier(3, "50000", null, 25)]);

    const res = await request(makeApp()).get(`/api/v1/vaults/${VAULT}/fee-tiers`);

    expect(res.status).toBe(200);
    expect(res.body.tiers.map((t: { minBalance: string }) => t.minBalance)).toEqual(["0", "1000", "50000"]);
    expect(res.body.tiers[2].maxBalance).toBeNull();
    expect(mocks.query.mock.calls[1][0]).toContain("ORDER BY min_balance ASC");
  });

  it("creates a tier", async () => {
    vaultExists();
    mocks.query.mockResolvedValueOnce([tier(9, "1000", "5000", 75)]);

    const res = await request(makeApp())
      .post(`/api/v1/admin/vaults/${VAULT}/fee-tiers`)
      .send({ minBalance: "1000", maxBalance: "5000", feeBps: 75 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 9, minBalance: "1000", maxBalance: "5000", feeBps: 75 });
    const [sql, params] = mocks.query.mock.calls[1];
    expect(params).toEqual([VAULT, "1000", "5000", 75]);
    expect(sql).toContain("WHERE NOT EXISTS");
  });

  it("creates an open-ended tier when maxBalance is omitted", async () => {
    vaultExists();
    mocks.query.mockResolvedValueOnce([tier(10, "5000", null, 10)]);

    const res = await request(makeApp())
      .post(`/api/v1/admin/vaults/${VAULT}/fee-tiers`)
      .send({ minBalance: "5000", feeBps: 10 });

    expect(res.status).toBe(201);
    expect(mocks.query.mock.calls[1][1]).toEqual([VAULT, "5000", null, 10]);
  });

  it("rejects an overlapping tier with 422", async () => {
    vaultExists();
    mocks.query.mockResolvedValueOnce([]); // guarded INSERT wrote nothing: overlap

    const res = await request(makeApp())
      .post(`/api/v1/admin/vaults/${VAULT}/fee-tiers`)
      .send({ minBalance: "500", maxBalance: "2000", feeBps: 75 });

    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/overlaps/i);
  });

  it("rejects invalid tiers with 400 before touching the database", async () => {
    const app = makeApp();
    const post = (body: object) => request(app).post(`/api/v1/admin/vaults/${VAULT}/fee-tiers`).send(body);
    expect((await post({ minBalance: "100", maxBalance: "100", feeBps: 10 })).status).toBe(400);
    expect((await post({ minBalance: "100", maxBalance: "50", feeBps: 10 })).status).toBe(400);
    expect((await post({ minBalance: "-1", feeBps: 10 })).status).toBe(400);
    expect((await post({ minBalance: "0", feeBps: 10001 })).status).toBe(400);
    expect((await post({ minBalance: "0", feeBps: 1.5 })).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("deletes a tier, and 404s when it does not exist", async () => {
    mocks.query.mockResolvedValueOnce([{ id: 9 }]);
    const ok = await request(makeApp()).delete(`/api/v1/admin/vaults/${VAULT}/fee-tiers/9`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ deleted: true, id: 9 });
    expect(mocks.query.mock.calls[0][1]).toEqual([9, VAULT]);

    mocks.query.mockResolvedValueOnce([]);
    const missing = await request(makeApp()).delete(`/api/v1/admin/vaults/${VAULT}/fee-tiers/10`);
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/v1/vaults/:contractId/fee-revenue (#1104)", () => {
  it("returns one point per day, zero-filled days included", async () => {
    vaultExists();
    mocks.query.mockResolvedValueOnce([
      { date: "2026-09-01", fees: "0" },
      { date: "2026-09-02", fees: "150" },
      { date: "2026-09-03", fees: "0" },
    ]);

    const res = await request(makeApp()).get(
      `/api/v1/vaults/${VAULT}/fee-revenue?from=2026-09-01&to=2026-09-03&interval=1d`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { date: "2026-09-01", feesUsd: "0" },
      { date: "2026-09-02", feesUsd: "150" },
      { date: "2026-09-03", feesUsd: "0" },
    ]);
    const [sql, params] = mocks.query.mock.calls[1];
    expect(params).toEqual(["2026-09-01", "2026-09-03", "day", "1 day", VAULT]);
    expect(sql).toContain("FROM generate_series");
    expect(sql).toContain("LEFT JOIN transfer_fees");
    expect(sql).toContain("COALESCE(SUM(tf.fee_amount), 0)");
  });

  it("buckets by ISO week for interval=7d", async () => {
    vaultExists();
    mocks.query.mockResolvedValueOnce([{ date: "2026-08-31", fees: "175" }]);

    const res = await request(makeApp()).get(
      `/api/v1/vaults/${VAULT}/fee-revenue?from=2026-09-01&to=2026-09-06&interval=7d`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ date: "2026-08-31", feesUsd: "175" }]);
    expect(mocks.query.mock.calls[1][1]).toEqual(["2026-09-01", "2026-09-06", "week", "7 days", VAULT]);
  });

  it("defaults to a daily series over the last 30 days", async () => {
    vaultExists();
    mocks.query.mockResolvedValueOnce([]);

    const res = await request(makeApp()).get(`/api/v1/vaults/${VAULT}/fee-revenue`);

    expect(res.status).toBe(200);
    const [, params] = mocks.query.mock.calls[1];
    const [from, to, trunc] = params as string[];
    expect(trunc).toBe("day");
    expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBe(29);
  });

  it("returns 404 for an unknown vault", async () => {
    vaultMissing();
    const res = await request(makeApp()).get(`/api/v1/vaults/${VAULT}/fee-revenue`);
    expect(res.status).toBe(404);
  });

  it.each([
    ["interval=30d", "unsupported interval"],
    ["from=2026-09-10&to=2026-09-01", "from after to"],
    ["from=2024-01-01&to=2026-01-01", "range over 366 days"],
    ["from=yesterday", "non-ISO date"],
  ])("rejects %s with 400 (%s)", async (qs) => {
    const res = await request(makeApp()).get(`/api/v1/vaults/${VAULT}/fee-revenue?${qs}`);
    expect(res.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects a malformed contract ID with 400", async () => {
    const res = await request(makeApp()).get("/api/v1/vaults/bad/fee-revenue");
    expect(res.status).toBe(400);
  });
});
