import { vi, describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Issues #1106 (event-type filter) and #1107 (per-contract pause/resume).

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../db/index.js", () => ({ query: mocks.query, pool: {}, readPool: null }));
vi.mock("../../services/indexerSingleton.js", () => ({ indexer: {} }));
vi.mock("../../services/jobQueue.js", () => ({ jobQueue: {} }));
vi.mock("../../services/sseManager.js", () => ({ sseManager: {} }));

import {
  pauseContractIndexing,
  resumeContractIndexing,
  setContractEventFilter,
} from "./admin.js";

const VAULT = "C" + "A".repeat(55);
const UPDATED_AT = "2026-09-26T12:00:00.000Z";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post("/api/v1/admin/indexer/:contractId/pause", pauseContractIndexing);
  app.post("/api/v1/admin/indexer/:contractId/resume", resumeContractIndexing);
  app.patch("/api/v1/admin/indexer/:contractId/event-filter", setContractEventFilter);
  return app;
}

const stateRow = (overrides: Record<string, unknown> = {}) => ({
  contract_id: VAULT,
  indexing_paused: false,
  allowed_event_types: [],
  updated_at: UPDATED_AT,
  ...overrides,
});

/** vault lookup → upsert → audit log insert */
function mockUpsert(row: Record<string, unknown>) {
  mocks.query
    .mockResolvedValueOnce([{ id: 1 }])
    .mockResolvedValueOnce([row])
    .mockResolvedValueOnce([]);
}

const upsertCall = () => mocks.query.mock.calls[1] as [string, unknown[]];

beforeEach(() => mocks.query.mockReset());

describe("POST /api/v1/admin/indexer/:contractId/pause (#1107)", () => {
  it("sets indexing_paused and records the ledger it was paused at", async () => {
    mockUpsert(stateRow({ indexing_paused: true }));

    const res = await request(makeApp()).post(`/api/v1/admin/indexer/${VAULT}/pause`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ contractId: VAULT, indexingPaused: true, allowedTypes: [], updatedAt: UPDATED_AT });
    const [sql, params] = upsertCall();
    expect(params).toEqual([VAULT]);
    expect(sql).toContain("indexing_paused = TRUE");
    expect(sql).toContain("SELECT last_ledger FROM indexer_state");
    // Re-pausing keeps the original ledger so the replay does not skip events.
    expect(sql).toContain("COALESCE(indexer_contract_state.paused_at_ledger");
    expect(mocks.query.mock.calls[2][1]).toContain("pause_contract_indexing");
  });

  it("returns 404 for a contract that is not indexed", async () => {
    mocks.query.mockResolvedValueOnce([]);
    const res = await request(makeApp()).post(`/api/v1/admin/indexer/${VAULT}/pause`);
    expect(res.status).toBe(404);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for a malformed contract ID", async () => {
    const res = await request(makeApp()).post("/api/v1/admin/indexer/not-a-contract/pause");
    expect(res.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/admin/indexer/:contractId/resume (#1107)", () => {
  it("clears indexing_paused and leaves the pause ledger for the replay", async () => {
    mockUpsert(stateRow());

    const res = await request(makeApp()).post(`/api/v1/admin/indexer/${VAULT}/resume`);

    expect(res.status).toBe(200);
    expect(res.body.indexingPaused).toBe(false);
    const [sql] = upsertCall();
    expect(sql).toContain("indexing_paused = FALSE");
    expect(sql).not.toContain("paused_at_ledger = NULL");
  });
});

describe("PATCH /api/v1/admin/indexer/:contractId/event-filter (#1106)", () => {
  it("stores the allowed types, de-duplicated", async () => {
    mockUpsert(stateRow({ allowed_event_types: ["deposit", "withdraw"] }));

    const res = await request(makeApp())
      .patch(`/api/v1/admin/indexer/${VAULT}/event-filter`)
      .send({ allowedTypes: ["deposit", "withdraw", "deposit"] });

    expect(res.status).toBe(200);
    expect(res.body.allowedTypes).toEqual(["deposit", "withdraw"]);
    expect(upsertCall()[1]).toEqual([VAULT, ["deposit", "withdraw"]]);
  });

  it("accepts an empty list to remove the filter", async () => {
    mockUpsert(stateRow());

    const res = await request(makeApp())
      .patch(`/api/v1/admin/indexer/${VAULT}/event-filter`)
      .send({ allowedTypes: [] });

    expect(res.status).toBe(200);
    expect(res.body.allowedTypes).toEqual([]);
    expect(upsertCall()[1]).toEqual([VAULT, []]);
  });

  it.each([
    [{}],
    [{ allowedTypes: "deposit" }],
    [{ allowedTypes: ["not_an_event"] }],
    [{ allowedTypes: [""] }],
  ])("rejects body %j with 400", async (body) => {
    const res = await request(makeApp())
      .patch(`/api/v1/admin/indexer/${VAULT}/event-filter`)
      .send(body);
    expect(res.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
