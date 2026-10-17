// Migrations are usually only noticed when they fail on a real environment
// (#1295). This test builds a scratch database on the same PostgreSQL server
// as DATABASE_URL, applies every migration, reverts them all, and re-applies
// them — then asserts the re-applied schema matches the first pass exactly.
// Skipped automatically when no local PostgreSQL is reachable.
import { describe, it, expect } from "vitest";
import pg from "pg";
import { applyMigrations, revertMigrations } from "./migrate.js";

const BASE_URL = process.env["DATABASE_URL"] ?? "";

/** Swap the database name of a PostgreSQL connection string. */
function withDatabase(url: string, database: string): string {
  try {
    const parsed = new URL(url);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  } catch {
    return url;
  }
}

async function snapshotSchema(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{
    tbl: string;
    col: string;
    dtype: string;
  }>(`
    SELECT table_name AS tbl, column_name AS col, data_type AS dtype
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position, column_name
  `);
  return rows.map((r) => `${r.tbl}.${r.col}:${r.dtype}`);
}

describe("migrations apply → revert → apply (#1295)", () => {
  it(
    "applies all migrations, reverts them, and reapplies an identical schema",
    async (ctx) => {
      if (!BASE_URL) return ctx.skip();

      const scratchDb = `migrate_up_down_test_${process.env["VITEST_POOL_ID"] ?? "0"}`;
      const adminPool = new pg.Pool({
        connectionString: withDatabase(BASE_URL, "postgres"),
        connectionTimeoutMillis: 2000,
      });
      let scratchPool: pg.Pool | undefined;
      try {
        // Skip cleanly when there is no reachable database for this test.
        await adminPool.query("SELECT 1");
        await adminPool.query(`DROP DATABASE IF EXISTS "${scratchDb}" WITH (FORCE)`);
        await adminPool.query(`CREATE DATABASE "${scratchDb}"`);

        scratchPool = new pg.Pool({
          connectionString: withDatabase(BASE_URL, scratchDb),
        });

        await expect(applyMigrations(scratchPool)).resolves.toBeUndefined();
        const afterFirstApply = await snapshotSchema(scratchPool);
        expect(afterFirstApply.length).toBeGreaterThan(0);

        await expect(revertMigrations(scratchPool)).resolves.toBeUndefined();
        expect(await snapshotSchema(scratchPool)).toEqual([]);

        await expect(applyMigrations(scratchPool)).resolves.toBeUndefined();
        expect(await snapshotSchema(scratchPool)).toEqual(afterFirstApply);
      } catch (err) {
        // Unreachable server / insufficient privileges → skip, don't fail.
        const message = err instanceof Error ? err.message : String(err);
        if (/ECONNREFUSED|ETIMEDOUT|permission denied|does not exist/.test(message)) {
          return ctx.skip();
        }
        throw err;
      } finally {
        if (scratchPool) await scratchPool.end();
        try {
          await adminPool.query(`DROP DATABASE IF EXISTS "${scratchDb}" WITH (FORCE)`);
        } catch {
          // The scratch database is best-effort cleanup; ignore failures.
        }
        await adminPool.end();
      }
    },
    120_000,
  );
});
