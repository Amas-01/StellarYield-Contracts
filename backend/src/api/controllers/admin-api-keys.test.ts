import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { getApiKeys } = await import("./admin.js");
  return { query: query as ReturnType<typeof vi.fn>, getApiKeys };
}

function makeRes() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
}

describe("GET /api/v1/admin/api-keys key metadata (#933)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns lastUsedAt for a key that has been used", async () => {
    const { query, getApiKeys } = await getTestContext();
    const lastUsedAt = new Date("2026-08-20T10:00:00Z");
    query.mockResolvedValue([
      {
        id: 1,
        label: "ci-bot",
        role: "admin",
        created_at: new Date("2026-01-01T00:00:00Z"),
        expires_at: null,
        last_used_at: lastUsedAt,
      },
    ]);
    const res = makeRes();

    await getApiKeys({} as any, res, vi.fn());

    expect(String(query.mock.calls[0][0])).toContain("last_used_at");
    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 1, lastUsedAt })]);
  });

  it("returns lastUsedAt as null for a key that has never been used", async () => {
    const { query, getApiKeys } = await getTestContext();
    query.mockResolvedValue([
      {
        id: 2,
        label: "unused",
        role: "readonly",
        created_at: new Date("2026-01-01T00:00:00Z"),
        expires_at: null,
        last_used_at: null,
      },
    ]);
    const res = makeRes();

    await getApiKeys({} as any, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 2, lastUsedAt: null })]);
  });
});

describe("GET /api/v1/admin/api-keys?expiringWithinDays (#1245)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("lists only keys inside the requested window", async () => {
    const { query, getApiKeys } = await getTestContext();
    query.mockResolvedValue([
      {
        id: 3,
        label: "soon",
        role: "readonly",
        description: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        expires_at: new Date("2026-10-22T00:00:00Z"),
        last_used_at: null,
        active: true,
        deactivated_at: null,
        allowed_methods: null,
        allowed_cidrs: null,
        allowed_contract_ids: null,
      },
    ]);
    const res = makeRes();

    await getApiKeys({ query: { expiringWithinDays: "7" } } as any, res, vi.fn());

    expect(String(query.mock.calls[0][0])).toContain("expires_at <= NOW() + make_interval(days => $1::int)");
    expect(query.mock.calls[0][1]).toEqual([7]);
    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 3, label: "soon" })]);
  });

  it("returns 400 for a window that is not a whole number of days in range", async () => {
    const { query, getApiKeys } = await getTestContext();

    for (const bad of ["0", "-3", "7.5", "abc", "366"]) {
      const res = makeRes();
      await getApiKeys({ query: { expiringWithinDays: bad } } as any, res, vi.fn());
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("includes allowedContractIds in each listed key", async () => {
    const { query, getApiKeys } = await getTestContext();
    query.mockResolvedValue([
      {
        id: 4,
        label: "scoped",
        role: "readonly",
        created_at: new Date("2026-01-01T00:00:00Z"),
        expires_at: null,
        last_used_at: null,
        active: true,
        deactivated_at: null,
        allowed_methods: null,
        allowed_cidrs: null,
        allowed_contract_ids: ["CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE"],
      },
    ]);
    const res = makeRes();

    await getApiKeys({ query: {} } as any, res, vi.fn());

    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 4,
        allowedContractIds: ["CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE"],
      }),
    ]);
  });
});
