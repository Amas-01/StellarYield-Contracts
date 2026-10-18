import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));

async function ctx() {
  const { query } = await import("../db/index.js");
  const { logSystemAudit } = await import("./adminAuditLog.js");
  return { query: query as ReturnType<typeof vi.fn>, logSystemAudit };
}

describe("logSystemAudit (#1064)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("writes the action, target and details", async () => {
    const { query, logSystemAudit } = await ctx();

    await logSystemAudit("VAULT_INDEXED", "CABC123", { blockNumber: 42, txHash: "deadbeef" });

    const sql: string = query.mock.calls[0][0];
    expect(sql).toContain("INSERT INTO admin_audit_log");
    expect(sql).toContain("details");
    expect(query.mock.calls[0][1][1]).toBe("VAULT_INDEXED");
    expect(query.mock.calls[0][1][2]).toBe("CABC123");
    expect(query.mock.calls[0][1][5]).toBe(JSON.stringify({ blockNumber: 42, txHash: "deadbeef" }));
  });

  it("stamps the indexer as the actor", async () => {
    const { query, logSystemAudit } = await ctx();

    await logSystemAudit("VAULT_INDEXED", "CABC123", { blockNumber: 1, txHash: "x" });

    expect(query.mock.calls[0][1][0]).toBe("system:indexer");
  });

  it("is replay-safe when conflictTarget is set", async () => {
    const { query, logSystemAudit } = await ctx();

    await logSystemAudit("VAULT_INDEXED", "CABC123", { blockNumber: 1, txHash: "x" }, {
      conflictTarget: true,
    });

    expect(query.mock.calls[0][0]).toContain("ON CONFLICT DO NOTHING");
  });

  it("does not dedupe ordinary entries", async () => {
    const { query, logSystemAudit } = await ctx();

    await logSystemAudit("SOME_ACTION", "target", { a: 1 });

    expect(query.mock.calls[0][0]).not.toContain("ON CONFLICT");
  });

  it("still satisfies the NOT NULL request_body_hash with no details", async () => {
    const { query, logSystemAudit } = await ctx();

    await logSystemAudit("NO_DETAILS", "target");

    expect(query.mock.calls[0][1][4]).toMatch(/^[0-9a-f]{64}$/);
    expect(query.mock.calls[0][1][5]).toBeNull();
  });
});
