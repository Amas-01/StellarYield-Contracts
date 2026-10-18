import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  ANOMALY_MIN_SAMPLE_SIZE,
  ANOMALY_SIGMA_THRESHOLD,
  ANOMALY_WINDOW,
  EpochAnomalyService,
} from "./epochAnomaly.js";
import * as db from "../db/index.js";
import { logger } from "../logger.js";

const CONTRACT_ID = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";

/** SQL and bound parameters of the most recent query. */
function lastCall(index = -1): { sql: string; params: unknown[] } {
  const [sql, params] = vi.mocked(db.query).mock.calls.at(index) as [string, unknown[]];
  return { sql, params };
}

function scanCall(): { sql: string; params: unknown[] } {
  return lastCall(0);
}

/** A row as the INSERT ... RETURNING join would produce. */
function insertedRow(overrides: Record<string, unknown> = {}) {
  return {
    epoch: 11,
    yield_amount: "5000",
    mean_yield: "1000",
    stddev_yield: "0",
    sample_size: 10,
    z_score: null,
    detected_at: new Date("2025-03-01T00:00:00.000Z"),
    contract_id: CONTRACT_ID,
    ...overrides,
  };
}

describe("EpochAnomalyService.scanAndRecord detection window (#1073)", () => {
  let service: EpochAnomalyService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new EpochAnomalyService();
    vi.mocked(db.query).mockResolvedValue([]);
  });

  it("scores a 30-epoch trailing window per vault", async () => {
    expect(ANOMALY_WINDOW).toBe(30);
    await service.scanAndRecord();
    // A single named window over the whole set: one pass instead of a query per
    // candidate epoch.
    expect(scanCall().sql).toContain("RANGE BETWEEN 30 PRECEDING AND 1 PRECEDING");
    expect(scanCall().sql).toContain("PARTITION BY e.vault_id");
  });

  it("excludes the candidate epoch from its own statistics", async () => {
    await service.scanAndRecord();
    // Otherwise a large epoch inflates the mean and stddev enough to hide itself.
    expect(scanCall().sql).toContain("1 PRECEDING");
  });

  it("computes the mean and standard deviation in SQL", async () => {
    await service.scanAndRecord();
    const { sql } = scanCall();
    expect(sql).toContain("AVG(e.yield_amount) OVER w AS mean_yield");
    expect(sql).toContain("STDDEV_POP(e.yield_amount) OVER w");
  });

  it("uses the population standard deviation over the full trailing window", async () => {
    // The trailing epochs are the entire population being compared against, not
    // a sample drawn from a larger one.
    await service.scanAndRecord();
    expect(scanCall().sql).toContain("STDDEV_POP");
    expect(scanCall().sql).not.toContain("STDDEV_SAMP");
  });

  it("only scores finalized epochs", async () => {
    // An epoch still taking claims can still move, so a flag raised against it
    // could be wrong by the time anyone reads it.
    await service.scanAndRecord();
    expect(scanCall().sql).toContain("e.closed_at IS NOT NULL");
  });

  it("requires a meaningful sample before flagging anything", async () => {
    expect(ANOMALY_MIN_SAMPLE_SIZE).toBe(7);
    await service.scanAndRecord();
    const { sql, params } = scanCall();
    expect(sql).toContain("s.sample_size >= $1");
    expect(params[0]).toBe(ANOMALY_MIN_SAMPLE_SIZE);
  });

  it("flags a deviation beyond the threshold, in either direction", async () => {
    await service.scanAndRecord();
    const { sql } = scanCall();
    // ABS() so a yield that collapses is caught as readily as one that spikes.
    expect(sql).toContain("ABS(s.yield_amount - s.mean_yield) / s.stddev_yield > $2");
    expect(ANOMALY_SIGMA_THRESHOLD).toBe(3);
  });

  it("binds the threshold rather than inlining it", async () => {
    await service.scanAndRecord();
    const { sql, params } = scanCall();
    expect(params[1]).toBe(ANOMALY_SIGMA_THRESHOLD);
    expect(sql).not.toMatch(/>\s*3\s*$/m);
  });

  it("treats any deviation from a perfectly flat window as a flag", async () => {
    // With stddev 0 three sigma is zero, so a single unit of difference is
    // already past the threshold.
    await service.scanAndRecord();
    const { sql } = scanCall();
    expect(sql).toContain("(s.stddev_yield = 0 AND s.yield_amount <> s.mean_yield)");
  });

  it("leaves the z-score null when the standard deviation is zero", async () => {
    // The ratio is undefined there; storing a sentinel would dress a division by
    // zero up as a measured value.
    await service.scanAndRecord();
    const { sql } = scanCall();
    expect(sql).toContain("CASE WHEN stddev_yield = 0 THEN NULL");
  });
});

