import { describe, it, expect } from "vitest";
import { getOpenApiSpec } from "./openapi.js";

/**
 * Guards the yield-analytics endpoints (#1071-#1074) in the served spec.
 *
 * `getOpenApiSpec` is what `/api/v1/docs/openapi.json` returns, so an endpoint
 * missing here is an endpoint the docs do not describe.
 */
describe("OpenAPI spec covers the yield-analytics endpoints (#1071-#1074)", () => {
  const spec = getOpenApiSpec() as {
    paths: Record<string, Record<string, { summary: string; parameters?: unknown[]; responses: Record<string, unknown> }>>;
    components: { schemas: Record<string, unknown> };
  };

  it("documents the windowed epoch list with its cursor header (#1072)", () => {
    const op = spec.paths["/api/v1/yields/{contractId}/epochs"].get;

    expect(op).toBeDefined();
    expect(op.responses[200].headers).toHaveProperty("X-Next-Cursor");
    expect(op.responses[400]).toBeDefined();
  });

  it("documents the per-epoch yield-per-share lookup and its 404 (#1071)", () => {
    const op = spec.paths["/api/v1/yields/{contractId}/epochs/{epochId}/yield-per-share"].get;

    expect(op).toBeDefined();
    expect(op.responses[404]).toBeDefined();
  });

  it("documents the admin anomaly list (#1073)", () => {
    const op = spec.paths["/api/v1/admin/vaults/{contractId}/epoch-anomalies"].get;

    expect(op).toBeDefined();
    expect(op.summary).toContain("requires API key");
  });

  it("documents the transfer volume window and its allowed periods (#1074)", () => {
    const op = spec.paths["/api/v1/vaults/{contractId}/transfer-volume"].get;

    expect(op).toBeDefined();
    const period = op.parameters?.find(
      (p): p is { name: string; schema: { enum?: string[] } } =>
        typeof p === "object" && p !== null && (p as { name?: string }).name === "period",
    );
    expect(period?.schema.enum).toEqual(["1d", "7d", "30d"]);
  });

  it("types fixed-point amounts as strings so clients cannot lose precision", () => {
    // A number here would be a silent rounding bug for clients: share amounts
    // exceed Number.MAX_SAFE_INTEGER and the ratio needs 18 decimals.
    const propertiesOf = (path: string): Record<string, { type?: string }> =>
      (
        spec.paths[path].get.responses[200] as {
          content: { "application/json": { schema: { properties: Record<string, { type?: string }> } } };
        }
      ).content["application/json"].schema.properties;

    const perShare = propertiesOf("/api/v1/yields/{contractId}/epochs/{epochId}/yield-per-share");
    expect(perShare.yieldPerShare.type).toBe("string");

    const volume = propertiesOf("/api/v1/vaults/{contractId}/transfer-volume");
    expect(volume.totalVolume.type).toBe("string");
  });

  it("does not type the z-score as a number, since a flat window has no score", () => {
    const item = (
      spec.paths["/api/v1/admin/vaults/{contractId}/epoch-anomalies"].get.responses[200] as {
        content: { "application/json": { schema: { items: { properties: Record<string, { type?: string; nullable?: boolean }> } } } };
      }
    ).content["application/json"].schema.items;

    expect(item.properties.zScore).toMatchObject({ type: "string", nullable: true });
  });
});
