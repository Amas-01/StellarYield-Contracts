import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({ listForVault: vi.fn() }));

vi.mock("../../db/index.js", () => ({
  query: vi.fn(),
  pool: {},
  readPool: null,
}));
vi.mock("../../services/indexerSingleton.js", () => ({ indexer: {} }));
vi.mock("../../services/jobQueue.js", () => ({ jobQueue: {} }));
vi.mock("../../services/sseManager.js", () => ({ sseManager: {} }));
vi.mock("../../services/epochAnomaly.js", () => ({
  EpochAnomalyService: vi.fn(() => ({ listForVault: mocks.listForVault })),
}));

import { getEpochAnomalies } from "./admin.js";

// The admin routes validate the address with /^[A-Z2-7]{55}$/ after a leading C,
// so this must be a well-formed contract id for the happy-path tests to run.
const CONTRACT_ID = `C${"A".repeat(55)}`;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/v1/admin/vaults/:contractId/epoch-anomalies", getEpochAnomalies);
  return app;
}

/** A recorded anomaly as the service returns it. */
function anomaly(overrides: Record<string, unknown> = {}) {
  return {
    vaultId: CONTRACT_ID,
    epochId: 11,
    yieldAmount: "5000",
    meanYield: "1000",
    stddevYield: "10",
    sampleSize: 30,
    zScore: "400.0000000000000000",
    detectedAt: "2025-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("GET /api/v1/admin/vaults/:contractId/epoch-anomalies (#1073)", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listForVault.mockResolvedValue([]);
  });

  it("returns the recorded anomalies", async () => {
    mocks.listForVault.mockResolvedValue([anomaly()]);

    const res = await request(app).get(`/api/v1/admin/vaults/${CONTRACT_ID}/epoch-anomalies`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      epochId: 11,
      yieldAmount: "5000",
      meanYield: "1000",
      zScore: "400.0000000000000000",
    });
  });

  it("returns an empty array for a vault with no anomalies", async () => {
    const res = await request(app).get(`/api/v1/admin/vaults/${CONTRACT_ID}/epoch-anomalies`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("scopes the lookup to the requested vault", async () => {
    await request(app).get(`/api/v1/admin/vaults/${CONTRACT_ID}/epoch-anomalies`);

    expect(mocks.listForVault).toHaveBeenCalledWith(CONTRACT_ID, 100);
  });

  it("honours an explicit limit", async () => {
    await request(app).get(`/api/v1/admin/vaults/${CONTRACT_ID}/epoch-anomalies?limit=25`);

    expect(mocks.listForVault).toHaveBeenCalledWith(CONTRACT_ID, 25);
  });

  it("clamps a limit above the cap instead of trusting it", async () => {
    await request(app).get(`/api/v1/admin/vaults/${CONTRACT_ID}/epoch-anomalies?limit=100000`);

    expect(mocks.listForVault).toHaveBeenCalledWith(CONTRACT_ID, 500);
  });

  it("clamps a zero or negative limit to one row", async () => {
    await request(app).get(`/api/v1/admin/vaults/${CONTRACT_ID}/epoch-anomalies?limit=0`);

    expect(mocks.listForVault).toHaveBeenCalledWith(CONTRACT_ID, 1);
  });

  it("falls back to the default when the limit is not a number", async () => {
    await request(app).get(`/api/v1/admin/vaults/${CONTRACT_ID}/epoch-anomalies?limit=abc`);

    expect(mocks.listForVault).toHaveBeenCalledWith(CONTRACT_ID, 100);
  });

  it("returns 400 for a malformed contract id", async () => {
    const res = await request(app).get("/api/v1/admin/vaults/not-an-address/epoch-anomalies");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BadRequest");
    expect(mocks.listForVault).not.toHaveBeenCalled();
  });

  it("keeps large yields as strings so the client is not handed a rounded number", async () => {
    const huge = "170141183460469231731687303715884105727";
    mocks.listForVault.mockResolvedValue([anomaly({ yieldAmount: huge })]);

    const res = await request(app).get(`/api/v1/admin/vaults/${CONTRACT_ID}/epoch-anomalies`);

    expect(res.body[0].yieldAmount).toBe(huge);
  });

  it("surfaces a null z-score for a flat-window deviation rather than omitting it", async () => {
    mocks.listForVault.mockResolvedValue([anomaly({ stddevYield: "0", zScore: null })]);

    const res = await request(app).get(`/api/v1/admin/vaults/${CONTRACT_ID}/epoch-anomalies`);

    expect(res.body[0].zScore).toBeNull();
  });
});
