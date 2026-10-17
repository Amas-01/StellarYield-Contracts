import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

const h = vi.hoisted(() => ({
  batches: [] as unknown[][],
  lastCreatedCursor: null as any,
  release: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("pg-cursor", () => {
  class FakeCursor {
    public sql: string;
    public values: unknown[];
    constructor(sql: string, values: unknown[]) {
      this.sql = sql;
      this.values = values;
      h.lastCreatedCursor = this;
    }
    read = vi.fn().mockImplementation(async () => h.batches.shift() ?? []);
    close = h.close;
  }
  return { default: FakeCursor };
});

vi.mock("../../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: {
    connect: vi.fn().mockResolvedValue({
      query: (cursor: unknown) => cursor,
      release: h.release,
    }),
  },
}));

vi.mock("../../services/adminAuditLog.js", () => ({
  logAdminAudit: vi.fn().mockResolvedValue(undefined),
}));

import { exportAdminAuditLogCsv } from "./admin.js";

function buildApp() {
  const app = express();
  app.get("/api/v1/admin/audit-log/export.csv", exportAdminAuditLogCsv);
  return app;
}

describe("Admin Audit Log CSV Export (#1280)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.batches = [
      [
        {
          created_at: new Date("2026-06-01T12:00:00.000Z"),
          actor: "ops-lead",
          action: "delete_user",
          target: "/api/v1/admin/users/GXYZ",
          details: { reason: "Requested by compliance, GDPR" },
        },
        {
          created_at: new Date("2026-06-01T11:00:00.000Z"),
          actor: "system-admin",
          action: "pause_vault",
          target: "/api/v1/admin/vaults/C123",
          details: "manual maintenance",
        },
      ],
      [],
    ];
  });

  it("streams valid CSV with header and RFC 4180 escaped fields", async () => {
    const res = await supertest(buildApp()).get("/api/v1/admin/audit-log/export.csv");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/audit-log\.csv/);
    expect(res.headers["transfer-encoding"]).toBe("chunked");

    const lines = res.text.trim().split("\n");
    expect(lines[0]).toBe("timestamp,actor,action,target,details");
    expect(lines[1]).toContain("2026-06-01T12:00:00.000Z,ops-lead,delete_user,/api/v1/admin/users/GXYZ");
    // Escaped JSON detail field contains comma and quotes properly escaped
    expect(res.text).toContain('"{\\"reason\\":\\"Requested by compliance, GDPR\\"}"');
    expect(lines[2]).toContain("2026-06-01T11:00:00.000Z,system-admin,pause_vault,/api/v1/admin/vaults/C123,manual maintenance");
  });

  it("applies action, actor, from, and to filters to cursor query", async () => {
    await supertest(buildApp()).get(
      "/api/v1/admin/audit-log/export.csv?action=delete_user&actor=ops-lead&from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z",
    );

    expect(h.lastCreatedCursor).toBeDefined();
    expect(h.lastCreatedCursor.sql).toContain(
      "WHERE action = $1 AND api_key_label = $2 AND created_at >= $3::timestamptz AND created_at <= $4::timestamptz",
    );
    expect(h.lastCreatedCursor.values).toEqual([
      "delete_user",
      "ops-lead",
      "2026-06-01T00:00:00Z",
      "2026-06-02T00:00:00Z",
    ]);
  });

  it("releases cursor and db connection after stream finishes", async () => {
    await supertest(buildApp()).get("/api/v1/admin/audit-log/export.csv");
    expect(h.close).toHaveBeenCalled();
    expect(h.release).toHaveBeenCalled();
  });
});
