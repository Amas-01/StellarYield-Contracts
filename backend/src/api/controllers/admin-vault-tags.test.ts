import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

const h = vi.hoisted(() => ({
  query: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../db/index.js", () => ({
  query: h.query,
  pool: { connect: vi.fn() },
}));

vi.mock("../../services/adminAuditLog.js", () => ({
  logAdminAudit: vi.fn().mockResolvedValue(undefined),
}));

import {
  getVaultTags,
  updateVaultTags,
} from "./admin.js";

const VALID_CONTRACT_ID = `C${"A".repeat(55)}`;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/v1/admin/vaults/:contractId/tags", getVaultTags);
  app.put("/api/v1/admin/vaults/:contractId/tags", updateVaultTags);
  return app;
}

describe("Admin Vault Tags (#1282)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for invalid contractId format on GET", async () => {
    const res = await supertest(buildApp()).get("/api/v1/admin/vaults/invalid-cid/tags");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BadRequest");
  });

  it("returns 404 when vault is not found on GET", async () => {
    h.query.mockResolvedValueOnce([]); // vault query returns empty

    const res = await supertest(buildApp()).get(`/api/v1/admin/vaults/${VALID_CONTRACT_ID}/tags`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NotFound");
  });

  it("returns current tags for a vault", async () => {
    h.query.mockResolvedValueOnce([{ tags: ["pilot", "real-estate"] }]);

    const res = await supertest(buildApp()).get(`/api/v1/admin/vaults/${VALID_CONTRACT_ID}/tags`);
    expect(res.status).toBe(200);
    expect(res.body.contractId).toBe(VALID_CONTRACT_ID);
    expect(res.body.tags).toEqual(["pilot", "real-estate"]);
  });

  it("normalizes tags to lowercase", async () => {
    h.query
      .mockResolvedValueOnce([{ id: 1 }]) // vault exists
      .mockResolvedValueOnce([{ tags: ["pilot", "real-estate", "q3-launch"] }]); // update result

    const res = await supertest(buildApp())
      .put(`/api/v1/admin/vaults/${VALID_CONTRACT_ID}/tags`)
      .send({ tags: ["PILOT", "Real-Estate", "Q3-Launch"] });

    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(["pilot", "real-estate", "q3-launch"]);

    const updateCall = h.query.mock.calls[1];
    expect(updateCall[1][0]).toEqual(["pilot", "real-estate", "q3-launch"]);
  });

  it("returns 422 when tags is not an array", async () => {
    h.query.mockResolvedValueOnce([{ id: 1 }]);

    const res = await supertest(buildApp())
      .put(`/api/v1/admin/vaults/${VALID_CONTRACT_ID}/tags`)
      .send({ tags: "not-an-array" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("UnprocessableEntity");
  });

  it("returns 422 when tags exceed maximum count of 10", async () => {
    h.query.mockResolvedValueOnce([{ id: 1 }]);

    const excessTags = Array.from({ length: 11 }, (_, i) => `tag-${i}`);
    const res = await supertest(buildApp())
      .put(`/api/v1/admin/vaults/${VALID_CONTRACT_ID}/tags`)
      .send({ tags: excessTags });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("UnprocessableEntity");
    expect(res.body.message).toContain("at most 10");
  });

  it("returns 422 when a tag exceeds 32 characters", async () => {
    h.query.mockResolvedValueOnce([{ id: 1 }]);

    const tooLongTag = "a".repeat(33);
    const res = await supertest(buildApp())
      .put(`/api/v1/admin/vaults/${VALID_CONTRACT_ID}/tags`)
      .send({ tags: ["valid", tooLongTag] });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("UnprocessableEntity");
    expect(res.body.message).toContain("between 1 and 32");
  });

  it("returns 422 when a tag is empty or has invalid characters", async () => {
    h.query.mockResolvedValueOnce([{ id: 1 }]);

    const res1 = await supertest(buildApp())
      .put(`/api/v1/admin/vaults/${VALID_CONTRACT_ID}/tags`)
      .send({ tags: ["valid", "   "] });
    expect(res1.status).toBe(422);

    h.query.mockResolvedValueOnce([{ id: 1 }]);
    const res2 = await supertest(buildApp())
      .put(`/api/v1/admin/vaults/${VALID_CONTRACT_ID}/tags`)
      .send({ tags: ["invalid tag with spaces"] });
    expect(res2.status).toBe(422);
  });
});
