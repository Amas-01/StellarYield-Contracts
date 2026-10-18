import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { query } from "../../db/index.js";
import { AppError, ErrorCode } from "../middleware/errors.js";

/**
 * Fee endpoints: platform fee summary (#1101), fee accrual estimate (#1102),
 * fee revenue chart (#1104), fee rebates (#1103) and fee tiers (#1099).
 *
 * Amounts are NUMERIC in Postgres and returned as decimal strings. The backend
 * has no price feed, so every "Usd" figure is the raw asset amount and equals
 * USD only for USD-pegged assets.
 */

export const contractIdSchema = z.string().length(56).regex(/^C[A-Z2-7]{55}$/);
const stellarAccountSchema = z.string().length(56).regex(/^G[A-Z2-7]{55}$/);
const amountSchema = z.string().regex(/^\d+(\.\d{1,7})?$/, "must be a non-negative decimal amount");
const positiveAmountSchema = amountSchema.refine((v) => Number(v) > 0, "must be greater than zero");

export const periodQuerySchema = z.object({
  period: z
    .string()
    .regex(/^\d{1,4}d$/, "period must look like 30d")
    .default("30d")
    .transform((v) => Number(v.slice(0, -1)))
    .refine((days) => days >= 1 && days <= 3650, "period must be between 1d and 3650d"),
});

export const estimateQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(30),
});

export const rebateBodySchema = z.object({
  address: stellarAccountSchema,
  rebateAmount: positiveAmountSchema,
  reason: z.string().trim().min(1, "reason is required").max(500),
  txHash: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/, "txHash must be a 64-character hex string")
    .optional(),
});

export const rebatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const tierBodySchema = z
  .object({
    minBalance: amountSchema,
    maxBalance: amountSchema.nullish(),
    feeBps: z.number().int().min(0).max(10000),
  })
  .refine((t) => t.maxBalance == null || Number(t.maxBalance) > Number(t.minBalance), {
    message: "maxBalance must be greater than minBalance",
    path: ["maxBalance"],
  });

export const tierParamsSchema = z.object({
  contractId: contractIdSchema,
  tierId: z.coerce.number().int().positive(),
});

function badRequest(message: string): AppError {
  return new AppError(ErrorCode.VALIDATION_ERROR, message, 400);
}

async function requireVault(contractId: string): Promise<void> {
  const rows = await query<{ id: number }>("SELECT id FROM vaults WHERE contract_id = $1", [
    contractId,
  ]);
  if (rows.length === 0) {
    throw new AppError(ErrorCode.VAULT_NOT_FOUND, `Vault ${contractId} not found`, 404);
  }
}

function parseContractId(req: Request): string {
  const parsed = contractIdSchema.safeParse(req.params["contractId"]);
  if (!parsed.success) throw badRequest("Invalid contractId format");
  return parsed.data;
}

// --- #1101 platform fee summary ---------------------------------------------

interface VaultFeeRow {
  contract_id: string;
  fees: string;
  total: string;
}

/**
 * GET /api/v1/platform/fees?period=30d
 *
 * Fees collected across all vaults in the period: operator fees taken on yield
 * distributions (`indexed_events`, the same source as the admin fee dashboard)
 * plus early-redemption fees (`redemption_requests.fee_revenue`). Vaults with no
 * fees in the period are omitted, and `totalFeesUsd` is computed over exactly
 * the rows returned.
 */
export async function getPlatformFees(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = periodQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid period");
    const days = parsed.data.period;

    const rows = await query<VaultFeeRow>(
      `WITH period_fees AS (
         SELECT ie.contract_id,
                COALESCE(SUM((ie.parsed_data->>'operatorFee')::numeric), 0) AS fees
         FROM indexed_events ie
         WHERE ie.event_type = 'yield_distributed'
           AND ie.parsed_data IS NOT NULL
           AND ie.created_at >= NOW() - make_interval(days => $1::int)
         GROUP BY ie.contract_id
         UNION ALL
         SELECT v.contract_id, COALESCE(SUM(rr.fee_revenue), 0) AS fees
         FROM redemption_requests rr
         JOIN vaults v ON v.id = rr.vault_id
         WHERE rr.processed = TRUE
           AND rr.fee_revenue > 0
           AND rr.request_time >= NOW() - make_interval(days => $1::int)
         GROUP BY v.contract_id
       )
       SELECT contract_id,
              SUM(fees)::text AS fees,
              SUM(SUM(fees)) OVER ()::text AS total
       FROM period_fees
       GROUP BY contract_id
       HAVING SUM(fees) > 0
       ORDER BY SUM(fees) DESC, contract_id`,
      [days],
    );

    res.json({
      period: `${days}d`,
      totalFeesUsd: rows[0]?.total ?? "0",
      byVault: rows.map((r) => ({ contractId: r.contract_id, feesUsd: r.fees })),
    });
  } catch (err) {
    next(err);
  }
}

