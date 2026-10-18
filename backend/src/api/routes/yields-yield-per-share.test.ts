import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

// Mock the data layer so the HTTP stack (routing, Zod validation, controller)
// runs end-to-end without a real database.
const mocks = vi.hoisted(() => ({
  getEpochYieldPerShare: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock("../../services/yield.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/yield.js")>();
  return {
    ...actual,
    YieldService: vi.fn(() => ({
      getEpochYieldPerShare: mocks.getEpochYieldPerShare,
    })),
  };
});

import { yieldsRouter } from "./yields.js";

function buildApp() {
  const app = express();
  app.use("/api/v1/yields", yieldsRouter);
  return app;
}

const request = supertest(buildApp());

const CONTRACT_ID = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";
const PATH = `/api/v1/yields/${CONTRACT_ID}/epochs/3/yield-per-share`;

describe("GET /api/v1/yields/:contractId/epochs/:epochId/yield-per-share (#1071)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEpochYieldPerShare.mockResolvedValue({
      epochId: 3,
      yieldPerShare: "2.500000000000000000",
      decimals: 18,
    });
  });

  it("returns the epoch id, ratio and decimal count", async () => {
    const res = await request.get(PATH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      epochId: 3,
      yieldPerShare: "2.500000000000000000",
      decimals: 18,
    });
  });

  it("returns yieldPerShare as a string, never a number", async () => {
    const res = await request.get(PATH);

    expect(typeof res.body.yieldPerShare).toBe("string");
  });

  it("forwards the contract id and epoch id to the service", async () => {
    await request.get(PATH);

    expect(mocks.getEpochYieldPerShare).toHaveBeenCalledWith(CONTRACT_ID, 3);
  });

  it("coerces a numeric-looking epoch id segment to a number", async () => {
    await request.get(`/api/v1/yields/${CONTRACT_ID}/epochs/42/yield-per-share`);

    expect(mocks.getEpochYieldPerShare).toHaveBeenCalledWith(CONTRACT_ID, 42);
  });

  it("returns 404 for an epoch that does not exist", async () => {
    mocks.getEpochYieldPerShare.mockResolvedValue(null);

    const res = await request.get(PATH);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NotFound");
  });

  it("returns 404 for an epoch that is not yet finalized", async () => {
    // The service reports null for both cases; either way there is no ratio
    // that could be published yet.
    mocks.getEpochYieldPerShare.mockResolvedValue(null);

    const res = await request.get(PATH);

    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-numeric epoch id", async () => {
    const res = await request.get(`/api/v1/yields/${CONTRACT_ID}/epochs/abc/yield-per-share`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    expect(mocks.getEpochYieldPerShare).not.toHaveBeenCalled();
  });

  it("returns 400 for a fractional epoch id", async () => {
    const res = await request.get(`/api/v1/yields/${CONTRACT_ID}/epochs/1.5/yield-per-share`);

    expect(res.status).toBe(400);
  });

  it("returns 400 for a zero or negative epoch id", async () => {
    expect((await request.get(`/api/v1/yields/${CONTRACT_ID}/epochs/0/yield-per-share`)).status).toBe(400);
    expect((await request.get(`/api/v1/yields/${CONTRACT_ID}/epochs/-1/yield-per-share`)).status).toBe(400);
  });

  it("is not shadowed by the single-epoch detail route", async () => {
    // GET /epochs/:epoch would match a 3-segment path only; the extra
    // /yield-per-share segment must reach this handler, not 404 as an
    // unknown epoch detail.
    const res = await request.get(PATH);

    expect(res.status).toBe(200);
  });
});
