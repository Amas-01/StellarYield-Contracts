import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

const mocks = vi.hoisted(() => ({ getTransferVolume: vi.fn() }));

vi.mock("../../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock("../../services/stellar.js", () => ({
  readTotalAssets: vi.fn(),
  readVaultState: vi.fn(),
  readPaused: vi.fn(),
  readCooperator: vi.fn(),
  readCooperatorFeeBps: vi.fn(),
}));
vi.mock("../../services/sseManager.js", () => ({ sseManager: {} }));
vi.mock("../../services/vault.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/vault.js")>();
  return {
    ...actual,
    VaultService: vi.fn(() => ({ getTransferVolume: mocks.getTransferVolume })),
  };
});

import { vaultsRouter } from "./vaults.js";

function buildApp() {
  const app = express();
  app.use("/api/v1/vaults", vaultsRouter);
  return app;
}

const request = supertest(buildApp());

// The vaults router validates contract ids against /^[A-Z2-7]{55}$/ after a
// leading C, so the happy path needs a well-formed address.
const CONTRACT_ID = `C${"A".repeat(55)}`;
const PATH = `/api/v1/vaults/${CONTRACT_ID}/transfer-volume`;

/** The period the controller forwarded on the most recent request. */
function forwardedPeriod() {
  const calls = mocks.getTransferVolume.mock.calls;
  return calls[calls.length - 1][1];
}

describe("GET /api/v1/vaults/:contractId/transfer-volume (#1074)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTransferVolume.mockResolvedValue({
      period: "7d",
      transferCount: 4,
      totalVolume: "13000",
      uniqueSenders: 3,
      uniqueRecipients: 4,
    });
  });

  it("returns the period, counts and total volume", async () => {
    const res = await request.get(`${PATH}?period=7d`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      period: "7d",
      transferCount: 4,
      totalVolume: "13000",
      uniqueSenders: 3,
      uniqueRecipients: 4,
    });
  });

  it("returns totalVolume as a string, never a number", async () => {
    const res = await request.get(`${PATH}?period=30d`);

    expect(typeof res.body.totalVolume).toBe("string");
  });

  it("keeps a total beyond Number.MAX_SAFE_INTEGER intact over JSON", async () => {
    // A JSON number would arrive at the client already rounded.
    const huge = "170141183460469231731687303715884105727";
    mocks.getTransferVolume.mockResolvedValue({
      period: "30d",
      transferCount: 1,
      totalVolume: huge,
      uniqueSenders: 1,
      uniqueRecipients: 1,
    });

    const res = await request.get(`${PATH}?period=30d`);

    expect(res.body.totalVolume).toBe(huge);
  });

  it("accepts each supported period", async () => {
    for (const period of ["1d", "7d", "30d"]) {
      const res = await request.get(`${PATH}?period=${period}`);
      expect(res.status).toBe(200);
      expect(forwardedPeriod()).toBe(period);
    }
  });

  it("defaults to 7d when no period is given", async () => {
    const res = await request.get(PATH);

    expect(res.status).toBe(200);
    expect(forwardedPeriod()).toBe("7d");
  });

  it("forwards the contract id", async () => {
    await request.get(`${PATH}?period=1d`);

    expect(mocks.getTransferVolume).toHaveBeenCalledWith(CONTRACT_ID, "1d");
  });

  it("returns 400 for an unsupported period rather than widening the window", async () => {
    // Silently defaulting here would report a number the caller did not ask for.
    for (const period of ["14d", "1w", "yesterday", "0d", ""]) {
      const res = await request.get(`${PATH}?period=${period}`);
      expect(res.status).toBe(400);
    }
    expect(mocks.getTransferVolume).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed contract id", async () => {
    const res = await request.get("/api/v1/vaults/not-a-vault/transfer-volume?period=7d");

    expect(res.status).toBe(400);
    expect(mocks.getTransferVolume).not.toHaveBeenCalled();
  });

  it("reports zeros for a vault with no transfers", async () => {
    mocks.getTransferVolume.mockResolvedValue({
      period: "1d",
      transferCount: 0,
      totalVolume: "0",
      uniqueSenders: 0,
      uniqueRecipients: 0,
    });

    const res = await request.get(`${PATH}?period=1d`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      period: "1d",
      transferCount: 0,
      totalVolume: "0",
      uniqueSenders: 0,
      uniqueRecipients: 0,
    });
  });

  it("is not shadowed by the vault detail route", async () => {
    // The detail route is /:contractId; this path has an extra segment and must
    // reach its own handler.
    const res = await request.get(`${PATH}?period=7d`);

    expect(mocks.getTransferVolume).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});