// --- #1102 fee accrual estimate ----------------------------------------------

interface EstimateRow {
  tvl: string | null;
  fee_bps: number | null;
  estimate: string | null;
}

/**
 * GET /api/v1/vaults/:contractId/fee-accrual-estimate?days=30
 *
 * estimatedFeeUsd = tvl x (feeBps / 10000) x (days / 365), from the vault's
 * latest TVL snapshot and its current operator fee (`vaults.operator_fee_bps`,
 * kept current by the indexer's operator_fee_updated handling). 404 when the
 * vault has no TVL snapshot.
 */
export async function getFeeAccrualEstimate(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = parseContractId(req);
    const parsed = estimateQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid days");
    const days = parsed.data.days;

    const rows = await query<EstimateRow>(
      `SELECT s.total_assets::text AS tvl,
              v.operator_fee_bps AS fee_bps,
              ROUND(s.total_assets * COALESCE(v.operator_fee_bps, 0) * $2::numeric / (10000 * 365), 7)::text AS estimate
       FROM vaults v
       LEFT JOIN LATERAL (
         SELECT total_assets
         FROM vault_tvl_snapshots
         WHERE vault_id = v.id
         ORDER BY recorded_at DESC, id DESC
         LIMIT 1
       ) s ON TRUE
       WHERE v.contract_id = $1`,
      [contractId, days],
    );

    if (rows.length === 0) {
      throw new AppError(ErrorCode.VAULT_NOT_FOUND, `Vault ${contractId} not found`, 404);
    }
    const row = rows[0];
    if (row.tvl === null || row.estimate === null) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        `No TVL snapshot exists for vault ${contractId}`,
        404,
      );
    }

    res.json({
      estimatedFeeUsd: row.estimate,
      basedOnTvlUsd: row.tvl,
      feeBps: row.fee_bps ?? 0,
      projectionDays: days,
    });
  } catch (err) {
    next(err);
  }
}

// --- #1104 fee revenue chart ---------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REVENUE_DAYS = 30;
const MAX_REVENUE_DAYS = 366;

const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/, "must be an ISO date");

export const feeRevenueQuerySchema = z.object({
  from: dateParam.optional(),
  to: dateParam.optional(),
  interval: z.enum(["1d", "7d"]).default("1d"),
});

const INTERVALS = {
  "1d": { trunc: "day", step: "1 day" },
  "7d": { trunc: "week", step: "7 days" },
} as const;

/** Truncates a parsed date to its UTC calendar day, as YYYY-MM-DD. */
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * GET /api/v1/vaults/:contractId/fee-revenue?from=<date>&to=<date>&interval=1d|7d
 *
 * Fee revenue time series from the `transfer_fees` view. `1d` returns one point
 * per UTC calendar day from `from` to `to` inclusive; `7d` returns one point
 * per ISO week (dated by its Monday) overlapping the range, counting only fees
 * inside the range. Buckets with no fees return feesUsd "0". Defaults to the
 * last 30 days; the range is capped at 366 days.
 */
export async function getFeeRevenue(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = parseContractId(req);
    const parsed = feeRevenueQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid query");

    const toDate = parsed.data.to ? new Date(parsed.data.to) : new Date();
    const fromDate = parsed.data.from
      ? new Date(parsed.data.from)
      : new Date(toDate.getTime() - (DEFAULT_REVENUE_DAYS - 1) * DAY_MS);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw badRequest("Invalid date");
    }

    const from = utcDay(fromDate);
    const to = utcDay(toDate);
    if (from > to) throw badRequest("from must not be after to");
    const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
    if (days > MAX_REVENUE_DAYS) {
      throw badRequest(`Range too large: at most ${MAX_REVENUE_DAYS} days per request`);
    }

    await requireVault(contractId);

    const { trunc, step } = INTERVALS[parsed.data.interval];
    const rows = await query<{ date: string; fees: string }>(
      `SELECT to_char(b.bucket, 'YYYY-MM-DD') AS date,
              COALESCE(SUM(tf.fee_amount), 0)::text AS fees
       FROM generate_series(date_trunc($3, $1::date::timestamp), $2::date::timestamp, $4::interval) AS b(bucket)
       LEFT JOIN transfer_fees tf
         ON tf.contract_id = $5
        AND tf.collected_at >= (b.bucket AT TIME ZONE 'UTC')
        AND tf.collected_at < ((b.bucket + $4::interval) AT TIME ZONE 'UTC')
        AND tf.collected_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
        AND tf.collected_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')
       GROUP BY b.bucket
       ORDER BY b.bucket`,
      [from, to, trunc, step, contractId],
    );

    res.json(rows.map((r) => ({ date: r.date, feesUsd: r.fees })));
  } catch (err) {
    next(err);
  }
}

