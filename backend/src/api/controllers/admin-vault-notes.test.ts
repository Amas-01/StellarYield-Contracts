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
  getVaultNotes,
  createVaultNote,
} from "./admin.js";

const VALID_CONTRACT_ID = `C${"A".repeat(55)}`;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/v1/admin/vaults/:contractId/notes", getVaultNotes);
  app.post("/api/v1/admin/vaults/:contractId/notes", createVaultNote);
  return app;
}

describe("Admin Vault Notes (#1281)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for invalid contractId format on GET", async () => {
    const res = await supertest(buildApp()).get("/api/v1/admin/vaults/invalid-cid/notes");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BadRequest");
  });

  it("returns 404 when vault is not found on GET", async () => {
    h.query.mockResolvedValueOnce([]); // vault query returns empty

    const res = await supertest(buildApp()).get(`/api/v1/admin/vaults/${VALID_CONTRACT_ID}/notes`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NotFound");
  });

  it("returns notes ordered newest first", async () => {
    const noteNew = {
      id: 2,
      contract_id: VALID_CONTRACT_ID,
      author: "operator-alice",
      note: "Second note: approved by compliance",
      created_at: new Date("2026-06-02T12:00:00Z"),
    };
    const noteOld = {
      id: 1,
      contract_id: VALID_CONTRACT_ID,
      author: "operator-bob",
      note: "First note: awaiting legal review",
      created_at: new Date("2026-06-01T12:00:00Z"),
    };

    h.query
      .mockResolvedValueOnce([{ id: 10 }]) // vault exists
      .mockResolvedValueOnce([noteNew, noteOld]); // notes

    const res = await supertest(buildApp()).get(`/api/v1/admin/vaults/${VALID_CONTRACT_ID}/notes`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe(2);
    expect(res.body[0].note).toBe("Second note: approved by compliance");
    expect(res.body[1].id).toBe(1);

    const selectCall = h.query.mock.calls[1];
    expect(selectCall[0]).toContain("ORDER BY created_at DESC, id DESC");
  });

  it("returns 400 for invalid contractId format on POST", async () => {
    const res = await supertest(buildApp())
      .post("/api/v1/admin/vaults/invalid-cid/notes")
      .send({ note: "valid note" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BadRequest");
  });

  it("returns 404 when vault is not found on POST", async () => {
    h.query.mockResolvedValueOnce([]); // vault query returns empty

    const res = await supertest(buildApp())
      .post(`/api/v1/admin/vaults/${VALID_CONTRACT_ID}/notes`)
      .send({ note: "valid note" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("NotFound");
  });

  it("rejects missing or empty note with 400", async () => {
    h.query.mockResolvedValueOnce([{ id: 10 }]); // vault exists

    const res = await supertest(buildApp())
      .post(`/api/v1/admin/vaults/${VALID_CONTRACT_ID}/notes`)
      .send({ note: "   " });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BadRequest");
  });

  it("creates a note and returns 201 with note details", async () => {
    h.query
      .mockResolvedValueOnce([{ id: 10 }]) // vault exists
      .mockResolvedValueOnce([
        {
          id: 3,
          contract_id: VALID_CONTRACT_ID,
          author: "compliance-team",
          note: "Awaiting legal review",
          created_at: new Date("2026-06-03T10:00:00Z"),
        },
      ]);

    const res = await supertest(buildApp())
      .post(`/api/v1/admin/vaults/${VALID_CONTRACT_ID}/notes`)
      .send({ note: "Awaiting legal review", author: "compliance-team" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(3);
    expect(res.body.contractId).toBe(VALID_CONTRACT_ID);
    expect(res.body.author).toBe("compliance-team");
    expect(res.body.note).toBe("Awaiting legal review");
  });
});
