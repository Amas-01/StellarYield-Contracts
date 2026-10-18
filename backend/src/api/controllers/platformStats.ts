import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { query } from "../../db/index.js";
import { AppError, ErrorCode } from "../middleware/errors.js";

/**
 * Platform metrics (#1084 TVL, #1085 TVL history, #1086 unique users) and the
 * per-user vault entry/exit summary (#1083).
 *
 * Amounts are NUMERIC in Postgres and returned as decimal strings. The backend
 * has no price feed, so the "Usd" figures are raw asset amounts and equal USD
 * only for USD-pegged assets (same convention as the other TVL endpoints).
 */

const stellarAddressSchema = z.string().length(56).regex(/^G[A-Z2-7]{55}$/);

const MAX_HISTORY_DAYS = 366;
const DEFAULT_HISTORY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function badRequest(message: string): AppError {
  return new AppError(ErrorCode.VALIDATION_ERROR, message, 400);
}

// --- #1084 platform TVL ------------------------------------------------------

/**
 * GET /api/v1/platform/tvl
 *
 * Sums the most recent `vault_tvl_snapshots.total_assets` of every vault that
 * has a snapshot. `lastUpdatedAt` is the newest snapshot timestamp.
 */
export async function getPlatformTvl(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await query<{ total: string; vault_count: string; last_updated_at: Date | null }>(
      `WITH latest AS (
         SELECT DISTINCT ON (vault_id) vault_id, total_assets, recorded_at
         FROM vault_tvl_snapshots
         ORDER BY vault_id, recorded_at DESC, id DESC
       )
       SELECT COALESCE(SUM(total_assets), 0)::text AS total,
              COUNT(*)::text AS vault_count,
              MAX(recorded_at) AS last_updated_at
       FROM latest`,
    );

    const row = rows[0];
    res.json({
      totalTvlUsd: row?.total ?? "0",
      vaultCount: Number(row?.vault_count ?? 0),
      lastUpdatedAt: row?.last_updated_at ?? null,
    });
  } catch (err) {
    next(err);
  }
}

// --- #1085 platform TVL history -------------------------------------------------

const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/, "must be an ISO date");

export const tvlHistoryQuerySchema = z.object({
  from: dateParam.optional(),
  to: dateParam.optional(),
  interval: z.enum(["1d"]).default("1d"),
});

/** Truncates a parsed date to its UTC calendar day, as YYYY-MM-DD. */
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * GET /api/v1/platform/tvl/history?from=<date>&to=<date>&interval=1d
 *
 * One point per UTC calendar day from `from` to `to` (inclusive). Each point is
 * the sum, over all vaults, of the vault's latest snapshot at or before the end
 * of that day, so a vault that took no snapshot on a given day still counts
 * with its most recent value instead of dropping out of the total. Defaults to
 * the last 30 days; the range is capped at 366 days.
 */