// --- #1103 fee rebates ---------------------------------------------------------

interface RebateRow {
  id: number;
  contract_id: string;
  address: string;
  rebate_amount: string;
  reason: string;
  tx_hash: string | null;
  created_at: Date | string;
}

const toRebate = (r: RebateRow) => ({
  id: r.id,
  contractId: r.contract_id,
  address: r.address,
  rebateAmount: r.rebate_amount,
  reason: r.reason,
  txHash: r.tx_hash,
  createdAt: r.created_at,
});

/** GET /api/v1/vaults/:contractId/fee-rebates: newest first. */
export async function listFeeRebates(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = parseContractId(req);
    const parsed = rebatesQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid query");
    await requireVault(contractId);

    const rows = await query<RebateRow>(
      `SELECT id, contract_id, address, rebate_amount::text AS rebate_amount, reason, tx_hash, created_at
       FROM fee_rebates
       WHERE contract_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [contractId, parsed.data.limit, parsed.data.offset],
    );

    res.json({ contractId, rebates: rows.map(toRebate) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/v1/admin/vaults/:contractId/fee-rebates: manual rebate record. */
export async function createFeeRebate(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = parseContractId(req);
    const parsed = rebateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
      return;
    }
    await requireVault(contractId);
    const body = parsed.data;

    const rows = await query<RebateRow>(
      `INSERT INTO fee_rebates (contract_id, address, rebate_amount, reason, tx_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, contract_id, address, rebate_amount::text AS rebate_amount, reason, tx_hash, created_at`,
      [contractId, body.address, body.rebateAmount, body.reason, body.txHash ?? null],
    );

    res.status(201).json(toRebate(rows[0]));
  } catch (err) {
    next(err);
  }
}

// --- #1099 fee tiers -----------------------------------------------------------

interface TierRow {
  id: number;
  contract_id: string;
  min_balance: string;
  max_balance: string | null;
  fee_bps: number;
  created_at: Date | string;
}

const toTier = (r: TierRow) => ({
  id: r.id,
  contractId: r.contract_id,
  minBalance: r.min_balance,
  maxBalance: r.max_balance,
  feeBps: r.fee_bps,
  createdAt: r.created_at,
});

const TIER_COLUMNS =
  "id, contract_id, min_balance::text AS min_balance, max_balance::text AS max_balance, fee_bps, created_at";

/** GET /api/v1/vaults/:contractId/fee-tiers: lowest minimum balance first. */
export async function listFeeTiers(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = parseContractId(req);
    await requireVault(contractId);

    const rows = await query<TierRow>(
      `SELECT ${TIER_COLUMNS} FROM fee_tiers WHERE contract_id = $1 ORDER BY min_balance ASC, id ASC`,
      [contractId],
    );

    res.json({ contractId, tiers: rows.map(toTier) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/admin/vaults/:contractId/fee-tiers
 *
 * Tiers are half-open ranges [minBalance, maxBalance). The overlap check and the
 * insert are one statement, so an overlapping tier is never written; it is
 * rejected with 422.
 */
export async function createFeeTier(req: Request, res: Response, next: NextFunction) {
  try {
    const contractId = parseContractId(req);
    const parsed = tierBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "ValidationError", issues: parsed.error.issues });
      return;
    }
    await requireVault(contractId);
    const { minBalance, maxBalance, feeBps } = parsed.data;

    const rows = await query<TierRow>(
      `INSERT INTO fee_tiers (contract_id, min_balance, max_balance, fee_bps)
       SELECT $1::text, $2::numeric, $3::numeric, $4::int
       WHERE NOT EXISTS (
         SELECT 1 FROM fee_tiers t
         WHERE t.contract_id = $1
           AND $2::numeric < COALESCE(t.max_balance, 'Infinity'::numeric)
           AND COALESCE($3::numeric, 'Infinity'::numeric) > t.min_balance
       )
       RETURNING ${TIER_COLUMNS}`,
      [contractId, minBalance, maxBalance ?? null, feeBps],
    );

    if (rows.length === 0) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Fee tier overlaps an existing tier for this vault",
        422,
      );
    }

    res.status(201).json(toTier(rows[0]));
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/v1/admin/vaults/:contractId/fee-tiers/:tierId */
export async function deleteFeeTier(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = tierParamsSchema.safeParse(req.params);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid parameters");
    const { contractId, tierId } = parsed.data;

    const rows = await query<{ id: number }>(
      "DELETE FROM fee_tiers WHERE id = $1 AND contract_id = $2 RETURNING id",
      [tierId, contractId],
    );
    if (rows.length === 0) {
      throw new AppError(ErrorCode.NOT_FOUND, `Fee tier ${tierId} not found`, 404);
    }

    res.json({ deleted: true, id: tierId });
  } catch (err) {
    next(err);
  }
}
