import { query } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export interface VelocityCheckResult {
  checkedVaults: number;
  alertsCreated: Array<{
    vaultId: number;
    contractId: string | null;
    transferCount: number;
    threshold: number;
    alertId?: number;
  }>;
}

/**
 * Computes transfer count in the last hour per vault.
 * If count exceeds TRANSFER_VELOCITY_THRESHOLD (default: 500),
 * inserts a row in transfer_alerts with type = "VELOCITY_SPIKE".
 */
export async function checkTransferVelocity(customThreshold?: number): Promise<VelocityCheckResult> {
  const threshold = customThreshold ?? config.transferVelocityThreshold;

  logger.info({ threshold }, "Running transfer velocity anomaly check");

  const rows = await query<{ vault_id: number; contract_id: string | null; count: string }>(
    `SELECT t.vault_id, v.contract_id, COUNT(*)::text AS count
     FROM transfers t
     LEFT JOIN vaults v ON v.id = t.vault_id
     WHERE t.created_at >= NOW() - INTERVAL '1 hour'
     GROUP BY t.vault_id, v.contract_id
     HAVING COUNT(*) > $1`,
    [threshold],
  );

  const alertsCreated: VelocityCheckResult["alertsCreated"] = [];

  for (const row of rows) {
    const transferCount = parseInt(row.count, 10);
    const details = {
      transferCount,
      threshold,
      timeWindow: "1 hour",
    };

    const insertResult = await query<{ id: number }>(
      `INSERT INTO transfer_alerts (vault_id, contract_id, type, details, created_at)
       VALUES ($1, $2, 'VELOCITY_SPIKE', $3, NOW())
       RETURNING id`,
      [row.vault_id, row.contract_id, JSON.stringify(details)],
    );

    const alertId = insertResult[0]?.id;

    logger.warn(
      {
        vaultId: row.vault_id,
        contractId: row.contract_id,
        transferCount,
        threshold,
        alertId,
      },
      "Transfer velocity anomaly detected: spike in transfer count in the last hour",
    );

    alertsCreated.push({
      vaultId: row.vault_id,
      contractId: row.contract_id,
      transferCount,
      threshold,
      alertId,
    });
  }

  logger.info(
    { spikesDetected: alertsCreated.length },
    "Completed transfer velocity anomaly check",
  );

  return {
    checkedVaults: rows.length,
    alertsCreated,
  };
}