export async function getPlatformTvlHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = tvlHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "Invalid query");

    const toDate = parsed.data.to ? new Date(parsed.data.to) : new Date();
    const fromDate = parsed.data.from
      ? new Date(parsed.data.from)
      : new Date(toDate.getTime() - (DEFAULT_HISTORY_DAYS - 1) * DAY_MS);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw badRequest("Invalid date");
    }

    const from = utcDay(fromDate);
    const to = utcDay(toDate);
    if (from > to) throw badRequest("from must not be after to");
    const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
    if (days > MAX_HISTORY_DAYS) {
      throw badRequest(`Range too large: at most ${MAX_HISTORY_DAYS} days per request`);
    }

    const rows = await query<{ date: string; total_tvl: string }>(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
              COALESCE(SUM(s.total_assets), 0)::text AS total_tvl
       FROM generate_series($1::date, $2::date, interval '1 day') AS d(day)
       LEFT JOIN LATERAL (
         SELECT DISTINCT ON (vault_id) vault_id, total_assets
         FROM vault_tvl_snapshots
         WHERE recorded_at < ((d.day::date + 1)::timestamp AT TIME ZONE 'UTC')
         ORDER BY vault_id, recorded_at DESC, id DESC
       ) s ON TRUE
       GROUP BY d.day
       ORDER BY d.day`,
      [from, to],
    );

    res.json(rows.map((r) => ({ date: r.date, totalTvlUsd: r.total_tvl })));
  } catch (err) {
    next(err);
  }
}

// --- #1086 platform unique users -------------------------------------------------

/**
 * GET /api/v1/platform/users/count
 *
 * Distinct addresses with any position (i.e. any deposit or withdraw) history:
 *  - total:           every such address
 *  - activeThisMonth: last deposit/withdraw within the rolling 30 days
 *  - newThisMonth:    first-ever deposit (earliest entry across all vaults)
 *                     within the rolling 30 days
 */
export async function getPlatformUsersCount(_req: Request, res: Response, next: NextFunction) {
  try {
    const rows = await query<{ total: string; active: string; new_users: string }>(
      `WITH per_user AS (
         SELECT user_address,
                MIN(first_entry_at) AS first_entry,
                MAX(updated_at) AS last_activity
         FROM user_vault_positions
         GROUP BY user_address
       )
       SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE last_activity >= NOW() - INTERVAL '30 days')::text AS active,
              COUNT(*) FILTER (WHERE first_entry >= NOW() - INTERVAL '30 days')::text AS new_users
       FROM per_user`,
    );

    const row = rows[0];
    res.json({
      total: Number(row?.total ?? 0),
      activeThisMonth: Number(row?.active ?? 0),
      newThisMonth: Number(row?.new_users ?? 0),
    });
  } catch (err) {
    next(err);
  }
}

// --- #1083 user vault entry/exit summary ---------------------------------------

interface VaultActivityRow {
  contract_id: string;
  first_entry_at: Date | string | null;
  last_exit_at: Date | string | null;
  shares: string;
}

/**
 * GET /api/v1/users/:address/vault-activity
 *
 * One entry per vault the user has any deposit/withdraw history with.
 * `currentBalance` is the user's share balance (0 once fully exited) and
 * `lastExitAt` is null while a balance is still held.
 */
export async function getUserVaultActivity(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = stellarAddressSchema.safeParse(req.params["address"]);
    if (!parsed.success) throw badRequest("Invalid Stellar address");

    const rows = await query<VaultActivityRow>(
      `SELECT v.contract_id,
              uvp.first_entry_at,
              uvp.last_exit_at,
              uvp.shares::text AS shares
       FROM user_vault_positions uvp
       JOIN vaults v ON v.id = uvp.vault_id
       WHERE uvp.user_address = $1
       ORDER BY uvp.first_entry_at ASC NULLS LAST, v.contract_id ASC`,
      [parsed.data],
    );

    res.json(
      rows.map((r) => {
        const holding = Number(r.shares) > 0;
        return {
          contractId: r.contract_id,
          firstEntryAt: r.first_entry_at,
          lastExitAt: holding ? null : r.last_exit_at,
          currentBalance: r.shares,
        };
      }),
    );
  } catch (err) {
    next(err);
  }
}

// --- #1087 platform deposit/withdrawal volume -------------------------------------

/**
 * GET /api/v1/platform/flows?period=1d|7d|30d
 *
 * Platform-wide capital flows:
 *  - depositVolume: sum of deposits across all vaults within the period
 *  - withdrawalVolume: sum of withdrawals across all vaults within the period
 *  - netFlow: depositVolume - withdrawalVolume
 */
export async function getPlatformFlows(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const period = String(req.query["period"] ?? "30d").toLowerCase();
    const daysMap: Record<string, number> = {
      "1d": 1,
      "7d": 7,
      "30d": 30,
    };

    if (!daysMap[period]) {
      res.status(400).json({
        error: "BadRequest",
        message: "Invalid period. Must be 1d, 7d, or 30d",
      });
      return;
    }

    const days = daysMap[period];
    const rows = await query<{
      deposit_volume: string | null;
      withdrawal_volume: string | null;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN event_type = 'deposit' THEN COALESCE((parsed_data->>'assets')::numeric, (payload->>'assets')::numeric, 0) ELSE 0 END), 0)::text AS deposit_volume,
         COALESCE(SUM(CASE WHEN event_type = 'withdraw' THEN COALESCE((parsed_data->>'assets')::numeric, (payload->>'assets')::numeric, 0) ELSE 0 END), 0)::text AS withdrawal_volume
       FROM indexed_events
       WHERE event_type IN ('deposit', 'withdraw')
         AND created_at >= NOW() - make_interval(days => $1::int)`,
      [days],
    );

    const depositVolume = Number(rows[0]?.deposit_volume ?? 0);
    const withdrawalVolume = Number(rows[0]?.withdrawal_volume ?? 0);
    const netFlow = depositVolume - withdrawalVolume;

    res.json({
      period,
      depositVolume,
      withdrawalVolume,
      netFlow,
    });
  } catch (err) {
    next(err);
  }
}

