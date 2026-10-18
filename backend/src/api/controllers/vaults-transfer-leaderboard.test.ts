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
import { getVaultTransferLeaderboard } from "./vaults.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/v1/vaults/:contractId/transfer-leaderboard", getVaultTransferLeaderboard);
  return app;
}

const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("GET /api/v1/vaults/:contractId/transfer-leaderboard (#1075)", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns leaderboard sorted by transfer count with signed net volume", async () => {
    (query as any)
      .mockResolvedValueOnce([{ id: 1 }]) // vault exists
      .mockResolvedValueOnce([
        {
          address: "GA11111111111111111111111111111111111111111111111111111111",
          sentCount: 15,
          receivedCount: 5,
          netVolume: "-50000",
        },
        {
          address: "GB22222222222222222222222222222222222222222222222222222222",
          sentCount: 2,
          receivedCount: 8,
          netVolume: "30000",
        },
      ]);

    const res = await request(app).get(`/api/v1/vaults/${VALID_CONTRACT}/transfer-leaderboard`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual({
      address: "GA11111111111111111111111111111111111111111111111111111111",
      sentCount: 15,
      receivedCount: 5,
      netVolume: "-50000",
    });
    expect(res.body[1]).toEqual({
      address: "GB22222222222222222222222222222222222222222222222222222222",
      sentCount: 2,
      receivedCount: 8,
      netVolume: "30000",
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ORDER BY (sent_count + received_count) DESC"),
      [VALID_CONTRACT, 10],
    );
  });

  it("respects custom limit query parameter", async () => {
    (query as any)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([]);

    const res = await request(app).get(
      `/api/v1/vaults/${VALID_CONTRACT}/transfer-leaderboard?limit=5`,
    );

    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("LIMIT $2"),
      [VALID_CONTRACT, 5],
    );
  });

  it("returns 404 when vault is not found", async () => {
    (query as any).mockResolvedValueOnce([]);

    const res = await request(app).get(
      `/api/v1/vaults/${VALID_CONTRACT}/transfer-leaderboard`,
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "NotFound", message: "Vault not found" });
  });

  it("returns 400 for invalid limit parameter", async () => {
    (query as any).mockResolvedValueOnce([{ id: 1 }]);

    const res = await request(app).get(
      `/api/v1/vaults/${VALID_CONTRACT}/transfer-leaderboard?limit=-1`,
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Invalid limit parameter");
  });

  it("returns 400 for invalid contractId format", async () => {
    const res = await request(app).get(
      "/api/v1/vaults/invalid-contract/transfer-leaderboard",
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BadRequest");
  });
});
