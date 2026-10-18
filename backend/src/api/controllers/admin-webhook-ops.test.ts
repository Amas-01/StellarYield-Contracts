import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), send: vi.fn() }));

vi.mock("../../db/index.js", () => ({
  query: mocks.query,
  pool: { totalCount: 0, idleCount: 0, waitingCount: 0, options: { max: 1 } },
  readPool: null,
}));
vi.mock("../../services/jobQueue.js", () => ({
  jobQueue: { send: mocks.send, start: vi.fn(), stop: vi.fn(), getJob: vi.fn(), getFailedJobs: vi.fn() },
}));
vi.mock("../../services/indexerSingleton.js", () => ({
  indexer: {
    isRunning: vi.fn().mockReturnValue(false),
    getLastIndexedLedger: vi.fn().mockResolvedValue(0),
    getLastTickAt: vi.fn().mockReturnValue(null),
    getEventsIndexedCount: vi.fn().mockResolvedValue(0),
    queueBackfill: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../services/vault.js", () => ({
  VaultService: vi.fn().mockImplementation(() => ({
    listArchivedVaults: vi.fn().mockResolvedValue([]),
    getVault: vi.fn().mockResolvedValue(null),
  })),
}));
vi.mock("../../services/stellar.js", () => ({ readTotalSupply: vi.fn().mockResolvedValue(0n) }));

async function ctx() {
  const admin = await import("./admin.js");
  return { query: mocks.query, send: mocks.send, admin };
}

function makeRes() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
}

const PAYLOAD = '{"event":"deposit","data":{"amount":"1"}}';

