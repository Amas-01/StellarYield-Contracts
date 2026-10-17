import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

const h = vi.hoisted(() => ({
  query: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../db/index.js", () => ({
  query: h.query,
  pool: { connect: vi.fn() },
}));

import { getAdminAuditLog } from "./admin.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/v1/admin/audit-log", getAdminAuditLog);
  return app;
}

describe("Admin Audit Log - Filtering and Pagination (#1279)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("combines action, actor, from, and to filters with AND logic", async () => {
    h.query
      .mockResolvedValueOnce([{ count: "1" }])
      .mockResolvedValueOnce([
        {
          id: 5,
          api_key_label: "ops-lead",
          action: "delete_user",
          target: "/api/v1/admin/users/GXYZ",
          ip_address: "1.2.3.4",
          request_body_hash: "hash123",
          details: { reason: "requested" },
          created_at: new Date("2026-06-01T12:00:00.000Z"),
        },
      ]);

    const res = await supertest(buildApp()).get(
      "/api/v1/admin/audit-log?action=delete_user&actor=ops-lead&from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z&limit=10",
    );

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].actor).toBe("ops-lead");
    expect(res.body.data[0].action).toBe("delete_user");
    expect(res.body.data[0].details).toEqual({ reason: "requested" });

    // Verify count query combined filters with AND
    const countCall = h.query.mock.calls[0];
    expect(countCall[0]).toContain(
      "WHERE action = $1 AND api_key_label = $2 AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz",
    );
    expect(countCall[1]).toEqual([
      "delete_user",
      "ops-lead",
      "2026-06-01T00:00:00Z",
      "2026-06-02T00:00:00Z",
    ]);

    // Verify select query combined filters with AND
    const selectCall = h.query.mock.calls[1];
    expect(selectCall[0]).toContain(
      "WHERE action = $1 AND api_key_label = $2 AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz",
    );
  });

  it("supports stable cursor pagination and issues nextCursor", async () => {
    const row1 = {
      id: 10,
      api_key_label: "admin",
      action: "pause_vault",
      target: "/api/v1/admin/vaults/C1",
      ip_address: "1.1.1.1",
      request_body_hash: "hash1",
      details: null,
      created_at: new Date("2026-06-01T10:00:00.000Z"),
    };
    const row2 = {
      id: 9,
      api_key_label: "admin",
      action: "resume_vault",
      target: "/api/v1/admin/vaults/C1",
      ip_address: "1.1.1.1",
      request_body_hash: "hash2",
      details: null,
      created_at: new Date("2026-06-01T09:00:00.000Z"),
    };
    const row3Extra = {
      id: 8,
      api_key_label: "admin",
      action: "delete_user",
      target: "/api/v1/admin/users/G1",
      ip_address: "1.1.1.1",
      request_body_hash: "hash3",
      details: null,
      created_at: new Date("2026-06-01T08:00:00.000Z"),
    };

    h.query
      .mockResolvedValueOnce([{ count: "3" }])
      // Returns 3 rows for limit=2 to calculate nextCursor
      .mockResolvedValueOnce([row1, row2, row3Extra]);

    const res = await supertest(buildApp()).get("/api/v1/admin/audit-log?limit=2");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.nextCursor).toBeDefined();
    expect(res.headers["x-next-cursor"]).toBe(res.body.nextCursor);

    // Now query page 2 using the cursor
    const cursor = res.body.nextCursor;
    h.query
      .mockResolvedValueOnce([{ count: "3" }])
      .mockResolvedValueOnce([row3Extra]);

    const page2Res = await supertest(buildApp()).get(
      `/api/v1/admin/audit-log?limit=2&cursor=${cursor}`,
    );
    expect(page2Res.status).toBe(200);
    expect(page2Res.body.data).toHaveLength(1);
    expect(page2Res.body.data[0].id).toBe(8);
    expect(page2Res.body.nextCursor).toBeNull();

    // Verify cursor keyset seek condition
    const selectCall = h.query.mock.calls[3];
    expect(selectCall[0]).toContain("(created_at, id) < ($1::timestamptz, $2)");
  });
});
