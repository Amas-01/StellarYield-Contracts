import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

const DAY_MS = 24 * 60 * 60 * 1000;
const CONTRACT_A = "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";
const CONTRACT_B = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJWDS3IVOTDMTIHKZV5YF2XYPNYX";

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const auth = await import("./auth.js");
  return { query: query as ReturnType<typeof vi.fn>, ...auth };
}

function makeReqRes(options: { authHeader?: string; params?: Record<string, string> } = {}) {
  const req = {
    headers: options.authHeader ? { authorization: options.authHeader } : {},
    method: "GET",
    path: "/api/v1/vaults",
    params: options.params ?? {},
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    role: "readonly",
    label: "partner-a",
    expiresAt: null,
    lastUsedAt: null,
    active: true,
    allowedMethods: null,
    allowedCidrs: null,
    allowedContractIds: null,
    ...overrides,
  };
}

describe("per-key vault scope (#1243)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 when the key's vault list does not include the requested contract", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow({ allowedContractIds: [CONTRACT_A] })]);
    const { req, res, next } = makeReqRes({
      authHeader: "Bearer partner-key",
      params: { contractId: CONTRACT_B },
    });

    await requireApiKey({ minRole: "readonly" })(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Forbidden",
      message: "API key is not permitted to access this vault",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when the requested contract is in the key's vault list", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow({ allowedContractIds: [CONTRACT_A] })]);
    const { req, res, next } = makeReqRes({
      authHeader: "Bearer partner-key",
      params: { contractId: CONTRACT_A },
    });

    await requireApiKey({ minRole: "readonly" })(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("does not restrict a key whose allowed_contract_ids is NULL", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow({ allowedContractIds: null })]);
    const { req, res, next } = makeReqRes({
      authHeader: "Bearer partner-key",
      params: { contractId: CONTRACT_B },
    });

    await requireApiKey({ minRole: "readonly" })(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("selects allowed_contract_ids in the key lookup", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow()]);
    const { req, res, next } = makeReqRes({ authHeader: "Bearer partner-key" });

    await requireApiKey({ minRole: "readonly" })(req, res, next);

    expect(String(query.mock.calls[0][0])).toContain('allowed_contract_ids AS "allowedContractIds"');
  });

  it("keeps the rate-limit and CIDR columns separated by a comma in the key lookup", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow()]);
    const { req, res, next } = makeReqRes({ authHeader: "Bearer partner-key" });

    await requireApiKey({ minRole: "readonly" })(req, res, next);

    expect(String(query.mock.calls[0][0])).toContain('"rateLimitOverride",');
  });

  describe("isContractAllowedForKey", () => {
    it("allows any contract when the list is NULL or absent", async () => {
      const { isContractAllowedForKey } = await getTestContext();
      expect(isContractAllowedForKey({ allowedContractIds: null }, CONTRACT_A)).toBe(true);
      expect(isContractAllowedForKey({}, CONTRACT_A)).toBe(true);
      expect(isContractAllowedForKey(undefined, CONTRACT_A)).toBe(true);
    });

    it("allows only listed contracts when the list is set", async () => {
      const { isContractAllowedForKey } = await getTestContext();
      expect(isContractAllowedForKey({ allowedContractIds: [CONTRACT_A] }, CONTRACT_A)).toBe(true);
      expect(isContractAllowedForKey({ allowedContractIds: [CONTRACT_A] }, CONTRACT_B)).toBe(false);
    });

    it("allows no contract when the list is empty", async () => {
      const { isContractAllowedForKey } = await getTestContext();
      expect(isContractAllowedForKey({ allowedContractIds: [] }, CONTRACT_A)).toBe(false);
    });
  });

  describe("enforceApiKeyContractScope (router param guard)", () => {
    it("passes an anonymous request through", async () => {
      const { enforceApiKeyContractScope } = await getTestContext();
      const { req, res, next } = makeReqRes();

      enforceApiKeyContractScope(req, res, next, CONTRACT_B);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    });

    it("returns 403 for a scoped key on another vault", async () => {
      const { enforceApiKeyContractScope } = await getTestContext();
      const { req, res, next } = makeReqRes();
      req.apiKey = { id: 5, label: "partner-a", allowedContractIds: [CONTRACT_A] };

      enforceApiKeyContractScope(req, res, next, CONTRACT_B);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("optionalApiKey", () => {
    it("lets a request with no Bearer token through without a key lookup", async () => {
      const { query, optionalApiKey } = await getTestContext();
      const { req, res, next } = makeReqRes();

      optionalApiKey()(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(query).not.toHaveBeenCalled();
      expect(req.apiKey).toBeUndefined();
    });

    it("authenticates a presented key and marks the response as private", async () => {
      const { query, optionalApiKey } = await getTestContext();
      query.mockResolvedValue([keyRow({ allowedContractIds: [CONTRACT_A] })]);
      const { req, res, next } = makeReqRes({ authHeader: "Bearer partner-key" });

      optionalApiKey()(req, res, next);
      await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());

      expect(req.apiKey).toMatchObject({ id: 5, allowedContractIds: [CONTRACT_A] });
      expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    });

    it("rejects a presented but invalid key rather than serving it as anonymous", async () => {
      const { query, optionalApiKey } = await getTestContext();
      query.mockResolvedValue([]);
      const { req, res, next } = makeReqRes({ authHeader: "Bearer bogus-key" });

      optionalApiKey()(req, res, next);
      await vi.waitFor(() => expect(res.status).toHaveBeenCalledWith(401));

      expect(next).not.toHaveBeenCalled();
    });
  });
});

describe("X-API-Key-Expires-In header (#1244)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets the remaining seconds for a key expiring in 3 days", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow({ expiresAt: new Date(Date.now() + 3 * DAY_MS) })]);
    const { req, res, next } = makeReqRes({ authHeader: "Bearer expiring-key" });

    await requireApiKey({ minRole: "readonly" })(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const [name, value] = res.setHeader.mock.calls[0];
    expect(name).toBe("X-API-Key-Expires-In");
    expect(Number(value)).toBeGreaterThanOrEqual(3 * 24 * 60 * 60 - 5);
    expect(Number(value)).toBeLessThanOrEqual(3 * 24 * 60 * 60);
  });

  it("omits the header for a key with no expiry", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow({ expiresAt: null })]);
    const { req, res, next } = makeReqRes({ authHeader: "Bearer forever-key" });

    await requireApiKey({ minRole: "readonly" })(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("omits the header for a key expiring beyond the 14-day window", async () => {
    const { query, requireApiKey } = await getTestContext();
    query.mockResolvedValue([keyRow({ expiresAt: new Date(Date.now() + 30 * DAY_MS) })]);
    const { req, res, next } = makeReqRes({ authHeader: "Bearer far-key" });

    await requireApiKey({ minRole: "readonly" })(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
