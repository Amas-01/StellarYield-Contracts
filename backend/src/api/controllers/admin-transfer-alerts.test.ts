import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../db/index.js", () => ({
  query: vi.fn(),
  pool: {},
  readPool: null,
}));
vi.mock("../../services/indexerSingleton.js", () => ({ indexer: {} }));
vi.mock("../../services/jobQueue.js", () => ({ jobQueue: {} }));
vi.mock("../../services/sseManager.js", () => ({ sseManager: {} }));

import { query } from "../../db/index.js";
import { getTransferAlerts, acknowledgeTransferAlert } from "./admin.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/v1/admin/transfer-alerts", getTransferAlerts);
  app.patch("/api/v1/admin/transfer-alerts/:id/acknowledge", acknowledgeTransferAlert);
  return app;
}

describe("Admin Transfer Alerts (#1077, #1078)", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/v1/admin/transfer-alerts", () => {
    it("returns unacknowledged transfer alerts by default", async () => {
      const now = new Date();
      (query as any).mockResolvedValueOnce([
        {
          id: 1,
          vault_id: 10,
          contract_id: "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
          type: "VELOCITY_SPIKE",
          amount: null,
          from_address: null,
          to_address: null,
          tx_hash: null,
          details: { transferCount: 600, threshold: 500 },
          created_at: now,
          acknowledged_at: null,
        },
        {
          id: 2,
          vault_id: 10,
          contract_id: "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
          type: "LARGE_TRANSFER",
          amount: "5000000",
          from_address: "GA1",
          to_address: "GB2",
          tx_hash: "tx-123",
          details: { amount: "5000000", threshold: "1000000" },
          created_at: now,
          acknowledged_at: null,
        },
      ]);

      const res = await request(app).get("/api/v1/admin/transfer-alerts");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toEqual({
        id: 1,
        vaultId: 10,
        contractId: "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
        type: "VELOCITY_SPIKE",
        amount: null,
        fromAddress: null,
        toAddress: null,
        txHash: null,
        details: { transferCount: 600, threshold: 500 },
        createdAt: now.toISOString(),
        acknowledgedAt: null,
      });
      expect(res.body[1]).toEqual({
        id: 2,
        vaultId: 10,
        contractId: "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
        type: "LARGE_TRANSFER",
        amount: "5000000",
        fromAddress: "GA1",
        toAddress: "GB2",
        txHash: "tx-123",
        details: { amount: "5000000", threshold: "1000000" },
        createdAt: now.toISOString(),
        acknowledgedAt: null,
      });

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE acknowledged_at IS NULL"),
      );
    });

    it("queries acknowledged alerts when acknowledged=true", async () => {
      (query as any).mockResolvedValueOnce([]);

      const res = await request(app).get("/api/v1/admin/transfer-alerts?acknowledged=true");

      expect(res.status).toBe(200);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE acknowledged_at IS NOT NULL"),
      );
    });
  });

  describe("PATCH /api/v1/admin/transfer-alerts/:id/acknowledge", () => {
    it("marks alert as acknowledged and returns updated alert with acknowledgedAt timestamp", async () => {
      const now = new Date();
      (query as any).mockResolvedValueOnce([
        {
          id: 5,
          vault_id: 10,
          contract_id: "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
          type: "LARGE_TRANSFER",
          amount: "2000000",
          from_address: "GA1",
          to_address: "GB2",
          tx_hash: "tx-456",
          details: { amount: "2000000", threshold: "1000000" },
          created_at: now,
          acknowledged_at: now,
        },
      ]);

      const res = await request(app).patch("/api/v1/admin/transfer-alerts/5/acknowledge");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: 5,
        vaultId: 10,
        contractId: "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B",
        type: "LARGE_TRANSFER",
        amount: "2000000",
        fromAddress: "GA1",
        toAddress: "GB2",
        txHash: "tx-456",
        details: { amount: "2000000", threshold: "1000000" },
        createdAt: now.toISOString(),
        acknowledgedAt: now.toISOString(),
      });

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE transfer_alerts"),
        [5],
      );
    });

    it("returns 404 when alert ID is not found", async () => {
      (query as any).mockResolvedValueOnce([]);

      const res = await request(app).patch("/api/v1/admin/transfer-alerts/999/acknowledge");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Transfer alert not found" });
    });

    it("returns 400 when alert ID is not a valid positive integer", async () => {
      const res = await request(app).patch("/api/v1/admin/transfer-alerts/not-a-number/acknowledge");

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Invalid alert id" });
    });
  });
});
