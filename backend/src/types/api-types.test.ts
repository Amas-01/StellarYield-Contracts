import { describe, it, expectTypeOf } from "vitest";
import type { components, paths } from "../generated/api-types";
import type {
  ApiAnalyticsSummary,
  ApiError,
  ApiHealth,
  ApiTvlAggregate,
  ApiTvlBucket,
  ApiVault,
  ApiVaultGroupBy,
  ListVaultsQuery,
  ListVaultsResponse,
  TvlHistoryQuery,
  Vault,
  VaultGroupByQuery,
} from "./api";

/**
 * Guards `api.ts` against drift from the OpenAPI spec (Issue #868).
 *
 * The generated `components`/`paths` types come straight from
 * `api/openapi.json`, so requiring mutual assignability here means a spec
 * change that is not mirrored in the hand-written types fails the build.
 */
describe("API types match the OpenAPI spec", () => {
  it("exposes the vault response shape", () => {
    expectTypeOf<ApiVault>().toEqualTypeOf<components["schemas"]["Vault"]>();
    expectTypeOf<Vault>().toEqualTypeOf<components["schemas"]["Vault"]>();
  });

  it("exposes the shared component schemas", () => {
    expectTypeOf<ApiTvlBucket>().toEqualTypeOf<components["schemas"]["TvlBucket"]>();
    expectTypeOf<ApiVaultGroupBy>().toEqualTypeOf<components["schemas"]["VaultGroupBy"]>();
    expectTypeOf<ApiError>().toEqualTypeOf<components["schemas"]["Error"]>();
  });

  it("exposes the health response shape", () => {
    type SpecHealth =
      paths["/api/v1/health"]["get"]["responses"][200]["content"]["application/json"];
    expectTypeOf<ApiHealth>().toEqualTypeOf<SpecHealth>();
  });

  it("exposes the list-vaults response shape", () => {
    type SpecList =
      paths["/api/v1/vaults"]["get"]["responses"][200]["content"]["application/json"];
    expectTypeOf<ListVaultsResponse>().toEqualTypeOf<SpecList>();
  });

  it("accepts the documented list-vaults query parameters", () => {
    type SpecQuery = NonNullable<
      paths["/api/v1/vaults"]["get"]["parameters"]["query"]
    >;
    // The spec marks every parameter optional; the hand-written query type
    // must therefore accept every one of them.
    expectTypeOf<ListVaultsQuery>().toExtend<SpecQuery>();
  });

  it("exposes the analytics response shapes", () => {
    type SpecSummary =
      paths["/api/v1/analytics/summary"]["get"]["responses"][200]["content"]["application/json"];
    type SpecTvl =
      paths["/api/v1/analytics/tvl"]["get"]["responses"][200]["content"]["application/json"];

    expectTypeOf<ApiAnalyticsSummary>().toEqualTypeOf<SpecSummary>();
    expectTypeOf<ApiTvlAggregate>().toEqualTypeOf<SpecTvl>();
  });

  it("exposes the tvl-history query parameters", () => {
    type SpecTvlHistory = NonNullable<
      paths["/api/v1/vaults/{contractId}/tvl-history"]["get"]["parameters"]["query"]
    >;
    expectTypeOf<TvlHistoryQuery>().toExtend<SpecTvlHistory>();
  });

  it("requires the group-by parameter, matching the spec", () => {
    type SpecGroupBy =
      paths["/api/v1/analytics/vaults/group-by"]["get"]["parameters"]["query"];
    expectTypeOf<NonNullable<SpecGroupBy>["by"]>().toEqualTypeOf<
      NonNullable<VaultGroupByQuery["by"]>
    >();
  });
});
