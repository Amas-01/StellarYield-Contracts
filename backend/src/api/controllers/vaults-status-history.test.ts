import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: { totalCount: 5, idleCount: 5, waitingCount: 0, query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock("pino-http", () => ({ pinoHttp: () => (_req: any, _res: any, next: any) => next() }));

import supertest from "supertest";
import { createApp } from "../../app.js";
import { query } from "../../db/index.js";

const VAULT_CONTRACT = "CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557";
const NEW_MANAGER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

const app = createApp();
const mockQuery = query as ReturnType<typeof vi.fn>;

describe("GET /api/v1/vaults/:contractId/status-history (#1065, #1068)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([]);
  });

  it("returns the full history newest first", async () => {
    mockQuery.mockImplementation((sql: string) =>
      sql.includes("FROM vault_status_history")
        ? Promise.resolve([
            {
              id: 2,
              contract_id: VAULT_CONTRACT,
              event_type: "manager_changed",
              previous_status: null,
              new_status: null,
              previous_manager: null,
              new_manager: NEW_MANAGER,
              changed_at: new Date("2026-02-02T00:00:00.000Z"),
              tx_hash: "tx-2",
              ledger: 6002,
            },
            {
              id: 1,
              contract_id: VAULT_CONTRACT,
              event_type: "status_changed",
              previous_status: "active",
              new_status: "inactive",
              previous_manager: null,
              new_manager: null,
              changed_at: new Date("2026-01-01T00:00:00.000Z"),
              tx_hash: "tx-1",
              ledger: 6001,
            },
          ])
        : Promise.resolve([]),
    );

    const res = await supertest(app).get(`/api/v1/vaults/${VAULT_CONTRACT}/status-history`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data).toEqual([
      {
        id: 2,
        contractId: VAULT_CONTRACT,
        eventType: "manager_changed",
        previousStatus: null,
        newStatus: null,
        previousManager: null,
        newManager: NEW_MANAGER,
        changedAt: "2026-02-02T00:00:00.000Z",
        txHash: "tx-2",
        ledger: 6002,
      },
      {
        id: 1,
        contractId: VAULT_CONTRACT,
        eventType: "status_changed",
        previousStatus: "active",
        newStatus: "inactive",
        previousManager: null,
        newManager: null,
        changedAt: "2026-01-01T00:00:00.000Z",
        txHash: "tx-1",
        ledger: 6001,
      },
    ]);

    const [sql, params] = mockQuery.mock.calls.find(([q]) => String(q).includes("FROM vault_status_history"))!;
    expect(sql).toContain("ORDER BY changed_at DESC, id DESC");
    expect(sql).not.toContain("LIMIT");
    expect(params).toEqual([VAULT_CONTRACT]);
  });

  it("returns an empty list for a vault with no transitions", async () => {
    const res = await supertest(app).get(`/api/v1/vaults/${VAULT_CONTRACT}/status-history`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], total: 0 });
  });

  it("rejects an invalid contract id", async () => {
    const res = await supertest(app).get("/api/v1/vaults/not-a-contract/status-history");

    expect(res.status).toBe(400);
  });
});
