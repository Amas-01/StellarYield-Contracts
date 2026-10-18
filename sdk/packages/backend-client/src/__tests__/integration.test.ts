/**
 * Integration test verifying the generated SDK client against a live backend
 * (Issue #874).
 *
 * - Starts the backend test dependencies with `docker-compose.test.yml` in
 *   `beforeAll`.
 * - Verifies `client.GET("/api/v1/health")` returns `{ status: "ok" }`.
 * - Verifies `client.GET("/api/v1/vaults")` returns a vault list parseable by
 *   `VaultSchema`.
 * - Skips (does not fail) when `BACKEND_URL` is not set, so unit-test runs
 *   without a live backend stay green.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { createBackendClient } from "../client.js";
import { VaultSchema } from "../schemas.js";

const BACKEND_URL = process.env["BACKEND_URL"];

// Skip the whole suite when no live backend is configured.
const describeIfBackend = BACKEND_URL ? describe : describe.skip;

function composeFileArgs(): string {
  // backend-client lives at sdk/packages/backend-client; the compose file for
  // backend integration tests lives at backend/docker-compose.test.yml.
  return "-f ../../../backend/docker-compose.test.yml";
}

describeIfBackend("SDK backend-client integration (live backend) #874", () => {
  beforeAll(() => {
    // Bring up the backend test dependencies (Postgres test DB) before
    // exercising the live API. Failures here must not fail the suite when
    // Docker is unavailable (e.g. CI unit-test jobs); the individual tests
    // below will surface connection errors only when BACKEND_URL is set.
    try {
      execSync(`docker compose ${composeFileArgs()} up -d`, {
        stdio: "ignore",
        timeout: 120_000,
      });
    } catch {
      // Docker not available — the live-backend assertions will fail with a
      // connection error, which is the correct signal when BACKEND_URL is set
      // but the backend is unreachable.
    }
  }, 150_000);

  afterAll(() => {
    try {
      execSync(`docker compose ${composeFileArgs()} down`, {
        stdio: "ignore",
        timeout: 60_000,
      });
    } catch {
      // Best-effort cleanup only.
    }
  });

  it('client.GET("/api/v1/health") returns { status: "ok" }', async () => {
    const client = createBackendClient(BACKEND_URL as string);
    // No type argument needed: the response type is inferred from the spec.
    const { data, error } = await client.GET("/api/v1/health");

    expect(error).toBeUndefined();
    expect(data).toBeDefined();
    expect(data).toMatchObject({ status: "ok" });
  });

  it('client.GET("/api/v1/vaults") returns a vault list parseable by VaultSchema', async () => {
    const client = createBackendClient(BACKEND_URL as string);
    const { data, error } = await client.GET("/api/v1/vaults");

    expect(error).toBeUndefined();
    expect(data).toBeDefined();
    expect(Array.isArray(data?.data)).toBe(true);

    // `data` is already typed from the spec, so no cast is needed to read it.
    for (const vault of data?.data ?? []) {
      expect(() => VaultSchema.parse(vault)).not.toThrow();
    }
  });
});

// Explicit skip notice when BACKEND_URL is missing so the skip is visible in
// test output instead of silent.
if (!BACKEND_URL) {
  describe.skip("SDK backend-client integration (live backend) #874 — skipped: BACKEND_URL not set", () => {
    it("skips gracefully without a backend", () => {
      expect(true).toBe(true);
    });
  });
}
