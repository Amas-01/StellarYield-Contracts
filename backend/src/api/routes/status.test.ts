import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

vi.mock("../../db/index.js", () => ({
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  },
}));

const readTotalVaultsMock = vi.fn();
vi.mock("../../services/stellar.js", () => ({
  readTotalVaults: readTotalVaultsMock,
}));

const isRunningMock = vi.fn().mockReturnValue(true);
vi.mock("../../services/indexerSingleton.js", () => ({
  indexer: { isRunning: isRunningMock },
}));

vi.mock("../../config.js", () => ({
  config: {
    stellar: {
      vaultFactoryContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
  },
}));

async function buildApp() {
  const { statusRouter } = await import("./status.js");
  const app = express();
  app.use("/api/status", statusRouter);
  return app;
}

describe("GET /api/status (#917)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    isRunningMock.mockReturnValue(true);
    readTotalVaultsMock.mockResolvedValue(1);
  });

  it("returns operational when all components are healthy", async () => {
    const app = await buildApp();
    const res = await supertest(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("operational");
    expect(res.body.components).toHaveLength(4);
    const names = res.body.components.map((c: { name: string }) => c.name);
    expect(names).toContain("api");
    expect(names).toContain("database");
    expect(names).toContain("indexer");
    expect(names).toContain("rpc");
  });

  it("returns degraded when the database is down", async () => {
    const { pool } = await import("../../db/index.js");
    vi.mocked(pool.query).mockRejectedValueOnce(new Error("connection refused"));

    const app = await buildApp();
    const res = await supertest(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    const db = res.body.components.find((c: { name: string }) => c.name === "database");
    expect(db.status).toBe("degraded");
  });

  it("returns degraded when the indexer is not running", async () => {
    isRunningMock.mockReturnValue(false);

    const app = await buildApp();
    const res = await supertest(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    const idx = res.body.components.find((c: { name: string }) => c.name === "indexer");
    expect(idx.status).toBe("degraded");
  });

  it("returns degraded when the RPC is unreachable", async () => {
    readTotalVaultsMock.mockRejectedValueOnce(new Error("RPC unreachable"));

    const app = await buildApp();
    const res = await supertest(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    const rpc = res.body.components.find((c: { name: string }) => c.name === "rpc");
    expect(rpc.status).toBe("degraded");
  });

  it("api component is always operational when the endpoint responds", async () => {
    const app = await buildApp();
    const res = await supertest(app).get("/api/status");

    const api = res.body.components.find((c: { name: string }) => c.name === "api");
    expect(api.status).toBe("operational");
  });

  it("each component has name, status, and message fields", async () => {
    const app = await buildApp();
    const res = await supertest(app).get("/api/status");

    for (const component of res.body.components) {
      expect(component).toHaveProperty("name");
      expect(component).toHaveProperty("status");
      expect(component).toHaveProperty("message");
    }
  });
});
