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
const getLatestLedgerMock = vi.fn();
vi.mock("../../services/stellar.js", () => ({
  readTotalVaults: readTotalVaultsMock,
  getLatestLedger: getLatestLedgerMock,
  getSorobanRpc: vi.fn(() => ({ getLatestLedger: getLatestLedgerMock })),
}));

vi.mock("../../services/sseManager.js", () => ({
  sseManager: { getSseConnectionCount: vi.fn().mockReturnValue(0) },
}));

async function buildApp() {
  const { healthRouter } = await import("./health.js");
  const app = express();
  app.use("/health", healthRouter);
  return app;
}

describe("GET /health factory reachability (#844)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env["VAULT_FACTORY_CONTRACT_ID"] = "";
    getLatestLedgerMock.mockResolvedValue({ sequence: 1000 });
  });

  it("reports reachable: false and contractId: null when unset", async () => {
    delete process.env["VAULT_FACTORY_CONTRACT_ID"];
    const app = await buildApp();
    const res = await supertest(app).get("/health");

    expect(res.body.factory).toEqual({ reachable: false, contractId: null });
    expect(readTotalVaultsMock).not.toHaveBeenCalled();
  });

  it("reports reachable: true when the factory view call succeeds", async () => {
    process.env["VAULT_FACTORY_CONTRACT_ID"] = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    readTotalVaultsMock.mockResolvedValueOnce(5);

    const app = await buildApp();
    const res = await supertest(app).get("/health");

    expect(res.body.factory).toEqual({
      reachable: true,
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("reports reachable: false when the factory view call fails", async () => {
    process.env["VAULT_FACTORY_CONTRACT_ID"] = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    readTotalVaultsMock.mockRejectedValueOnce(new Error("RPC unreachable"));

    const app = await buildApp();
    const res = await supertest(app).get("/health");

    expect(res.body.factory).toEqual({
      reachable: false,
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
  });
});

describe("GET /health RPC latency check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env["VAULT_FACTORY_CONTRACT_ID"] = "";
    getLatestLedgerMock.mockResolvedValue({ sequence: 1000 });
  });

  it("reports rpc.reachable: true and latencyMs as a number when getLatestLedger succeeds", async () => {
    const app = await buildApp();
    const res = await supertest(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.rpc).toBeDefined();
    expect(res.body.rpc.reachable).toBe(true);
    expect(typeof res.body.rpc.latencyMs).toBe("number");
    expect(res.body.rpc.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports rpc.reachable: false and rpc.latencyMs: null when RPC host is unreachable", async () => {
    getLatestLedgerMock.mockRejectedValueOnce(new Error("Connection refused"));

    const app = await buildApp();
    const res = await supertest(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.rpc).toEqual({
      latencyMs: null,
      reachable: false,
    });
  });

  it("reports rpc.reachable: false and rpc.latencyMs: null when getLatestLedger times out", async () => {
    getLatestLedgerMock.mockRejectedValueOnce(new Error("RPC health check timed out"));

    const app = await buildApp();
    const res = await supertest(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.rpc).toEqual({
      latencyMs: null,
      reachable: false,
    });
  });
});


describe("GET /health memory usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env["VAULT_FACTORY_CONTRACT_ID"] = "";
    getLatestLedgerMock.mockResolvedValue({ sequence: 1000 });
  });

  it("reports memory usage with rssBytes, heapUsedBytes, and heapTotalBytes", async () => {
    const app = await buildApp();
    const res = await supertest(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body.memory).toBeDefined();
    expect(typeof res.body.memory.rssBytes).toBe("number");
    expect(typeof res.body.memory.heapUsedBytes).toBe("number");
    expect(typeof res.body.memory.heapTotalBytes).toBe("number");
    expect(res.body.memory.heapUsedBytes).toBeLessThanOrEqual(res.body.memory.heapTotalBytes);
  });

  it("updates memory values on each health poll", async () => {
    const app = await buildApp();
    const res1 = await supertest(app).get("/health");
    const res2 = await supertest(app).get("/health");

    expect(res1.body.memory.heapUsedBytes).toBeLessThanOrEqual(res1.body.memory.heapTotalBytes);
    expect(res2.body.memory.heapUsedBytes).toBeLessThanOrEqual(res2.body.memory.heapTotalBytes);
  });
});

describe("GET /health uptime tracking (#830)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env["VAULT_FACTORY_CONTRACT_ID"] = "";
    getLatestLedgerMock.mockResolvedValue({ sequence: 1000 });
  });

  it("reports uptimeSeconds as a non-negative number", async () => {
    const app = await buildApp();
    const res = await supertest(app).get("/health");

    expect(res.status).toBe(200);
    expect(typeof res.body.uptimeSeconds).toBe("number");
    expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("increases monotonically between successive health checks", async () => {
    const app = await buildApp();
    const res1 = await supertest(app).get("/health");
    const res2 = await supertest(app).get("/health");

    expect(res2.body.uptimeSeconds).toBeGreaterThanOrEqual(res1.body.uptimeSeconds);
  });

  it("resets to a fresh, near-zero value when the module is reloaded (process restart)", async () => {
    const firstApp = await buildApp();
    // Let some time pass so the first process's uptime is clearly non-zero.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const firstRes = await supertest(firstApp).get("/health");
    expect(firstRes.body.uptimeSeconds).toBeGreaterThan(0);

    // vi.resetModules() + re-import simulates a process restart: the module's
    // top-level `process.hrtime.bigint()` capture runs again from scratch.
    vi.resetModules();
    const restartedApp = await buildApp();
    const restartedRes = await supertest(restartedApp).get("/health");

    expect(restartedRes.body.uptimeSeconds).toBeLessThan(firstRes.body.uptimeSeconds);
  });
});

