import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

const { getEventLoopLagSnapshot } = vi.hoisted(() => ({ getEventLoopLagSnapshot: vi.fn() }));
vi.mock("../../services/eventLoopLag.js", () => ({ getEventLoopLagSnapshot }));

import { loadShedder, isEssentialPath } from "./loadShed.js";

function buildApp() {
  const app = express();
  app.use(loadShedder(250));
  const ok = (_req: express.Request, res: express.Response) => {
    res.json({ ok: true });
  };
  app.get("/api/v1/vaults", ok);
  app.get("/health", ok);
  app.get("/metrics", ok);
  app.get("/api/v1/admin/stats", ok);
  return app;
}

describe("loadShedder middleware (#1251)", () => {
  beforeEach(() => {
    getEventLoopLagSnapshot.mockReset();
  });

  it("sheds a public request with 503 and Retry-After when p99 lag exceeds the limit", async () => {
    getEventLoopLagSnapshot.mockReturnValue({ p50Ms: 90, p99Ms: 500 });

    const res = await supertest(buildApp()).get("/api/v1/vaults");

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.body).toEqual({ error: "ServiceUnavailable", message: "Server is overloaded, retry shortly" });
  });

  it("serves a public request when p99 lag is at or below the limit", async () => {
    getEventLoopLagSnapshot.mockReturnValue({ p50Ms: 5, p99Ms: 250 });

    const res = await supertest(buildApp()).get("/api/v1/vaults");

    expect(res.status).toBe(200);
  });

  it("never sheds /health, /metrics or admin routes, even under saturation", async () => {
    getEventLoopLagSnapshot.mockReturnValue({ p50Ms: 900, p99Ms: 2000 });
    const app = buildApp();

    expect((await supertest(app).get("/health")).status).toBe(200);
    expect((await supertest(app).get("/metrics")).status).toBe(200);
    expect((await supertest(app).get("/api/v1/admin/stats")).status).toBe(200);
  });
});

describe("isEssentialPath", () => {
  it("covers liveness, metrics and the admin API and their sub-paths", () => {
    expect(isEssentialPath("/health")).toBe(true);
    expect(isEssentialPath("/api/v1/health")).toBe(true);
    expect(isEssentialPath("/metrics")).toBe(true);
    expect(isEssentialPath("/api/v1/admin")).toBe(true);
    expect(isEssentialPath("/api/v1/admin/indexer/stream")).toBe(true);
  });

  it("does not treat similarly named public paths as essential", () => {
    expect(isEssentialPath("/api/v1/vaults")).toBe(false);
    expect(isEssentialPath("/api/v1/administrators")).toBe(false);
    expect(isEssentialPath("/healthy-vaults")).toBe(false);
  });
});
