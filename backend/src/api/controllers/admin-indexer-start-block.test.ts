import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../../services/indexerSingleton.js", () => ({
  indexer: {
    isRunning: vi.fn().mockReturnValue(false),
    getLastIndexedLedger: vi.fn().mockResolvedValue(0),
    getStartLedgerConfig: vi.fn().mockResolvedValue({ startBlock: 0, source: "environment" }),
    saveStartLedgerConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { indexer } = await import("../../services/indexerSingleton.js");
  const { getIndexerStartBlock, updateIndexerStartBlock } = await import("./admin.js");
  return {
    query: query as ReturnType<typeof vi.fn>,
    indexer: indexer as unknown as Record<string, ReturnType<typeof vi.fn>>,
    getIndexerStartBlock,
    updateIndexerStartBlock,
  };
}

function makeRes() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
}

function makeReq(body: unknown = {}) {
  return { body, params: {}, query: {}, headers: {} } as any;
}

describe("Indexer start-block configuration (#1105)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("GET /api/v1/admin/indexer/start-block", () => {
    it("reports the database-configured block as active while the cursor has not moved", async () => {
      const { indexer, getIndexerStartBlock } = await getTestContext();
      indexer["getStartLedgerConfig"]!.mockResolvedValue({ startBlock: 4_000_000, source: "database" });
      indexer["getLastIndexedLedger"]!.mockResolvedValue(0);
      const res = makeRes();

      await getIndexerStartBlock({} as any, res, vi.fn());

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ startBlock: 4_000_000, source: "database", lastLedger: 0, active: true }),
      );
    });

    it("falls back to the env var when the block was never configured", async () => {
      const { indexer, getIndexerStartBlock } = await getTestContext();
      indexer["getStartLedgerConfig"]!.mockResolvedValue({ startBlock: 12, source: "environment" });
      indexer["getLastIndexedLedger"]!.mockResolvedValue(900);
      const res = makeRes();

      await getIndexerStartBlock({} as any, res, vi.fn());

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ startBlock: 12, source: "environment", lastLedger: 900, active: false }),
      );
    });
  });

  describe("PUT /api/v1/admin/indexer/start-block", () => {
    it("persists the new block, audits the change and leaves the cursor alone", async () => {
      const { query, indexer, updateIndexerStartBlock } = await getTestContext();
      indexer["getLastIndexedLedger"]!.mockResolvedValue(500);
      const res = makeRes();

      await updateIndexerStartBlock(makeReq({ startBlock: 250 }), res, vi.fn());

      expect(indexer["saveStartLedgerConfig"]!).toHaveBeenCalledWith(250);
      expect(indexer["saveStartLedgerConfig"]!).not.toHaveBeenCalledWith(500);
      const auditSql: string = query.mock.calls[0][0];
      expect(auditSql).toContain("INSERT INTO admin_audit_log");
      expect(query.mock.calls[0][1]).toContain("update_indexer_start_block");
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ startBlock: 250, source: "database", lastLedger: 500, active: false }),
      );
    });

    it("rejects a block ahead of the current cursor without writing", async () => {
      const { indexer, updateIndexerStartBlock } = await getTestContext();
      indexer["getLastIndexedLedger"]!.mockResolvedValue(100);
      const res = makeRes();

      await updateIndexerStartBlock(makeReq({ startBlock: 101 }), res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: "BadRequest",
        message: "startBlock must not be ahead of the current indexer cursor (100)",
      });
      expect(indexer["saveStartLedgerConfig"]!).not.toHaveBeenCalled();
    });

    it.each([
      [{ startBlock: -1 }, "negative"],
      [{ startBlock: 1.5 }, "fractional"],
      [{ startBlock: "10" }, "string"],
      [{}, "missing"],
    ])("rejects %j with 400 (%s)", async (body) => {
      const { indexer, updateIndexerStartBlock } = await getTestContext();
      const res = makeRes();

      await updateIndexerStartBlock(makeReq(body), res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(indexer["saveStartLedgerConfig"]!).not.toHaveBeenCalled();
    });
  });
});
