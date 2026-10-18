import { query } from "../db/index.js";
import { logger } from "../logger.js";

/**
 * Number of prior epochs the rolling statistics are computed over (#1073).
 */
export const ANOMALY_WINDOW = 30;

/**
 * Standard deviations from the mean at which an epoch is flagged.
 *
 * Three sigma is the conventional cut: for a roughly normal distribution it
 * leaves a false-positive rate of about 0.3% per epoch, low enough that a flag
 * is worth a human look and high enough that a genuinely broken indexer run is
 * not missed.
 */
export const ANOMALY_SIGMA_THRESHOLD = 3;

/**
 * Minimum number of prior epochs required before a flag is raised (#1073).
 *
 * A standard deviation estimated from a handful of points is dominated by noise
 * — three points can make any fourth look like an outlier. Seven prior epochs
 * is the smallest window in which a 3-sigma band is meaningfully estimated
 * while still leaving 23 of the 30 epochs available as context. Epochs below
 * the threshold are skipped entirely rather than scored on a thin sample.
 */
export const ANOMALY_MIN_SAMPLE_SIZE = 7;

/** A single flagged epoch, as stored in `epoch_anomalies`. */
export interface EpochAnomaly {
  vaultId: string;
  epochId: number;
  yieldAmount: string;
  meanYield: string;
  stddevYield: string;
  sampleSize: number;
  /** Signed deviations from the mean, or null when stddev was zero. */
  zScore: string | null;
  detectedAt: string;
}

interface AnomalyRow {
  contract_id: string;
  epoch: number;
  yield_amount: string;
  mean_yield: string;
  stddev_yield: string;
  sample_size: number;
  z_score: string | null;
  detected_at: Date;
}

function toAnomaly(row: AnomalyRow): EpochAnomaly {
  return {
    vaultId: row.contract_id,
    epochId: row.epoch,
    yieldAmount: row.yield_amount,
    meanYield: row.mean_yield,
    stddevYield: row.stddev_yield,
    sampleSize: row.sample_size,
    zScore: row.z_score,
    detectedAt: row.detected_at.toISOString(),
  };
}

/**
 * An epoch whose yield is far from its own history (#1073).
 *
 * A yield that is out of line with the vault's recent epochs is either a real
 * change in the underlying asset or a bug in the indexer — the point is to
 * surface it for a human rather than to decide which.
 */
export class EpochAnomalyService {
  /**
   * Score every finalized epoch against the previous {@link ANOMALY_WINDOW}
   * epochs of the same vault and persist the ones that deviate by more than
   * {@link ANOMALY_SIGMA_THRESHOLD} standard deviations.
   *
   * The window function walks each vault's epochs in one pass. Because the frame
   * only reaches backwards, an epoch's score depends solely on epochs that were
   * already closed when it was scored, so a re-run always produces the same
   * verdict — which is what makes the daily job safe to retry and safe to
   * backfill on its first execution.
   *
   * The candidate's own value is excluded from its statistics (`1 PRECEDING`),
   * otherwise a large epoch would inflate the mean and the standard deviation
   * enough to hide itself.
   *
   * `stddev_yield = 0` is handled explicitly rather than divided by: a perfectly
   * flat window has no scale, so any deviation at all is treated as a flag
   * (three sigma is zero there) and the z-score is left null instead of being
   * invented.
   *
   * @returns The anomalies recorded by this run, for logging and tests.
   */
  async scanAndRecord(): Promise<EpochAnomaly[]> {
    const rows = await query<AnomalyRow>(
      `WITH scored AS (
         SELECT
           e.vault_id,
           e.epoch,
           e.yield_amount,
           AVG(e.yield_amount) OVER w AS mean_yield,
           COALESCE(STDDEV_POP(e.yield_amount) OVER w, 0) AS stddev_yield,
           COUNT(*) OVER w AS sample_size
         FROM epochs e
         WHERE e.closed_at IS NOT NULL
         WINDOW w AS (
           PARTITION BY e.vault_id
           ORDER BY e.epoch
           RANGE BETWEEN ${ANOMALY_WINDOW} PRECEDING AND 1 PRECEDING
         )
       ),
       flagged AS (
         SELECT s.*, v.contract_id
         FROM scored s
         JOIN vaults v ON v.id = s.vault_id
         WHERE s.sample_size >= $1
           AND (
             -- Flat window: no scale to divide by, so any deviation is a flag.
             (s.stddev_yield = 0 AND s.yield_amount <> s.mean_yield)
             OR
             (s.stddev_yield > 0 AND ABS(s.yield_amount - s.mean_yield) / s.stddev_yield > $2)
           )
       ),
       inserted AS (
         INSERT INTO epoch_anomalies
           (vault_id, epoch, yield_amount, mean_yield, stddev_yield, sample_size, z_score)
         SELECT vault_id, epoch, yield_amount, mean_yield, stddev_yield, sample_size,
                CASE WHEN stddev_yield = 0 THEN NULL
                     ELSE (yield_amount - mean_yield) / stddev_yield END
         FROM flagged
         -- A vault/epoch pair is unique and the verdict is deterministic, so a
         -- re-run must not duplicate a row that is already there.
         ON CONFLICT (vault_id, epoch) DO NOTHING
         RETURNING vault_id, epoch, yield_amount, mean_yield, stddev_yield,
                   sample_size, z_score, detected_at
       )
       -- Pair each inserted row back to its vault for the contract id, in the
       -- same round trip. ON CONFLICT DO NOTHING drops re-runs here, so the
       -- join only ever returns rows this run actually recorded.
       SELECT i.epoch, i.yield_amount, i.mean_yield, i.stddev_yield, i.sample_size,
              i.z_score, i.detected_at, f.contract_id
       FROM inserted i
       JOIN flagged f ON f.vault_id = i.vault_id AND f.epoch = i.epoch`,
      [ANOMALY_MIN_SAMPLE_SIZE, ANOMALY_SIGMA_THRESHOLD],
    );

    const anomalies = rows.map(toAnomaly);

    if (anomalies.length > 0) {
      for (const anomaly of anomalies) {
        logger.warn(
          {
            contractId: anomaly.vaultId,
            epoch: anomaly.epochId,
            yieldAmount: anomaly.yieldAmount,
            meanYield: anomaly.meanYield,
            stddevYield: anomaly.stddevYield,
            zScore: anomaly.zScore,
            sampleSize: anomaly.sampleSize,
          },
          "Epoch yield deviates from its rolling mean by more than the anomaly threshold",
        );
      }
    } else {
      logger.debug("Epoch anomaly scan found no deviations");
    }

    return anomalies;
  }

  /**
   * All recorded anomalies for a vault, newest epoch first (#1073).
   *
   * Newest-first is what a reviewer wants: the epoch that just tripped the
   * detector is the one being investigated, and the most recent epochs are the
   * only ones that can have been scored by the latest run.
   */
  async listForVault(contractId: string, limit = 100): Promise<EpochAnomaly[]> {
    const rows = await query<AnomalyRow>(
      `SELECT v.contract_id, a.epoch, a.yield_amount, a.mean_yield, a.stddev_yield,
              a.sample_size, a.z_score, a.detected_at
       FROM epoch_anomalies a
       JOIN vaults v ON v.id = a.vault_id
       WHERE v.contract_id = $1
       ORDER BY a.epoch DESC
       LIMIT $2`,
      [contractId, limit],
    );

    return rows.map(toAnomaly);
  }
}
