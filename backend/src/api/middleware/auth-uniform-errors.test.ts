import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../../services/securityLogger.js", () => ({ logSecurityEvent: vi.fn() }));

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { logSecurityEvent } = await import("../../services/securityLogger.js");
  const { requireApiKey } = await import("./auth.js");
  return {
    query: query as ReturnType<typeof vi.fn>,
    logSecurityEvent: logSecurityEvent as ReturnType<typeof vi.fn>,
    requireApiKey,
  };
}

function makeReq(authorization: string) {
  return { headers: { authorization }, method: "GET", path: "/api/v1/admin/stats" } as any;
}

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
}

const UNIFORM_BODY = { error: "Unauthorized", message: "Invalid or expired API key" };

describe("uniform credential failures (#1247)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the same 401 and byte-identical body for unknown, revoked and expired keys", async () => {
    const { query, requireApiKey } = await getTestContext();
    const cases = [
      [],
      [{ id: 1, role: "admin", label: "revoked", expiresAt: null, active: false }],
      [{ id: 2, role: "admin", label: "old", expiresAt: new Date(Date.now() - 1000), active: true }],
    ];

    const statuses: unknown[] = [];
    const bodies: string[] = [];
    for (const rows of cases) {
      query.mockResolvedValue(rows);
      const res = makeRes();

      await requireApiKey()(makeReq("Bearer some-key"), res, vi.fn());

      statuses.push(res.status.mock.calls[0][0]);
      bodies.push(JSON.stringify(res.json.mock.calls[0][0]));
    }

    expect(statuses).toEqual([401, 401, 401]);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual(UNIFORM_BODY);
  });

  it("records the real reason only in the security event log", async () => {
    const { query, logSecurityEvent, requireApiKey } = await getTestContext();
    const cases: Array<[unknown[], string]> = [
      [[], "key_not_found"],
      [[{ id: 1, role: "admin", label: "revoked", expiresAt: null, active: false }], "deactivated"],
      [[{ id: 2, role: "admin", label: "old", expiresAt: new Date(Date.now() - 1000), active: true }], "expired"],
    ];

    for (const [rows, reason] of cases) {
      query.mockResolvedValue(rows);
      const res = makeRes();

      await requireApiKey()(makeReq("Bearer some-key"), res, vi.fn());

      expect(logSecurityEvent).toHaveBeenCalledWith(
        "AUTH_FAILURE",
        expect.objectContaining({ details: { reason } }),
      );
    }
  });

  it("returns the same 401 body for an expired admin session JWT", async () => {
    const { requireApiKey } = await getTestContext();
    const secret = "test-admin-jwt-secret";
    process.env.ADMIN_JWT_SECRET = secret;
    const token = jwt.sign({ sub: "7", role: "admin", type: "admin_session" }, secret, { expiresIn: "-1s" });
    const res = makeRes();

    await requireApiKey({ role: "admin" })(makeReq(`Bearer ${token}`), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(UNIFORM_BODY);
  });

  it("logs an expired session JWT as an AUTH_FAILURE with reason expired", async () => {
    const { logSecurityEvent, requireApiKey } = await getTestContext();
    const secret = "test-admin-jwt-secret";
    process.env.ADMIN_JWT_SECRET = secret;
    const token = jwt.sign({ sub: "7", role: "admin", type: "admin_session" }, secret, { expiresIn: "-1s" });

    await requireApiKey({ role: "admin" })(makeReq(`Bearer ${token}`), makeRes(), vi.fn());

    expect(logSecurityEvent).toHaveBeenCalledWith(
      "AUTH_FAILURE",
      expect.objectContaining({ details: { reason: "expired" } }),
    );
  });

  it("keeps a 403 for a valid key that lacks permission, since it is authenticated", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([{ id: 1, role: "user", label: "reader", expiresAt: null, active: true }]);
    const res = makeRes();

    await requireApiKey({ role: "admin" })(makeReq("Bearer user-key"), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Forbidden", message: "Insufficient permissions" });
  });
});
