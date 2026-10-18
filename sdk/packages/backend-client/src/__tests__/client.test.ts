import { describe, it, expect, expectTypeOf } from "vitest";
import { createBackendClient } from "../client.js";
import type { components } from "../generated/api-types.js";

/**
 * Compile-time coverage for the typed client (Issue #866).
 *
 * The bodies below are deliberately never executed: they exist so `tsc`
 * checks them. A call that is not in the spec, or that omits a required
 * parameter, must fail to compile — which the `@ts-expect-error` markers
 * assert. A stray marker on code that *does* compile is itself an error, so
 * these tests also fail if the types lose their precision.
 */
describe("createBackendClient", () => {
  const client = createBackendClient("https://api.example.test/");

  it("exposes the generated verbs", () => {
    expect(typeof client.GET).toBe("function");
    expect(typeof client.POST).toBe("function");
    expect(typeof client.PUT).toBe("function");
    expect(typeof client.DELETE).toBe("function");
  });

  it("type-checks calls against the spec", () => {
    const checks = {
      async vaultByContractId() {
        const { data, error } = await client.GET("/api/v1/vaults/{contractId}", {
          params: {
            path: { contractId: "CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557" },
          },
        });
        // The response body is the spec's `Vault` schema, verbatim.
        expectTypeOf(data).toEqualTypeOf<components["schemas"]["Vault"] | undefined>();
        expectTypeOf(error).toEqualTypeOf<components["schemas"]["Error"] | undefined>();
      },

      async listVaults() {
        const { data } = await client.GET("/api/v1/vaults", {
          params: { query: { page: 1, pageSize: 20, state: "Active" } },
        });
        expectTypeOf(data?.total).toEqualTypeOf<number | undefined>();
        expectTypeOf(data?.page).toEqualTypeOf<number | undefined>();
        expectTypeOf(data?.data).toExtend<components["schemas"]["Vault"][] | undefined>();
      },

      async health() {
        const { data } = await client.GET("/api/v1/health");
        expectTypeOf(data?.status).toEqualTypeOf<string | undefined>();
        expectTypeOf(data?.version).toEqualTypeOf<string | undefined>();
      },

      async groupBy() {
        const { data } = await client.GET("/api/v1/analytics/vaults/group-by", {
          params: { query: { by: "state" } },
        });
        expectTypeOf(data).toExtend<unknown>();
      },

      async tvlHistory() {
        const { data } = await client.GET("/api/v1/vaults/{contractId}/tvl-history", {
          params: {
            path: { contractId: "CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557" },
            query: { bucket: "day", from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z" },
          },
        });
        expectTypeOf(data).toExtend<unknown>();
      },
    };

    expect(Object.keys(checks).sort()).toEqual([
      "groupBy",
      "health",
      "listVaults",
      "tvlHistory",
      "vaultByContractId",
    ]);
  });

  it("rejects calls that violate the spec", () => {
    // Each marker below fails the build if the expression starts compiling.
    const invalid = () => {
      // @ts-expect-error — "/api/v1/nope" is not a path in the spec.
      client.GET("/api/v1/nope");

      // @ts-expect-error — `contractId` is a required path parameter.
      client.GET("/api/v1/vaults/{contractId}", { params: { path: {} } });

      // @ts-expect-error — `page` is a number in the spec, not a string.
      client.GET("/api/v1/vaults", { params: { query: { page: "1" } } });

      // `bucket` is limited to hour | day | week, so this is a type error.
      client.GET("/api/v1/vaults/{contractId}/tvl-history", {
        // @ts-expect-error — "fortnight" is not a documented bucket size.
        params: { path: { contractId: "CAUZ" }, query: { bucket: "fortnight" } },
      });
    };

    expect(typeof invalid).toBe("function");
  });
});
