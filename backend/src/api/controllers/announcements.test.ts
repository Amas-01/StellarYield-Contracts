import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

async function ctx() {
  const { query } = await import("../../db/index.js");
  const {
    createAnnouncement,
    deleteAnnouncement,
    listActiveAnnouncements,
  } = await import("./announcements.js");
  return {
    query: query as ReturnType<typeof vi.fn>,
    createAnnouncement,
    deleteAnnouncement,
    listActiveAnnouncements,
  };
}

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as any;
}

function makeReq(overrides: any = {}) {
  return { params: {}, body: {}, query: {}, headers: {}, ...overrides } as any;
}

const next = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/admin/announcements (#1287)", () => {
  it("creates an announcement and returns it with 201", async () => {
    const { query, createAnnouncement } = await ctx();
    query.mockResolvedValue([
      {
        id: 1,
        title: "Maintenance",
        body: "Planned maintenance at 02:00 UTC",
        severity: "warning",
        starts_at: "2026-01-01T02:00:00.000Z",
        ends_at: "2026-01-01T04:00:00.000Z",
        created_at: "2025-12-31T00:00:00.000Z",
      },
    ]);
    const res = makeRes();

    await createAnnouncement(
      makeReq({
        body: {
          title: "Maintenance",
          body: "Planned maintenance at 02:00 UTC",
          severity: "warning",
          startsAt: "2026-01-01T02:00:00.000Z",
          endsAt: "2026-01-01T04:00:00.000Z",
        },
      }),
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        title: "Maintenance",
        severity: "warning",
        startsAt: "2026-01-01T02:00:00.000Z",
        endsAt: "2026-01-01T04:00:00.000Z",
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an ends_at that is not after starts_at with 400", async () => {
    const { query, createAnnouncement } = await ctx();
    const res = makeRes();

    await createAnnouncement(
      makeReq({
        body: {
          title: "Bad window",
          body: "ends before it starts",
          startsAt: "2026-01-01T04:00:00.000Z",
          endsAt: "2026-01-01T02:00:00.000Z",
        },
      }),
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a missing title with 400", async () => {
    const { createAnnouncement } = await ctx();
    const res = makeRes();
    await createAnnouncement(
      makeReq({ body: { body: "x", startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-01-02T00:00:00.000Z" } }),
      res,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe("DELETE /api/v1/admin/announcements/:id (#1287)", () => {
  it("returns 404 when the announcement does not exist", async () => {
    const { query, deleteAnnouncement } = await ctx();
    query.mockResolvedValue([]);
    const res = makeRes();

    await deleteAnnouncement(makeReq({ params: { id: "42" } }), res, next);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 204 when the announcement is deleted", async () => {
    const { query, deleteAnnouncement } = await ctx();
    query.mockResolvedValue([{ id: 42 }]);
    const res = makeRes();

    await deleteAnnouncement(makeReq({ params: { id: "42" } }), res, next);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
  });
});

describe("GET /api/v1/announcements (#1288)", () => {
  it("returns only active announcements cached for 60 seconds", async () => {
    const { query, listActiveAnnouncements } = await ctx();
    query.mockResolvedValue([
      {
        id: 2,
        title: "Delayed epoch",
        body: "Epoch 12 will settle late",
        severity: "critical",
        starts_at: "2026-01-01T00:00:00.000Z",
        ends_at: "2099-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const res = makeRes();

    await listActiveAnnouncements(makeReq(), res, next);

    expect(res.set).toHaveBeenCalledWith("Cache-Control", "public, max-age=60");
    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({ id: 2, severity: "critical" }),
    ]);
  });
});
