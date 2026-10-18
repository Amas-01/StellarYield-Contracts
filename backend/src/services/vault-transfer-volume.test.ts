import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn(), pool: {} }));
vi.mock("../cache/redis.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return { ...actual, xdr: actual.xdr, scValToNative: vi.fn().mockReturnValue("") };
});

import { VaultService, TRANSFER_VOLUME_PERIOD_DAYS } from "./vault.js";
import * as db from "../db/index.js";

const CONTRACT_ID = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";

/** SQL and bound parameters of the volume query. */
function volumeCall(): { sql: string; params: unknown[] } {
  const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
  return { sql, params };
}

/** An aggregate row as the query returns it. */
function aggregateRow(overrides: Record<string, unknown> = {}) {
  return {
    transfer_count: "4",
    total_volume: "13000",
    unique_senders: "3",
    unique_recipients: "4",
    ...overrides,
  };
}

describe("VaultService.getTransferVolume (#1074)", () => {
  let service: VaultService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new VaultService();
    vi.mocked(db.query).mockResolvedValue([aggregateRow()]);
  });

  it("returns the period with the counts and total volume", async () => {
    const result = await service.getTransferVolume(CONTRACT_ID, "7d");

    expect(result).toEqual({
      period: "7d",
      transferCount: 4,
      totalVolume: "13000",
      uniqueSenders: 3,
      uniqueRecipients: 4,
    });
  });

  it("returns totalVolume as a string so a large sum is not rounded", async () => {
    const huge = "170141183460469231731687303715884105727";
    vi.mocked(db.query).mockResolvedValue([aggregateRow({ total_volume: huge })]);

    const result = await service.getTransferVolume(CONTRACT_ID, "30d");

    expect(result.totalVolume).toBe(huge);
    expect(typeof result.totalVolume).toBe("string");
  });

  it("maps each period to its day count", async () => {
    expect(TRANSFER_VOLUME_PERIOD_DAYS).toEqual({ "1d": 1, "7d": 7, "30d": 30 });
  });

  it("binds the day count for the requested period", async () => {
    await service.getTransferVolume(CONTRACT_ID, "30d");

    expect(volumeCall().params).toEqual([CONTRACT_ID, 30]);
  });

  it("scopes the aggregate to the requested vault", async () => {
    await service.getTransferVolume(CONTRACT_ID, "7d");

    const { sql, params } = volumeCall();
    expect(sql).toContain("v.contract_id = $1");
    expect(params[0]).toBe(CONTRACT_ID);
    expect(sql).not.toContain(CONTRACT_ID);
  });

  it("aggregates over the transfers table", async () => {
    await service.getTransferVolume(CONTRACT_ID, "7d");

    const { sql } = volumeCall();
    expect(sql).toContain("FROM transfers t");
    expect(sql).toContain("COUNT(*)");
    expect(sql).toContain("SUM(t.amount)");
    expect(sql).toContain("COUNT(DISTINCT t.from_address)");
    expect(sql).toContain("COUNT(DISTINCT t.to_address)");
  });

  it("counts senders and recipients distinctly, not per row", async () => {
    // A holder trading repeatedly is one participant, however many transfers
    // they make.
    await service.getTransferVolume(CONTRACT_ID, "7d");

    const { sql } = volumeCall();
    expect(sql).toContain("COUNT(DISTINCT t.from_address)");
    expect(sql).toContain("COUNT(DISTINCT t.to_address)");
  });

  it("bounds the window on created_at so the index can seek to it", async () => {
    await service.getTransferVolume(CONTRACT_ID, "7d");

    const { sql } = volumeCall();
    expect(sql).toContain("t.created_at >=");
  });

  it("counts calendar days in UTC rather than a rolling window", async () => {
    // A rolling 168 hours straddles eight calendar dates; truncating to the day
    // first makes "the last 7 days" mean seven dates.
    await service.getTransferVolume(CONTRACT_ID, "7d");

    const { sql } = volumeCall();
    expect(sql).toContain("date_trunc('day', now() AT TIME ZONE 'UTC')");
    expect(sql).toContain("make_interval(days => $2::int - 1)");
  });

  it("casts the total to text in SQL so no precision is lost in transit", async () => {
    await service.getTransferVolume(CONTRACT_ID, "7d");

    // pg returns NUMERIC as a string by default, but being explicit means the
    // result does not depend on a client type parser.
    expect(volumeCall().sql).toContain("COALESCE(SUM(t.amount), 0)::text");
  });

  it("reports zeroes for a vault with no transfers in the window", async () => {
    vi.mocked(db.query).mockResolvedValue([aggregateRow({
      transfer_count: "0",
      total_volume: "0",
      unique_senders: "0",
      unique_recipients: "0",
    })]);

    const result = await service.getTransferVolume(CONTRACT_ID, "1d");

    expect(result).toEqual({
      period: "1d",
      transferCount: 0,
      totalVolume: "0",
      uniqueSenders: 0,
      uniqueRecipients: 0,
    });
  });

  it("falls back to zeroes when the aggregate returns no row at all", async () => {
    vi.mocked(db.query).mockResolvedValue([]);

    const result = await service.getTransferVolume(CONTRACT_ID, "7d");

    expect(result.transferCount).toBe(0);
    expect(result.totalVolume).toBe("0");
  });

  it("survives a NULL sum from an all-outside-the-window match", async () => {
    vi.mocked(db.query).mockResolvedValue([aggregateRow({ total_volume: null })]);

    const result = await service.getTransferVolume(CONTRACT_ID, "7d");

    expect(result.totalVolume).toBe("0");
  });
});
