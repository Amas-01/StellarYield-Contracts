import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

async function getTestContext() {
  const { query } = await import("../db/index.js");
  const { logger } = await import("../logger.js");
  const service = await import("./apiKeyExpiryReminder.js");
  return { query: query as ReturnType<typeof vi.fn>, logger: logger as any, ...service };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("findApiKeysExpiringWithin (#1245)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds the window as a parameter instead of interpolating it", async () => {
    const { query, findApiKeysExpiringWithin } = await getTestContext();
    query.mockResolvedValue([]);

    await findApiKeysExpiringWithin(7);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("make_interval(days => $1::int)");
    expect(params).toEqual([7]);
  });

  it("never selects key_hash, so the listing carries no secret material", async () => {
    const { query, findApiKeysExpiringWithin } = await getTestContext();
    query.mockResolvedValue([]);

    await findApiKeysExpiringWithin(7);

    expect(String(query.mock.calls[0][0])).not.toContain("key_hash");
  });
});

describe("logApiKeysExpiringSoon (#1245)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs one warn entry per expiring key with its label and expiry, and no hash", async () => {
    const { query, logger, logApiKeysExpiringSoon } = await getTestContext();
    const expiresAt = new Date(Date.now() + 3 * DAY_MS);
    query.mockResolvedValue([
      {
        id: 11,
        label: "partner-a",
        role: "readonly",
        description: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
        expires_at: expiresAt,
        last_used_at: null,
        active: true,
        deactivated_at: null,
        allowed_methods: null,
        allowed_cidrs: null,
        allowed_contract_ids: null,
      },
    ]);

    const count = await logApiKeysExpiringSoon();

    expect(count).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = logger.warn.mock.calls[0];
    expect(message).toBe("API key expires soon");
    expect(fields).toMatchObject({ event: "api_key_expiring_soon", keyId: 11, keyLabel: "partner-a", expiresAt });
    expect(fields).not.toHaveProperty("key_hash");
    expect(fields).not.toHaveProperty("keyHash");
  });

  it("logs nothing when no key is inside the window", async () => {
    const { query, logger, logApiKeysExpiringSoon } = await getTestContext();
    query.mockResolvedValue([]);

    const count = await logApiKeysExpiringSoon();

    expect(count).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
