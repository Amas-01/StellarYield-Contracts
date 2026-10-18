import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../services/indexerSingleton.js", () => ({
  indexer: {
    isRunning: vi.fn(() => true),
    getLastIndexedLedger: vi.fn(async () => 1000),
    getLastTickAt: vi.fn(() => new Date()),
    getEventsIndexedCount: vi.fn(async () => 42),
    getEventCountsPerContract: vi.fn(async () => [
      {
        contractId: "CAAA",
        totalEvents: 10,
        eventsByType: { deposit: 6, withdraw: 4 },
      },
      {
        contractId: "CBBB",
        totalEvents: 0,
        eventsByType: {},
      },
    ]),
  },
}));

vi.mock("../../db/index.js", () => ({
  query: vi.fn(async () => []),
  pool: {},
  readPool: null,
}));
vi.mock("../../services/jobQueue.js", () => ({ jobQueue: {} }));
vi.mock("../../services/sseManager.js", () => ({ sseManager: {} }));

import { getIndexerEventCounts } from "./admin.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/v1/admin/indexer/event-counts", getIndexerEventCounts);
  return app;
}

describe("GET /api/v1/admin/indexer/event-counts (#1108)", () => {
  const app = makeApp();

  it("returns event counts per contract with totalEvents matching events", async () => {
    const res = await request(app).get("/api/v1/admin/indexer/event-counts");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual({
      contractId: "CAAA",
      totalEvents: 10,
      eventsByType: { deposit: 6, withdraw: 4 },
    });
    expect(res.body[1]).toEqual({
      contractId: "CBBB",
      totalEvents: 0,
      eventsByType: {},
    });
  });
});
