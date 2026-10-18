import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

const mocks = vi.hoisted(() => ({
  getVaultEpochs: vi.fn(),
  getEpochsInRange: vi.fn(),
  getClaimStatsForVault: vi.fn(),
  getHolderCountsForVault: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));

vi.mock("../../services/yield.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/yield.js")>();
  return {
    ...actual,
    InvalidEpochCursorError: actual.InvalidEpochCursorError,
    YieldService: vi.fn(() => ({
      getVaultEpochs: mocks.getVaultEpochs,
      getEpochsInRange: mocks.getEpochsInRange,
      getClaimStatsForVault: mocks.getClaimStatsForVault,
      getHolderCountsForVault: mocks.getHolderCountsForVault,
      deriveEpochStatus: actual.YieldService.prototype.deriveEpochStatus,
      calculateParticipationRate: actual.YieldService.prototype.calculateParticipationRate,
    })),
  };
});

import { InvalidEpochCursorError } from "../../services/yield.js";
import { yieldsRouter } from "./yields.js";

function buildApp() {
  const app = express();
  app.use("/api/v1/yields", yieldsRouter);
  return app;
}

const request = supertest(buildApp());

const CONTRACT_ID = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";
const EPOCHS_PATH = `/api/v1/yields/${CONTRACT_ID}/epochs`;

/** An epoch summary as the service would return it. */
function epochRow(epoch: number, yieldAmount = "1000", totalShares = "1000") {
  return {
    id: epoch,
    vaultId: 10,
    epoch,
    yieldAmount,
    totalShares,
    distributedAt: new Date("2025-02-01T00:00:00.000Z"),
    netYield: yieldAmount,
  };
}

/** Options forwarded to YieldService.getEpochsInRange. */
function forwardedRange() {
  return mocks.getEpochsInRange.mock.calls[0][1];
}

describe("GET /api/v1/yields/:contractId/epochs multi-epoch window (#1072)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEpochsInRange.mockResolvedValue({ epochs: [], nextCursor: null });
    mocks.getVaultEpochs.mockResolvedValue([]);
    mocks.getClaimStatsForVault.mockResolvedValue(new Map());
    mocks.getHolderCountsForVault.mockResolvedValue(new Map());
  });

  it("forwards an inclusive from/to window", async () => {
    const res = await request.get(`${EPOCHS_PATH}?from=3&to=9`);

    expect(res.status).toBe(200);
    expect(forwardedRange()).toMatchObject({ from: 3, to: 9 });
  });

  it("accepts from or to on its own as an open-ended window", async () => {
    await request.get(`${EPOCHS_PATH}?from=3`);
    expect(forwardedRange()).toMatchObject({ from: 3, to: undefined });

    vi.clearAllMocks();
    await request.get(`${EPOCHS_PATH}?to=9`);
    expect(forwardedRange()).toMatchObject({ from: undefined, to: 9 });
  });

  it("returns 400 when from is greater than to", async () => {
    const res = await request.get(`${EPOCHS_PATH}?from=9&to=3`);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.issues)).toContain("must not be greater than");
    expect(mocks.getEpochsInRange).not.toHaveBeenCalled();
  });

  it("accepts an equal from and to, which selects a single epoch", async () => {
    const res = await request.get(`${EPOCHS_PATH}?from=5&to=5`);

    expect(res.status).toBe(200);
  });

  it("returns 400 for a non-numeric, fractional or zero bound", async () => {
    expect((await request.get(`${EPOCHS_PATH}?from=abc`)).status).toBe(400);
    expect((await request.get(`${EPOCHS_PATH}?to=1.5`)).status).toBe(400);
    expect((await request.get(`${EPOCHS_PATH}?from=0`)).status).toBe(400);
  });
});

