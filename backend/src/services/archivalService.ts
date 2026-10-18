import { query } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

interface ArchiveTableSpec {
  tableName: string;
  idColumn: string;
  vaultJoinColumn: "contract_id" | "vault_id";
  retentionDays: number;
  timestampColumn: string;
}

const ARCHIVE_TABLES: ArchiveTableSpec[] = [
  {
    tableName: "indexed_events",
    idColumn: "id",
    vaultJoinColumn: "contract_id",
    retentionDays: 90,
    timestampColumn: "created_at",
  },
  {
    // #920 — Archive share_balance_snapshots older than SNAPSHOT_RETENTION_DAYS
    // (default 730 days / 2 years). Historical share history queries read from
    // both live and archive tables when the requested range spans the boundary.
    tableName: "share_balance_snapshots",
    idColumn: "id",
    vaultJoinColumn: "vault_id",
    retentionDays: 730,
    timestampColumn: "recorded_at",
  },
  {
    // #919 — Archive vault_tvl_snapshots older than TVL_SNAPSHOT_RETENTION_DAYS
    // (default 365 days). GET /api/v1/vaults/:contractId/tvl-history reads from
    // both live and archive tables when `from` extends into the archive range.
    tableName: "vault_tvl_snapshots",
    idColumn: "id",
    vaultJoinColumn: "vault_id",
    retentionDays: 365,
    timestampColumn: "recorded_at",
  },
];

async function ensureArchiveTable(liveTable: string): Promise<void> {
  const archiveTable = `${liveTable}_archive`;
  await query(
    `CREATE TABLE IF NOT EXISTS ${archiveTable} (LIKE ${liveTable} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`,
  );
}

function getRetentionDays(spec: ArchiveTableSpec): number {
  if (spec.tableName === "indexed_events") {
    return config.eventsRetentionDays;
  }
  // #919: honour TVL_SNAPSHOT_RETENTION_DAYS env override
  if (spec.tableName === "vault_tvl_snapshots") {
    return config.tvlSnapshotRetentionDays ?? spec.retentionDays;
  }
  // #920: honour SNAPSHOT_RETENTION_DAYS env override
  if (spec.tableName === "share_balance_snapshots") {
    return config.snapshotRetentionDays ?? spec.retentionDays;
  }
  return spec.retentionDays;
}

function buildCountQuery(spec: ArchiveTableSpec, retentionDays: number): string {
  const excludedVaultsJoin = `
    LEFT JOIN vaults v ON v.${spec.vaultJoinColumn} = t.${spec.vaultJoinColumn}
  `;
  const excludedVaultsWhere = `AND (v.exclude_from_archive IS NULL OR v.exclude_from_archive = FALSE)`;

  if (spec.vaultJoinColumn === "contract_id") {
    return `
      SELECT COUNT(*)::text AS count
      FROM ${spec.tableName} t
      ${excludedVaultsJoin}
      WHERE t.${spec.timestampColumn} < NOW() - (${retentionDays}::int * INTERVAL '1 day')
        ${excludedVaultsWhere}
    `;
  }

  return `
    SELECT COUNT(*)::text AS count
    FROM ${spec.tableName} t
    ${excludedVaultsJoin}
    WHERE t.${spec.timestampColumn} < NOW() - (${retentionDays}::int * INTERVAL '1 day')
      ${excludedVaultsWhere}
  `;
}

function buildInsertQuery(spec: ArchiveTableSpec, retentionDays: number): string {
  const archiveTable = `${spec.tableName}_archive`;
  const excludedVaultsJoin = `
    LEFT JOIN vaults v ON v.${spec.vaultJoinColumn} = t.${spec.vaultJoinColumn}
  `;
  const excludedVaultsWhere = `AND (v.exclude_from_archive IS NULL OR v.exclude_from_archive = FALSE)`;

  return `
    INSERT INTO ${archiveTable}
    SELECT t.*
    FROM ${spec.tableName} t
    ${excludedVaultsJoin}
    WHERE t.${spec.timestampColumn} < NOW() - (${retentionDays}::int * INTERVAL '1 day')
      ${excludedVaultsWhere}
    ON CONFLICT DO NOTHING
  `;
}

function buildDeleteQuerySimple(spec: ArchiveTableSpec, retentionDays: number): string {
  if (spec.vaultJoinColumn === "contract_id") {
    return `
      DELETE FROM ${spec.tableName} t
      WHERE t.${spec.timestampColumn} < NOW() - (${retentionDays}::int * INTERVAL '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM vaults v
          WHERE v.${spec.vaultJoinColumn} = t.${spec.vaultJoinColumn}
            AND v.exclude_from_archive = TRUE
        )
    `;
  }

  return `
    DELETE FROM ${spec.tableName} t
    WHERE t.${spec.timestampColumn} < NOW() - (${retentionDays}::int * INTERVAL '1 day')
      AND NOT EXISTS (
        SELECT 1 FROM vaults v
        WHERE v.${spec.vaultJoinColumn} = t.${spec.vaultJoinColumn}
          AND v.exclude_from_archive = TRUE
      )
  `;
}

export interface ArchiveResult {
  table: string;
  preArchivalCount: number;
  archivedCount: number;
  dryRun: boolean;
}

