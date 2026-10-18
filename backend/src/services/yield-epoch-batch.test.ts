import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../cache/redis.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

import { YieldService, InvalidEpochCursorError } from "./yield.js";
import * as db from "../db/index.js";
import * as cache from "../cache/redis.js";
import { buildEpoch } from "../../tests/builders/index.js";

const CONTRACT_ID = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";
const OTHER_CONTRACT_ID = "CBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** Build a page of epoch rows, ascending by epoch. */
function epochRows(epochs: number[]) {
  return epochs.map((epoch) =>
    buildEpoch({
      id: epoch,
      vault_id: 10,
      epoch,
      yield_amount: String(epoch * 100),
    }),
  );
}

/** Decode an issued cursor to assert on its shape. */
function decodeCursor(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

function sqlAndParams() {
  const [sql, params] = vi.mocked(db.query).mock.calls[0] as [string, unknown[]];
  return { sql, params };
}

describe("YieldService.getEpochsInRange window (#1072)", () => {
  let service: YieldService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new YieldService();
    vi.mocked(db.query).mockResolvedValue([]);
  });

  it("applies an inclusive lower bound", async () => {
    await service.getEpochsInRange(CONTRACT_ID, { from: 3, limit: 10 });

    const { sql, params } = sqlAndParams();
    expect(sql).toContain("e.epoch >= $2");
    expect(params).toEqual([CONTRACT_ID, 3, 11]);
  });

  it("applies an inclusive upper bound", async () => {
    await service.getEpochsInRange(CONTRACT_ID, { to: 9, limit: 10 });

    const { sql, params } = sqlAndParams();
    expect(sql).toContain("e.epoch <= $2");
    expect(params).toEqual([CONTRACT_ID, 9, 11]);
  });

  it("applies both bounds together", async () => {
    await service.getEpochsInRange(CONTRACT_ID, { from: 3, to: 9, limit: 10 });

    const { sql, params } = sqlAndParams();
    expect(sql).toContain("e.epoch >= $2");
    expect(sql).toContain("e.epoch <= $3");
    expect(params).toEqual([CONTRACT_ID, 3, 9, 11]);
  });

  it("leaves the window open when no bounds are supplied", async () => {
    await service.getEpochsInRange(CONTRACT_ID, { limit: 10 });

    const { sql } = sqlAndParams();
    expect(sql).not.toContain("e.epoch >=");
    expect(sql).not.toContain("e.epoch <=");
  });

  it("orders ascending by epoch so a chart reads left to right", async () => {
    await service.getEpochsInRange(CONTRACT_ID, { limit: 10 });

    expect(sqlAndParams().sql).toContain("ORDER BY e.epoch ASC");
  });

  it("over-fetches by one row to detect whether another page exists", async () => {
    await service.getEpochsInRange(CONTRACT_ID, { limit: 25 });

    // limit + 1, so no COUNT(*) is needed to know if there is more.
    expect(sqlAndParams().params.at(-1)).toBe(26);
    expect(sqlAndParams().sql).not.toContain("COUNT(");
  });

  it("binds the window as parameters rather than inlining them", async () => {
    await service.getEpochsInRange(CONTRACT_ID, { from: 3, to: 9, limit: 10 });

    expect(sqlAndParams().sql).not.toMatch(/e\.epoch >= \d/);
  });

  it("is not cached, since a stale page would contradict its own cursor", async () => {
    await service.getEpochsInRange(CONTRACT_ID, { limit: 10 });

    expect(cache.cacheGet).not.toHaveBeenCalled();
    expect(cache.cacheSet).not.toHaveBeenCalled();
  });

  it("maps rows to epoch objects with netYield falling back to yieldAmount", async () => {
    vi.mocked(db.query).mockResolvedValue([
      { ...epochRows([1])[0] },
      { ...epochRows([2])[0], net_yield: "150" },
    ]);

    const page = await service.getEpochsInRange(CONTRACT_ID, { limit: 10 });

    expect(page.epochs[0].netYield).toBe("100");
    expect(page.epochs[1].netYield).toBe("150");
  });
});

