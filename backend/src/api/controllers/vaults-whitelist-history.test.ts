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
const INVESTOR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const ADMIN = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM965NN6IBHRVWFJBY6XHYTCFOGG";

const app = createApp();
const mockQuery = query as ReturnType<typeof vi.fn>;

function row(address: string, action: string, createdAt: string, ledger: number) {
  return {
    address,
    action,
    tx_hash: `tx-${ledger}`,
    ledger,
    created_at: new Date(createdAt),
  };
}

describe("GET /api/v1/vaults/:contractId/whitelist-history (#1094)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([]);
  });

  it("returns whitelist events newest first", async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM whitelist_events") && sql.includes("COUNT")) {
        return Promise.resolve([{ count: "2" }]);
      }
      if (sql.includes("FROM whitelist_events")) {
        return Promise.resolve([
          row(INVESTOR, "removed", "2026-02-02T00:00:00.000Z", 5002),
          row(ADMIN, "added", "2026-01-01T00:00:00.000Z", 5001),
        ]);
      }
      return Promise.resolve([]);
    });

    const res = await supertest(app).get(`/api/v1/vaults/${VAULT_CONTRACT}/whitelist-history`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
    expect(res.body.data).toEqual([
      {
        address: INVESTOR,
        action: "removed",
        txHash: "tx-5002",
        ledger: 5002,
        createdAt: "2026-02-02T00:00:00.000Z",
      },
      {
        address: ADMIN,
        action: "added",
        txHash: "tx-5001",
        ledger: 5001,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const [sql, params] = mockQuery.mock.calls.find(([q]) => String(q).includes("FROM whitelist_events") && !String(q).includes("COUNT"))!;
    expect(sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(params).toEqual([VAULT_CONTRACT, 20, 0]);
  });

  it("returns an empty list for a vault that never changed its whitelist", async () => {
    mockQuery.mockImplementation((sql: string) =>
      sql.includes("COUNT") ? Promise.resolve([{ count: "0" }]) : Promise.resolve([]),
    );

    const res = await supertest(app).get(`/api/v1/vaults/${VAULT_CONTRACT}/whitelist-history`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], total: 0, page: 1, pageSize: 20 });
  });

  it("paginates", async () => {
    mockQuery.mockImplementation((sql: string) =>
      sql.includes("COUNT") ? Promise.resolve([{ count: "45" }]) : Promise.resolve([]),
    );

    const res = await supertest(app).get(`/api/v1/vaults/${VAULT_CONTRACT}/whitelist-history?page=3&pageSize=10`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], total: 45, page: 3, pageSize: 10 });
    const [sql, params] = mockQuery.mock.calls.find(([q]) => String(q).includes("FROM whitelist_events") && !String(q).includes("COUNT"))!;
    expect(sql).toContain("LIMIT $2 OFFSET $3");
    expect(params).toEqual([VAULT_CONTRACT, 10, 20]);
  });

  it("caps pageSize at 100", async () => {
    const res = await supertest(app).get(`/api/v1/vaults/${VAULT_CONTRACT}/whitelist-history?pageSize=5000`);

    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(100);
  });

  it("rejects an invalid contract id", async () => {
    const res = await supertest(app).get("/api/v1/vaults/not-a-contract/whitelist-history");

    expect(res.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects a page below 1", async () => {
    const res = await supertest(app).get(`/api/v1/vaults/${VAULT_CONTRACT}/whitelist-history?page=0`);

    expect(res.status).toBe(400);
  });
});