export async function runArchival(): Promise<ArchiveResult[]> {
  const dryRun = config.dryRun;
  const results: ArchiveResult[] = [];

  if (dryRun) {
    logger.info("Archival job running in DRY-RUN mode");
  }

  for (const spec of ARCHIVE_TABLES) {
    const retentionDays = getRetentionDays(spec);

    const countRows = await query<{ count: string }>(
      buildCountQuery(spec, retentionDays),
    );
    const preArchivalCount = parseInt(countRows[0]?.count ?? "0", 10);

    if (preArchivalCount === 0) {
      logger.info({ table: spec.tableName }, "No rows to archive");
      results.push({
        table: spec.tableName,
        preArchivalCount: 0,
        archivedCount: 0,
        dryRun,
      });
      continue;
    }

    if (dryRun) {
      logger.info(
        { table: spec.tableName, rowsToArchive: preArchivalCount, retentionDays },
        `Would archive ${preArchivalCount} rows from ${spec.tableName}`,
      );
      await query(
        `INSERT INTO archive_audit_log (table_name, pre_archival_count, archived_count, dry_run)
         VALUES ($1, $2, 0, TRUE)`,
        [spec.tableName, preArchivalCount],
      );
      results.push({
        table: spec.tableName,
        preArchivalCount,
        archivedCount: 0,
        dryRun: true,
      });
      continue;
    }

    await ensureArchiveTable(spec.tableName);

    const insertResult = await query<{ count: string }>(
      `${buildInsertQuery(spec, retentionDays)} RETURNING 1`,
    );
    const archivedCount = insertResult.length;

    await query(
      buildDeleteQuerySimple(spec, retentionDays),
    );

    await query(
      `INSERT INTO archive_audit_log (table_name, pre_archival_count, archived_count, dry_run)
       VALUES ($1, $2, $3, FALSE)`,
      [spec.tableName, preArchivalCount, archivedCount],
    );

    logger.info(
      { table: spec.tableName, archivedCount, retentionDays },
      `Archived ${archivedCount} rows from ${spec.tableName}`,
    );

    results.push({
      table: spec.tableName,
      preArchivalCount,
      archivedCount,
      dryRun: false,
    });
  }

  if (dryRun) {
    logger.info("Archival dry-run complete");
  } else {
    logger.info("Archival job complete");
  }

  return results;
}

// =============================================================
// #921 — Archive restore: move rows from archive back to live
// =============================================================

export interface RestoreParams {
  contractId: string;
  fromDate: string;
  toDate: string;
  table: "indexed_events" | "vault_tvl_snapshots";
}

export interface RestoreResult {
  table: string;
  restoredCount: number;
}

export async function restoreFromArchive(
  params: RestoreParams,
  adminUserId: string,
): Promise<RestoreResult> {
  const { contractId, fromDate, toDate, table } = params;
  const archiveTable = `${table}_archive`;
  const spec = ARCHIVE_TABLES.find((s) => s.tableName === table);
  if (!spec) {
    throw new Error(`Unknown archive table: ${table}`);
  }

  // Move matching rows back to the live table, skipping duplicates.
  const result = await query<{ id: string }>(
    `
    INSERT INTO ${table}
    SELECT a.*
    FROM ${archiveTable} a
    WHERE a.${spec.vaultJoinColumn} = $1
      AND a.${spec.timestampColumn} >= $2::timestamptz
      AND a.${spec.timestampColumn} <= $3::timestamptz
    ON CONFLICT (${spec.idColumn}) DO NOTHING
    RETURNING ${spec.idColumn}
    `,
    [contractId, fromDate, toDate],
  );

  const restoredCount = result.length;

  // Delete restored rows from the archive table.
  if (restoredCount > 0) {
    const restoredIds = result.map((r) => r.id);
    await query(
      `DELETE FROM ${archiveTable} WHERE ${spec.idColumn} = ANY($1::uuid[])`,
      [restoredIds],
    );
  }

  // Audit log entry.
  await query(
    `INSERT INTO admin_audit_log (action, actor, metadata)
     VALUES ('archive_restore', $1, $2::jsonb)`,
    [adminUserId, JSON.stringify({ table, contractId, fromDate, toDate, restoredCount })],
  );

  logger.info(
    { table, contractId, fromDate, toDate, restoredCount, adminUserId },
    "Archive restore complete",
  );

  return { table, restoredCount };
}

// =============================================================
// #922 — Archive status: row counts for live vs archive tables
// =============================================================

export interface ArchiveTableStatus {
  name: string;
  liveRows: number;
  archiveRows: number;
  oldestArchiveDate: string | null;
  latestArchiveDate: string | null;
}

export interface ArchiveStatus {
  tables: ArchiveTableStatus[];
}

export async function getArchiveStatus(): Promise<ArchiveStatus> {
  const tables: ArchiveTableStatus[] = [];

  for (const spec of ARCHIVE_TABLES) {
    const archiveTable = `${spec.tableName}_archive`;

    const [liveResult, archiveResult] = await Promise.all([
      query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${spec.tableName}`,
      ),
      query<{
        count: string;
        oldest: string | null;
        latest: string | null;
      }>(
        `SELECT
           COUNT(*)::text AS count,
           MIN(${spec.timestampColumn})::text AS oldest,
           MAX(${spec.timestampColumn})::text AS latest
         FROM ${archiveTable}`,
      ).catch(() => [{ count: "0", oldest: null, latest: null }]),
    ]);

    tables.push({
      name: spec.tableName,
      liveRows: parseInt(liveResult[0]?.count ?? "0", 10),
      archiveRows: parseInt(archiveResult[0]?.count ?? "0", 10),
      oldestArchiveDate: archiveResult[0]?.oldest ?? null,
      latestArchiveDate: archiveResult[0]?.latest ?? null,
    });
  }

  return { tables };
}