describe("YieldService.getEpochsInRange yield bounds (#1072)", () => {
  let service: YieldService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.query).mockResolvedValue([]);
    service = new YieldService();
  });

  it("filters on yield_amount the same way the unbounded listing does", async () => {
    await service.getEpochsInRange(CONTRACT_ID, { limit: 10, minYield: "100", maxYield: "500" });

    const { sql } = sqlAndParams();
    expect(sql).toContain("e.yield_amount >=");
    expect(sql).toContain("e.yield_amount <=");
  });

  it("compares against NUMERIC so a large bound keeps full precision", async () => {
    await service.getEpochsInRange(CONTRACT_ID, { limit: 10, minYield: "100" });

    expect(sqlAndParams().sql).toContain("::numeric");
  });

  it("binds the bounds instead of inlining them", async () => {
    await service.getEpochsInRange(CONTRACT_ID, { limit: 10, minYield: "100", maxYield: "500" });

    const { sql, params } = sqlAndParams();
    expect(sql).not.toMatch(/e\.yield_amount >= \d/);
    expect(params).toEqual(expect.arrayContaining(["100", "500"]));
  });

  it("omits the conditions entirely when no bound is supplied", async () => {
    await service.getEpochsInRange(CONTRACT_ID, { limit: 10 });

    // Scoped to the WHERE clause: the SELECT list always names e.yield_amount.
    const where = sqlAndParams().sql.slice(sqlAndParams().sql.indexOf("WHERE"));
    expect(where).not.toContain("e.yield_amount >=");
    expect(where).not.toContain("e.yield_amount <=");
  });

  it("composes with the epoch window and the cursor rather than replacing them", async () => {
    const cursor = Buffer.from(JSON.stringify({ v: 1, c: CONTRACT_ID, e: 4 }), "utf8").toString("base64url");

    await service.getEpochsInRange(CONTRACT_ID, { limit: 10, from: 2, to: 20, minYield: "100", cursor });

    const { sql } = sqlAndParams();
    expect(sql).toContain("e.epoch >=");
    expect(sql).toContain("e.epoch <=");
    expect(sql).toContain("e.epoch >");
    expect(sql).toContain("e.yield_amount >=");
  });
});

