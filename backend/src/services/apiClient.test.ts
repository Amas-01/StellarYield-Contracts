import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  ApiClient,
  ApiHttpError,
  ApiTimeoutError,
  createApiClient,
} from "./apiClient.js";

/** Minimal stand-in for a fetch `Response` with just what the client touches. */
function fakeResponse(
  status: number,
  body: unknown = null,
  headers: Record<string, string> = {},
): Response {
  const lower = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v] as const),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    text: async () => (body === null ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

function makeClient(
  fetchImpl: unknown,
  overrides: Partial<ConstructorParameters<typeof ApiClient>[0]> = {},
) {
  const sleep = vi.fn(async () => {});
  const client = new ApiClient({
    baseUrl: "https://api.test",
    fetchImpl: fetchImpl as typeof fetch,
    sleep,
    retryJitter: 0,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 10_000,
    ...overrides,
  });
  return { client, sleep };
}

function sentHeaders(fetchImpl: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
  return fetchImpl.mock.calls[call][1].headers as Record<string, string>;
}

describe("ApiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("API key attachment (#873)", () => {
    it("sends the configured key as a bearer token", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, { ok: true }));
      const { client } = makeClient(fetchImpl, { apiKey: "sk_live_123" });

      await client.get("/api/v1/vaults");

      expect(sentHeaders(fetchImpl).Authorization).toBe("Bearer sk_live_123");
    });

    it("omits the header when no key is configured", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, {}));
      const { client } = makeClient(fetchImpl, { apiKey: "" });

      await client.get("/api/v1/vaults");

      expect(sentHeaders(fetchImpl).Authorization).toBeUndefined();
    });

    it("lets a per-request key override the client key", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, {}));
      const { client } = makeClient(fetchImpl, { apiKey: "sk_client" });

      await client.get("/api/v1/vaults", { apiKey: "sk_per_request" });

      expect(sentHeaders(fetchImpl).Authorization).toBe("Bearer sk_per_request");
    });

    it("sends unauthenticated when the per-request key is null", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, {}));
      const { client } = makeClient(fetchImpl, { apiKey: "sk_client" });

      await client.get("/api/v1/vaults", { apiKey: null });

      expect(sentHeaders(fetchImpl).Authorization).toBeUndefined();
    });

    it("never overwrites an explicit Authorization header", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, {}));
      const { client } = makeClient(fetchImpl, { apiKey: "sk_client" });

      await client.get("/api/v1/vaults", { headers: { Authorization: "Bearer sk_explicit" } });

      expect(sentHeaders(fetchImpl).Authorization).toBe("Bearer sk_explicit");
    });
  });

  describe("request timeout (#872)", () => {
    it("aborts and reports a timeout when the response never arrives", async () => {
      const fetchImpl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
      const { client } = makeClient(fetchImpl, { timeoutMs: 20, maxRetries: 0 });

      await expect(client.get("/api/v1/vaults")).rejects.toBeInstanceOf(ApiTimeoutError);
    });

    it("honours a per-request timeout override", async () => {
      const fetchImpl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
      const { client } = makeClient(fetchImpl, { timeoutMs: 60_000, maxRetries: 0 });

      await expect(
        client.get("/api/v1/vaults", { timeoutMs: 20 }),
      ).rejects.toBeInstanceOf(ApiTimeoutError);
    });

    it("does not arm a timer when the timeout is disabled", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, {}));
      const { client } = makeClient(fetchImpl, { timeoutMs: 0 });

      await client.get("/api/v1/vaults");

      expect(fetchImpl.mock.calls[0][1].signal).toBeUndefined();
    });

    it("retries a timed-out request before giving up", async () => {
      const abortable = (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      const fetchImpl = vi.fn(abortable);
      const { client, sleep } = makeClient(fetchImpl, { timeoutMs: 20, maxRetries: 1 });

      await expect(client.get("/api/v1/vaults")).rejects.toBeInstanceOf(ApiTimeoutError);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry with exponential backoff (#871)", () => {
    it("retries a 500 and succeeds on a later attempt", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse(500, { error: "boom" }))
        .mockResolvedValueOnce(fakeResponse(200, { ok: true }));
      const { client } = makeClient(fetchImpl, { maxRetries: 2 });

      await expect(client.get("/api/v1/vaults")).resolves.toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("doubles the delay on each successive attempt", async () => {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(fakeResponse(200, {}));
      const { client, sleep } = makeClient(fetchImpl, { maxRetries: 2 });

      await client.get("/api/v1/vaults");

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
    });

    it("caps the delay at the configured ceiling", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(503, null));
      const { client, sleep } = makeClient(fetchImpl, {
        maxRetries: 4,
        retryBaseDelayMs: 1_000,
        retryMaxDelayMs: 1_500,
      });

      await expect(client.get("/api/v1/vaults")).rejects.toBeInstanceOf(ApiHttpError);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 1_500, 1_500, 1_500]);
    });

    it("replays network errors", async () => {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(fakeResponse(200, { ok: true }));
      const { client } = makeClient(fetchImpl, { maxRetries: 1 });

      await expect(client.get("/api/v1/vaults")).resolves.toEqual({ ok: true });
    });

    it("does not replay non-idempotent POSTs by default", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(500, null));
      const { client, sleep } = makeClient(fetchImpl, { maxRetries: 3 });

      await expect(client.post("/api/v1/vaults", { a: 1 })).rejects.toBeInstanceOf(ApiHttpError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("replays POSTs when the caller opts in", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse(500, null))
        .mockResolvedValueOnce(fakeResponse(200, { ok: true }));
      const { client } = makeClient(fetchImpl, { maxRetries: 3 });

      await expect(
        client.post("/api/v1/vaults", { a: 1 }, { retry: true }),
      ).resolves.toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("never retries a non-retryable status", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(404, { error: "NotFound" }));
      const { client, sleep } = makeClient(fetchImpl, { maxRetries: 3 });

      const err = await client.get("/api/v1/vaults/missing").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiHttpError);
      expect((err as ApiHttpError).status).toBe(404);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("honours Retry-After on a 429", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse(429, null, { "Retry-After": "2" }))
        .mockResolvedValueOnce(fakeResponse(200, { ok: true }));
      const { client, sleep } = makeClient(fetchImpl, { maxRetries: 1 });

      await client.get("/api/v1/vaults");

      expect(sleep).toHaveBeenCalledWith(2_000);
    });

    it("caps an over-long Retry-After at the ceiling", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(fakeResponse(429, null, { "retry-after": "3600" }))
        .mockResolvedValueOnce(fakeResponse(200, {}));
      const { client, sleep } = makeClient(fetchImpl, { maxRetries: 1, retryMaxDelayMs: 5_000 });

      await client.get("/api/v1/vaults");

      expect(sleep).toHaveBeenCalledWith(5_000);
    });

    it("stops immediately when the caller aborts", async () => {
      const controller = new AbortController();
      const fetchImpl = vi.fn(async () => {
        controller.abort();
        throw new TypeError("fetch failed");
      });
      const { client, sleep } = makeClient(fetchImpl, { maxRetries: 3 });

      await expect(
        client.get("/api/v1/vaults", { signal: controller.signal }),
      ).rejects.toThrow("fetch failed");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("respects an explicit maxRetries of 0", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(502, null));
      const { client } = makeClient(fetchImpl, { maxRetries: 5 });

      await expect(client.get("/api/v1/vaults", { maxRetries: 0 })).rejects.toBeInstanceOf(
        ApiHttpError,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe("request building", () => {
    it("joins the base URL and appends query parameters", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, {}));
      const { client } = makeClient(fetchImpl);

      await client.get("api/v1/vaults", { query: { limit: 10, active: true, skip: undefined } });

      const url = fetchImpl.mock.calls[0][0] as string;
      expect(url).toBe("https://api.test/api/v1/vaults?limit=10&active=true");
    });

    it("serialises an object body as JSON", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, {}));
      const { client } = makeClient(fetchImpl);

      await client.post("/api/v1/vaults", { limit: 5 });

      const init = fetchImpl.mock.calls[0][1];
      expect(init.method).toBe("POST");
      expect(init.body).toBe('{"limit":5}');
      expect(sentHeaders(fetchImpl)["Content-Type"]).toBe("application/json");
    });

    it("resolves 204 responses to undefined", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(204, null));
      const { client } = makeClient(fetchImpl);

      await expect(client.delete("/api/v1/webhooks/1")).resolves.toBeUndefined();
    });

    it("rejects an invalid base URL at construction time", () => {
      expect(() => new ApiClient({ baseUrl: "not-a-url" })).toThrow();
    });
  });

  describe("createApiClient", () => {
    it("uses the configured base URL and honours overrides", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, {}));
      const client = createApiClient({
        baseUrl: "https://override.test/",
        timeoutMs: 25,
        maxRetries: 0,
        apiKey: "sk_from_env",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => {},
      });

      await client.get("/api/v1/vaults");

      expect(fetchImpl.mock.calls[0][0]).toBe("https://override.test/api/v1/vaults");
      expect(sentHeaders(fetchImpl).Authorization).toBe("Bearer sk_from_env");
    });
  });
});
