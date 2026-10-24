// Seed idempotency (#1296): running `npm run seed` twice must not duplicate
// rows and must not fail. The seed statements all rely on
// `ON CONFLICT (<key>) DO NOTHING`, so we fake `pg` with an in-memory store
// that honours that semantics and run the seed twice against the same pool.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("pg", () => {
  // In-memory stand-in for the seeded tables, keyed by the conflict column
  // value each INSERT targets (first string literal in the SQL).
  const state = {
    tables: new Map<string, Set<string>>(),
    queries: [] as { sql: string; rowCount: number }[],
    reset() {
      state.tables.clear();
      state.queries.length = 0;
    },
  };

  class FakePool {
    connectionString: string;
    static state = state;
    waitingCount = 0;

    constructor(opts?: { connectionString?: string }) {
      this.connectionString = opts?.connectionString ?? "";
    }

    on() {
      return this;
    }

    async query(sql: string) {
      const insert = /insert\s+into\s+(\w+)/i.exec(sql);
      if (!insert) {
        return { rows: [], rowCount: 0 };
      }
      if (!/on\s+conflict[^;]*do\s+nothing/i.test(sql)) {
        // A seed statement without ON CONFLICT DO NOTHING would duplicate rows
        // on a second run; fail the fake loudly rather than simulate that.
        throw new Error(
          `seed query missing ON CONFLICT DO NOTHING: ${sql.trim().slice(0, 120)}`,
        );
      }
      const table = insert[1];
      const key = /'([^']*)'/.exec(sql)?.[1] ?? sql;
      let rows = state.tables.get(table);
      if (!rows) {
        rows = new Set();
        state.tables.set(table, rows);
      }
      const before = rows.size;
      rows.add(key);
      const rowCount = rows.size === before ? 0 : 1;
      state.queries.push({ sql, rowCount });
      return { rows: [], rowCount };
    }

    async connect() {
      return {
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => {},
      };
    }

    async end() {
      return undefined;
    }
  }

  return { default: { Pool: FakePool }, Pool: FakePool };
});

import pg from "pg";
import { seed } from "./seed.js";

// The direct-run wrapper maps a rejection to `process.exit(1)`; a resolved
// promise maps to exit 0. Fail the test with a clear message if seed() ever
// tries to exit early.
const exitSpy = vi
  .spyOn(process, "exit")
  .mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code}) called during seeding`);
  }) as never);

/** The shared, in-memory table state of the fake pg pool. */
interface FakeState {
  tables: Map<string, Set<string>>;
  queries: { sql: string; rowCount: number }[];
  reset(): void;
}

function fakeState(): FakeState {
  return (pg as unknown as { Pool: { state: FakeState } }).Pool.state;
}

describe("seed idempotency (#1296)", () => {
  beforeEach(() => {
    fakeState().reset();
  });

  it("produces identical row counts when run twice", async () => {
    await expect(seed()).resolves.toBeUndefined();
    const afterFirst = new Map(fakeState().tables, ([t, keys]) => [t, keys.size]);

    await expect(seed()).resolves.toBeUndefined();
    const afterSecond = new Map(fakeState().tables, ([t, keys]) => [t, keys.size]);

    expect(afterFirst.size).toBeGreaterThan(0);
    expect(afterSecond).toEqual(afterFirst);
  });

  it("does not duplicate any row on the second run", async () => {
    await seed();
    const firstRunInserts = fakeState().queries.filter((q) => q.rowCount > 0).length;

    fakeState().queries.length = 0;
    await seed();
    const secondRunInserts = fakeState().queries.filter((q) => q.rowCount > 0).length;

    expect(firstRunInserts).toBeGreaterThan(0);
    expect(secondRunInserts).toBe(0);
  });

  it("completes without calling process.exit (maps to exit code 0)", async () => {
    await expect(seed()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