describe("GET /api/v1/yields/:contractId/epochs pagination (#1072)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEpochsInRange.mockResolvedValue({ epochs: [], nextCursor: null });
    mocks.getVaultEpochs.mockResolvedValue([]);
    mocks.getClaimStatsForVault.mockResolvedValue(new Map());
    mocks.getHolderCountsForVault.mockResolvedValue(new Map());
  });

  it("defaults the page size to 100 when a window is requested without a limit", async () => {
    await request.get(`${EPOCHS_PATH}?from=1&to=5`);

    expect(forwardedRange().limit).toBe(100);
  });

  it("forwards an explicit limit", async () => {
    await request.get(`${EPOCHS_PATH}?from=1&to=5&limit=25`);

    expect(forwardedRange().limit).toBe(25);
  });

  it("accepts a limit up to the 500-row cap", async () => {
    expect((await request.get(`${EPOCHS_PATH}?limit=500`)).status).toBe(200);
  });

  it("returns 400 for a limit above the cap", async () => {
    const res = await request.get(`${EPOCHS_PATH}?limit=501`);

    expect(res.status).toBe(400);
  });

  it("returns 400 for a zero or negative limit", async () => {
    expect((await request.get(`${EPOCHS_PATH}?limit=0`)).status).toBe(400);
    expect((await request.get(`${EPOCHS_PATH}?limit=-1`)).status).toBe(400);
  });

  it("returns 400 for a fractional limit", async () => {
    expect((await request.get(`${EPOCHS_PATH}?limit=2.5`)).status).toBe(400);
  });

  it("forwards a valid cursor", async () => {
    const cursor = Buffer.from(JSON.stringify({ v: 1, c: CONTRACT_ID, e: 2 }), "utf8").toString(
      "base64url",
    );

    await request.get(`${EPOCHS_PATH}?limit=2&cursor=${cursor}`);

    expect(forwardedRange().cursor).toBe(cursor);
  });

  it("returns 400 for a cursor that is not a base64url token", async () => {
    // Rejected at the edge so garbage never reaches the query builder.
    const res = await request.get(`${EPOCHS_PATH}?cursor=not%20base64%21%21`);

    expect(res.status).toBe(400);
    expect(mocks.getEpochsInRange).not.toHaveBeenCalled();
  });

  it("returns 400 when the service rejects the cursor", async () => {
    // Well-formed encoding but the wrong vault or version: only the service
    // knows that, and the failure is a client error, not a 500.
    mocks.getEpochsInRange.mockRejectedValue(new InvalidEpochCursorError("Cursor was issued for a different vault"));

    const res = await request.get(`${EPOCHS_PATH}?cursor=abc123`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BadRequest");
  });

  it("exposes the next cursor in a response header, leaving the body an array", async () => {
    mocks.getEpochsInRange.mockResolvedValue({
      epochs: [epochRow(1), epochRow(2)],
      nextCursor: "Y3Vyc29y",
    });

    const res = await request.get(`${EPOCHS_PATH}?from=1&limit=2`);

    expect(res.status).toBe(200);
    expect(res.headers["x-next-cursor"]).toBe("Y3Vyc29y");
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("omits the header on the final page", async () => {
    mocks.getEpochsInRange.mockResolvedValue({ epochs: [epochRow(1)], nextCursor: null });

    const res = await request.get(`${EPOCHS_PATH}?from=1&limit=2`);

    expect(res.status).toBe(200);
    expect(res.headers["x-next-cursor"]).toBeUndefined();
  });

  it("returns the same epoch summary shape the listing already returns", async () => {
    mocks.getEpochsInRange.mockResolvedValue({ epochs: [epochRow(1, "2000", "1000")], nextCursor: null });

    const res = await request.get(`${EPOCHS_PATH}?from=1&limit=2`);

    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      epoch: 1,
      yieldAmount: "2000",
      totalShares: "1000",
      // A batch caller needs the same derived fields the listing provides.
      yieldPerShare: "2.000000000000000000",
    });
    expect(res.body[0].status).toBeDefined();
    expect(res.body[0].participationRate).toBeDefined();
  });

  it("returns an empty array for an empty window", async () => {
    mocks.getEpochsInRange.mockResolvedValue({ epochs: [], nextCursor: null });

    const res = await request.get(`${EPOCHS_PATH}?from=99&to=100`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("GET /api/v1/yields/:contractId/epochs backwards compatibility (#1072)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClaimStatsForVault.mockResolvedValue(new Map());
    mocks.getHolderCountsForVault.mockResolvedValue(new Map());
  });

  it("keeps the original unbounded listing when no paging parameter is given", async () => {
    mocks.getVaultEpochs.mockResolvedValue([epochRow(1), epochRow(2)]);

    const res = await request.get(EPOCHS_PATH);

    expect(res.status).toBe(200);
    expect(mocks.getVaultEpochs).toHaveBeenCalled();
    expect(mocks.getEpochsInRange).not.toHaveBeenCalled();
    expect(res.body).toHaveLength(2);
    expect(res.headers["x-next-cursor"]).toBeUndefined();
  });

  it("still returns a bare array, not an envelope", async () => {
    mocks.getVaultEpochs.mockResolvedValue([epochRow(1)]);

    const res = await request.get(EPOCHS_PATH);

    expect(Array.isArray(res.body)).toBe(true);
  });

  it("still supports the pre-existing yield range filters unpaged", async () => {
    mocks.getVaultEpochs.mockResolvedValue([]);

    const res = await request.get(`${EPOCHS_PATH}?minYield=100&maxYield=500`);

    expect(res.status).toBe(200);
    expect(mocks.getVaultEpochs).toHaveBeenCalledWith(CONTRACT_ID, {
      minYield: "100",
      maxYield: "500",
    });
    expect(mocks.getEpochsInRange).not.toHaveBeenCalled();
  });

  it("rejects a yield range inversion on the paged path too", async () => {
    const res = await request.get(`${EPOCHS_PATH}?from=1&minYield=500&maxYield=100`);

    expect(res.status).toBe(400);
  });

  it("applies the yield range alongside the window instead of dropping it", async () => {
    // Silently ignoring minYield here would return epochs the caller filtered
    // out, which reads as correct data rather than a mistake.
    mocks.getEpochsInRange.mockResolvedValue({ epochs: [], nextCursor: null });

    const res = await request.get(`${EPOCHS_PATH}?from=2&to=9&limit=5&minYield=100&maxYield=500`);

    expect(res.status).toBe(200);
    expect(mocks.getEpochsInRange).toHaveBeenCalledWith(CONTRACT_ID, {
      from: 2,
      to: 9,
      limit: 5,
      cursor: undefined,
      minYield: "100",
      maxYield: "500",
    });
  });

  it("leaves the yield bounds undefined when not requested", async () => {
    mocks.getEpochsInRange.mockResolvedValue({ epochs: [], nextCursor: null });

    await request.get(`${EPOCHS_PATH}?from=2`);

    expect(mocks.getEpochsInRange).toHaveBeenCalledWith(
      CONTRACT_ID,
      expect.objectContaining({ minYield: undefined, maxYield: undefined }),
    );
  });
});