describe("YieldService.getEpochsInRange pagination (#1072)", () => {
  let service: YieldService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new YieldService();
  });

  it("returns no cursor when the page is not full", async () => {
    vi.mocked(db.query).mockResolvedValue(epochRows([1, 2]));

    const page = await service.getEpochsInRange(CONTRACT_ID, { limit: 5 });

    expect(page.epochs).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("trims the over-fetched row and issues a cursor when more pages remain", async () => {
    vi.mocked(db.query).mockResolvedValue(epochRows([1, 2, 3]));

    const page = await service.getEpochsInRange(CONTRACT_ID, { limit: 2 });

    expect(page.epochs.map((e) => e.epoch)).toEqual([1, 2]);
    expect(page.nextCursor).not.toBeNull();
  });

  it("points the cursor at the last returned epoch, not the trimmed one", async () => {
    vi.mocked(db.query).mockResolvedValue(epochRows([1, 2, 3]));

    const page = await service.getEpochsInRange(CONTRACT_ID, { limit: 2 });

    // Resuming from 3 would silently drop epoch 3; from 2 repeats nothing.
    expect(decodeCursor(page.nextCursor!).e).toBe(2);
  });

  it("emits an opaque base64url token, not readable JSON", async () => {
    vi.mocked(db.query).mockResolvedValue(epochRows([1, 2, 3]));

    const page = await service.getEpochsInRange(CONTRACT_ID, { limit: 2 });

    expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(page.nextCursor).not.toContain("epoch");
  });

  it("binds the vault into the cursor so it cannot be replayed elsewhere", async () => {
    vi.mocked(db.query).mockResolvedValue(epochRows([1, 2, 3]));

    const page = await service.getEpochsInRange(CONTRACT_ID, { limit: 2 });

    expect(decodeCursor(page.nextCursor!).c).toBe(CONTRACT_ID);
  });

  it("versions the cursor so its shape can change later", async () => {
    vi.mocked(db.query).mockResolvedValue(epochRows([1, 2, 3]));

    const page = await service.getEpochsInRange(CONTRACT_ID, { limit: 2 });

    expect(decodeCursor(page.nextCursor!).v).toBe(1);
  });

  it("seeks strictly past the cursor epoch so a page boundary is not repeated", async () => {
    const first = await (async () => {
      vi.mocked(db.query).mockResolvedValue(epochRows([1, 2, 3]));
      return service.getEpochsInRange(CONTRACT_ID, { limit: 2 });
    })();
    vi.clearAllMocks();

    vi.mocked(db.query).mockResolvedValue(epochRows([3, 4]));
    await service.getEpochsInRange(CONTRACT_ID, { limit: 2, cursor: first.nextCursor! });

    const { sql, params } = sqlAndParams();
    expect(sql).toContain("e.epoch > $2");
    expect(params).toEqual([CONTRACT_ID, 2, 3]);
  });

  it("returns no cursor on the final page even when the query fills the page", async () => {
    const first = await (async () => {
      vi.mocked(db.query).mockResolvedValue(epochRows([1, 2, 3]));
      return service.getEpochsInRange(CONTRACT_ID, { limit: 2 });
    })();

    // Exactly `limit` rows means the previous over-fetch found nothing more.
    vi.mocked(db.query).mockResolvedValue(epochRows([3, 4]));
    const last = await service.getEpochsInRange(CONTRACT_ID, { limit: 2, cursor: first.nextCursor! });

    expect(last.epochs.map((e) => e.epoch)).toEqual([3, 4]);
    expect(last.nextCursor).toBeNull();
  });

  it("returns an empty page with no cursor when the window matches nothing", async () => {
    vi.mocked(db.query).mockResolvedValue([]);

    const page = await service.getEpochsInRange(CONTRACT_ID, { from: 50, limit: 10 });

    expect(page.epochs).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("YieldService.getEpochsInRange cursor rejection (#1072)", () => {
  let service: YieldService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new YieldService();
    vi.mocked(db.query).mockResolvedValue([]);
  });

  /** A syntactically valid base64url token whose payload is arbitrary. */
  function token(payload: unknown): string {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  }

  it("rejects a cursor that is not valid base64url", async () => {
    await expect(
      service.getEpochsInRange(CONTRACT_ID, { limit: 10, cursor: "not base64!!" }),
    ).rejects.toBeInstanceOf(InvalidEpochCursorError);
  });

  it("rejects a cursor that is not JSON", async () => {
    const cursor = Buffer.from("just some text", "utf8").toString("base64url");

    await expect(
      service.getEpochsInRange(CONTRACT_ID, { limit: 10, cursor }),
    ).rejects.toBeInstanceOf(InvalidEpochCursorError);
  });

  it("rejects a non-object payload", async () => {
    await expect(
      service.getEpochsInRange(CONTRACT_ID, { limit: 10, cursor: token([1, 2, 3]) }),
    ).rejects.toBeInstanceOf(InvalidEpochCursorError);
    await expect(
      service.getEpochsInRange(CONTRACT_ID, { limit: 10, cursor: token("epoch=2") }),
    ).rejects.toBeInstanceOf(InvalidEpochCursorError);
  });

  it("rejects a cursor from an unsupported version", async () => {
    await expect(
      service.getEpochsInRange(CONTRACT_ID, {
        limit: 10,
        cursor: token({ v: 2, c: CONTRACT_ID, e: 2 }),
      }),
    ).rejects.toBeInstanceOf(InvalidEpochCursorError);
  });

  it("rejects a cursor issued for a different vault", async () => {
    // Otherwise a client could page through another vault's history.
    await expect(
      service.getEpochsInRange(CONTRACT_ID, {
        limit: 10,
        cursor: token({ v: 1, c: OTHER_CONTRACT_ID, e: 2 }),
      }),
    ).rejects.toBeInstanceOf(InvalidEpochCursorError);
  });

  it("rejects a cursor whose epoch is missing or not a non-negative integer", async () => {
    for (const e of [undefined, null, -1, 1.5, "2"]) {
      await expect(
        service.getEpochsInRange(CONTRACT_ID, {
          limit: 10,
          cursor: token({ v: 1, c: CONTRACT_ID, e }),
        }),
      ).rejects.toBeInstanceOf(InvalidEpochCursorError);
    }
  });

  it("does not run the query when the cursor is rejected", async () => {
    await expect(
      service.getEpochsInRange(CONTRACT_ID, {
        limit: 10,
        cursor: token({ v: 1, c: OTHER_CONTRACT_ID, e: 2 }),
      }),
    ).rejects.toBeInstanceOf(InvalidEpochCursorError);

    expect(db.query).not.toHaveBeenCalled();
  });
});
