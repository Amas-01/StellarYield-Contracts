import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../db/index.js", () => ({
  query: vi.fn(),
  pool: {},
  readPool: null,
}));
vi.mock("../../services/sseManager.js", () => ({ sseManager: {} }));

import { query } from "../../db/index.js";
import { getVaultTransferFees } from "./vaults.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/v1/vaults/:contractId/transfer-fees", getVaultTransferFees);
  return app;
}

const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("GET /api/v1/vaults/:contractId/transfer-fees (#1076)", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns total transfer fees in date range when from and to are provided", async () => {
    (query as any)
      .mockResolvedValueOnce([{ id: 1 }]) // vault exists
      .mockResolvedValueOnce([{ total_fees: "45000" }]); // sum of transfer_fees

    const res = await request(app).get(
      `/api/v1/vaults/${VALID_CONTRACT}/transfer-fees?from=2026-01-01T00:00:00.000Z&to=2026-01-31T23:59:59.000Z`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      contractId: VALID_CONTRACT,
      totalFees: "45000",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T23:59:59.000Z",
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT COALESCE(SUM(fee_amount), 0)::text AS total_fees"),
      [
        VALID_CONTRACT,
        "2026-01-01T00:00:00.000Z",
        "2026-01-31T23:59:59.000Z",
      ],
    );
  });

  it("returns total fees without date range when filters omitted", async () => {
    (query as any)
      .mockResolvedValueOnce([{ id: 1 }]) // vault exists
      .mockResolvedValueOnce([{ total_fees: "120000" }]); // sum of transfer_fees

    const res = await request(app).get(`/api/v1/vaults/${VALID_CONTRACT}/transfer-fees`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      contractId: VALID_CONTRACT,
      totalFees: "120000",
      from: null,
      to: null,
    });
  });

  it("returns 404 when vault does not exist", async () => {
    (query as any).mockResolvedValueOnce([]); // vault not found

    const res = await request(app).get(`/api/v1/vaults/${VALID_CONTRACT}/transfer-fees`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "NotFound", message: "Vault not found" });
  });

  it("returns 400 for invalid contractId format", async () => {
    const res = await request(app).get("/api/v1/vaults/invalid-contract/transfer-fees");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BadRequest");
  });

  it("returns 400 for invalid date format in from", async () => {
    (query as any).mockResolvedValueOnce([{ id: 1 }]);

    const res = await request(app).get(
      `/api/v1/vaults/${VALID_CONTRACT}/transfer-fees?from=not-a-date`,
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 when from date is after to date", async () => {
    (query as any).mockResolvedValueOnce([{ id: 1 }]);

    const res = await request(app).get(
      `/api/v1/vaults/${VALID_CONTRACT}/transfer-fees?from=2026-05-01&to=2026-01-01`,
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("from must not be after to");
  });
});