describe("webhook admin endpoints (#1061, #1062, #1063)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("POST /admin/webhooks/:id/circuit-reset", () => {
    it("closes the circuit and clears the failure counter", async () => {
      const { query, admin } = await ctx();
      query.mockResolvedValueOnce([{ id: 3, circuit_open: false }]);

      const res = makeRes();
      await admin.resetWebhookCircuit({ params: { id: "3" }, headers: {}, body: {} } as any, res, vi.fn());

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("circuit_open = FALSE"),
        [3],
      );
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("consecutive_failures = 0"),
        [3],
      );
      expect(res.json).toHaveBeenCalledWith({ id: 3, circuitOpen: false, consecutiveFailures: 0 });
    });

    it("audits the reset", async () => {
      const { query, admin } = await ctx();
      query.mockResolvedValueOnce([{ id: 3, circuit_open: false }]);

      await admin.resetWebhookCircuit({ params: { id: "3" }, headers: {}, body: {} } as any, makeRes(), vi.fn());

      const audit = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO admin_audit_log"));
      expect(audit?.[1]).toContain("webhook_circuit_reset");
    });

    it("404s when the webhook does not exist", async () => {
      const { query, admin } = await ctx();
      query.mockResolvedValueOnce([]);

      const res = makeRes();
      await admin.resetWebhookCircuit({ params: { id: "99" }, headers: {}, body: {} } as any, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it("400s on a non-numeric id without querying", async () => {
      const { query, admin } = await ctx();

      const res = makeRes();
      await admin.resetWebhookCircuit({ params: { id: "abc" }, headers: {}, body: {} } as any, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("POST /admin/webhooks/:id/rotate-secret", () => {
    it("stores the new secret and demotes the old one", async () => {
      const { query, admin } = await ctx();
      query.mockResolvedValueOnce([{ id: 4, had_secret: true }]);

      const res = makeRes();
      await admin.rotateWebhookSecret({ params: { id: "4" }, headers: {}, body: {} } as any, res, vi.fn());

      const sql: string = query.mock.calls[0][0];
      expect(sql).toContain("previous_secret = secret");
      expect(sql).toContain("secret = $1");
      expect(sql).toContain("secret_rotated_at = NOW()");

      const body = res.json.mock.calls[0][0];
      expect(body.secret).toHaveLength(64);
      expect(body.previousSecretRetained).toBe(true);
      expect(body.rotationWindowHours).toBe(24);
      expect(query.mock.calls[0][1][1]).toBe(4);
    });

    it("never echoes the previous secret", async () => {
      const { query, admin } = await ctx();
      query.mockResolvedValueOnce([{ id: 4, had_secret: true }]);

      const res = makeRes();
      await admin.rotateWebhookSecret({ params: { id: "4" }, headers: {}, body: {} } as any, res, vi.fn());

      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain("previousSecret\":");
      expect(res.json.mock.calls[0][0]).not.toHaveProperty("oldSecret");
    });

    it("404s when the webhook does not exist", async () => {
      const { query, admin } = await ctx();
      query.mockResolvedValueOnce([]);

      const res = makeRes();
      await admin.rotateWebhookSecret({ params: { id: "42" }, headers: {}, body: {} } as any, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe("POST /admin/webhooks/deliveries/:deliveryId/replay", () => {
    it("creates a new delivery referencing the source and re-enqueues it", async () => {
      const { query, send, admin } = await ctx();
      query.mockImplementation((sql: string) => {
        if (sql.includes("FROM webhook_deliveries wd")) {
          return Promise.resolve([
            { id: 11, webhook_id: 2, payload: PAYLOAD, circuit_open: false, active: true },
          ]);
        }
        if (sql.includes("INSERT INTO webhook_deliveries")) {
          return Promise.resolve([{ id: 77 }]);
        }
        return Promise.resolve([]);
      });

      const res = makeRes();
      await admin.replayWebhookDelivery(
        { params: { deliveryId: "11" }, headers: {}, body: {} } as any,
        res,
        vi.fn(),
      );

      const insert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO webhook_deliveries"));
      expect(insert?.[1]).toEqual([2, PAYLOAD, 11]);

      expect(send).toHaveBeenCalledWith("webhook-deliver", {
        webhookId: 2,
        payload: PAYLOAD,
        deliveryId: 77,
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        deliveryId: 77,
        replayedFrom: 11,
        webhookId: 2,
        status: "queued",
      });
    });

    it("audits the replay", async () => {
      const { query, send, admin } = await ctx();
      query.mockImplementation((sql: string) => {
        if (sql.includes("FROM webhook_deliveries wd")) {
          return Promise.resolve([
            { id: 11, webhook_id: 2, payload: PAYLOAD, circuit_open: false, active: true },
          ]);
        }
        if (sql.includes("INSERT INTO webhook_deliveries")) return Promise.resolve([{ id: 77 }]);
        return Promise.resolve([]);
      });

      await admin.replayWebhookDelivery(
        { params: { deliveryId: "11" }, headers: {}, body: {} } as any,
        makeRes(),
        vi.fn(),
      );

      const audit = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO admin_audit_log"));
      expect(audit?.[1]).toContain("webhook_replay_delivery");
      expect(send).toHaveBeenCalled();
    });

    it("404s when the source delivery does not exist", async () => {
      const { query, send, admin } = await ctx();
      query.mockResolvedValueOnce([]);

      const res = makeRes();
      await admin.replayWebhookDelivery(
        { params: { deliveryId: "404" }, headers: {}, body: {} } as any,
        res,
        vi.fn(),
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(send).not.toHaveBeenCalled();
    });

    it("409s when the endpoint circuit is open (#1061)", async () => {
      const { query, send, admin } = await ctx();
      query.mockResolvedValueOnce([
        { id: 11, webhook_id: 2, payload: PAYLOAD, circuit_open: true, active: true },
      ]);

      const res = makeRes();
      await admin.replayWebhookDelivery(
        { params: { deliveryId: "11" }, headers: {}, body: {} } as any,
        res,
        vi.fn(),
      );

      expect(res.status).toHaveBeenCalledWith(409);
      expect(send).not.toHaveBeenCalled();
    });

    it("400s on a non-numeric delivery id without querying", async () => {
      const { query, admin } = await ctx();

      const res = makeRes();
      await admin.replayWebhookDelivery(
        { params: { deliveryId: "nope" }, headers: {}, body: {} } as any,
        res,
        vi.fn(),
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(query).not.toHaveBeenCalled();
    });
  });
});