describe("EpochAnomalyService.scanAndRecord persistence (#1073)", () => {
  let service: EpochAnomalyService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new EpochAnomalyService();
  });

  it("inserts into epoch_anomalies with the statistics that produced the flag", () => {
    vi.mocked(db.query).mockResolvedValue([]);

    service.scanAndRecord();

    const { sql } = scanCall();
    expect(sql).toContain("INSERT INTO epoch_anomalies");
    for (const column of [
      "vault_id",
      "epoch",
      "yield_amount",
      "mean_yield",
      "stddev_yield",
      "sample_size",
      "z_score",
    ]) {
      expect(sql).toContain(column);
    }
  });

  it("is idempotent, so a retry cannot duplicate a recorded anomaly", () => {
    vi.mocked(db.query).mockResolvedValue([]);

    service.scanAndRecord();

    // The daily job re-scores on every run and pg-boss retries on failure.
    expect(scanCall().sql).toContain("ON CONFLICT (vault_id, epoch) DO NOTHING");
  });

  it("joins the contract id back in the same round trip", () => {
    vi.mocked(db.query).mockResolvedValue([]);

    service.scanAndRecord();

    // RETURNING only exposes the inserted table, so the contract id has to come
    // from the flagged CTE rather than a follow-up query per row.
    expect(scanCall().sql).toContain("FROM inserted i");
    expect(scanCall().sql).toContain("JOIN flagged f");
  });

  it("runs exactly one query for the whole scan", () => {
    vi.mocked(db.query).mockResolvedValue([]);

    service.scanAndRecord();

    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("returns the anomalies it recorded", async () => {
    vi.mocked(db.query).mockResolvedValue([
      insertedRow({ epoch: 12, yield_amount: "5000", mean_yield: "1000", z_score: "40" }),
    ]);

    const anomalies = await service.scanAndRecord();

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toEqual({
      vaultId: CONTRACT_ID,
      epochId: 12,
      yieldAmount: "5000",
      meanYield: "1000",
      stddevYield: "0",
      sampleSize: 10,
      zScore: "40",
      detectedAt: "2025-03-01T00:00:00.000Z",
    });
  });

  it("returns an empty list when nothing deviated", async () => {
    vi.mocked(db.query).mockResolvedValue([]);

    expect(await service.scanAndRecord()).toEqual([]);
  });

  it("logs a warning for each anomaly, as the issue requires", async () => {
    vi.mocked(db.query).mockResolvedValue([
      insertedRow({ epoch: 11 }),
      insertedRow({ epoch: 12, contract_id: "COTHER" }),
    ]);

    await service.scanAndRecord();

    expect(logger.warn).toHaveBeenCalledTimes(2);
    const [context] = vi.mocked(logger.warn).mock.calls[0];
    expect(context).toMatchObject({ contractId: CONTRACT_ID, epoch: 11 });
  });

  it("does not warn when the scan is clean", async () => {
    vi.mocked(db.query).mockResolvedValue([]);

    await service.scanAndRecord();

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("EpochAnomalyService.listForVault (#1073)", () => {
  let service: EpochAnomalyService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new EpochAnomalyService();
  });

  it("orders anomalies by epoch descending", () => {
    vi.mocked(db.query).mockResolvedValue([]);

    service.listForVault(CONTRACT_ID);

    // Newest first: the epoch that just tripped the detector is the one under
    // investigation.
    expect(lastCall().sql).toContain("ORDER BY a.epoch DESC");
  });

  it("scopes the query to the requested vault", () => {
    vi.mocked(db.query).mockResolvedValue([]);

    service.listForVault(CONTRACT_ID);

    const { sql, params } = lastCall();
    expect(sql).toContain("v.contract_id = $1");
    expect(params[0]).toBe(CONTRACT_ID);
  });

  it("maps rows to anomaly records", async () => {
    vi.mocked(db.query).mockResolvedValue([insertedRow({ epoch: 42 })]);

    const anomalies = await service.listForVault(CONTRACT_ID);

    expect(anomalies[0]).toMatchObject({
      vaultId: CONTRACT_ID,
      epochId: 42,
      yieldAmount: "5000",
      meanYield: "1000",
      sampleSize: 10,
      zScore: null,
    });
  });

  it("returns an empty list for a vault with no anomalies", async () => {
    vi.mocked(db.query).mockResolvedValue([]);

    expect(await service.listForVault(CONTRACT_ID)).toEqual([]);
  });

  it("keeps amounts as strings so a large yield is not rounded through a double", async () => {
    const huge = "170141183460469231731687303715884105727";
    vi.mocked(db.query).mockResolvedValue([insertedRow({ yield_amount: huge, z_score: "12.5" })]);

    const anomalies = await service.listForVault(CONTRACT_ID);

    expect(anomalies[0].yieldAmount).toBe(huge);
    expect(anomalies[0].zScore).toBe("12.5");
  });
});
