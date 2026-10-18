import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { query } from "../../db/index.js";
import { AppError, ErrorCode } from "../middleware/errors.js";

/**
 * Regulatory reports (#1112): holder concentration of a single vault.
 *
 * Concentration is measured against the vault's total supply, falling back to
 * the sum of tracked holder shares when the vault has not reported a supply yet
 * (a vault that has never been synced from chain). Alongside the cumulative
 * top-1/5/10 shares the report carries the Herfindahl-Hirschman Index, the
 * concentration measure used by competition and financial regulators: the sum
 * of squared market shares, reported both on the 0..1 scale and on the
 * conventional 0..10,000 index.
 *
 * Amounts are NUMERIC in Postgres and returned as decimal strings, as on the
 * other analytics endpoints.
 */

const contractIdSchema = z
  .string()
  .length(56)
  .regex(/^C[A-Z2-7]{55}$/, "Invalid vault contract ID");

export const holderConcentrationQuerySchema = z.object({
  vaultId: contractIdSchema,
  topN: z.coerce.number().int().min(1).max(100).optional().default(10),
});

const DEFAULT_TOP_N = 10;
/** Cumulative ranks always reported, whatever `topN` was asked for. */
const REPORTED_RANKS = [1, 5, 10] as const;

// HHI bands, expressed on the conventional 0..10,000 index.
const HHI_MODERATE = 1500;
const HHI_HIGH = 2500;

type RiskLevel = "low" | "moderate" | "high";

function riskLevelFor(hhiIndex: number): RiskLevel {
  if (hhiIndex < HHI_MODERATE) return "low";
  if (hhiIndex < HHI_HIGH) return "moderate";
  return "high";
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

interface HolderRow {
  address: string;
  shares: string;
  value_locked: string;
}

/**
 * GET /api/v1/admin/regulatory/holder-concentration?vaultId=<contractId>&topN=<n>
 */
export async function getHolderConcentrationReport(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = holderConcentrationQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues[0]?.message ?? "Invalid query parameters",
        400,
      );
    }
    const { vaultId, topN } = parsed.data;

    const vaultRows = await query<{
      id: number;
      contract_id: string;
      name: string | null;
      state: string;
      total_supply: string;
      total_assets: string;
    }>(
      `SELECT id, contract_id, name, state, total_supply::text AS total_supply, total_assets::text AS total_assets
       FROM vaults
       WHERE contract_id = $1 AND archived = FALSE
       LIMIT 1`,
      [vaultId],
    );

    const vault = vaultRows[0];
    if (!vault) {
      res.status(404).json({ error: "NotFound", message: "Vault not found" });
      return;
    }

    // Always read at least the top 10 rows so the cumulative shares are reported
    // even when the caller asks for fewer.
    const limit = Math.max(topN, DEFAULT_TOP_N);

    const [holderRows, aggregateRows] = await Promise.all([
      query<HolderRow>(
        `SELECT uvp.user_address AS address,
                uvp.shares::text    AS shares,
                uvp.deposited::text AS value_locked
         FROM user_vault_positions uvp
         WHERE uvp.vault_id = $1 AND uvp.shares > 0
         ORDER BY uvp.shares DESC, uvp.user_address ASC
         LIMIT $2`,
        [vault.id, limit],
      ),
      query<{ holder_count: string; holder_shares: string; hhi: string }>(
        `WITH totals AS (
           SELECT COUNT(*) AS holder_count, COALESCE(SUM(shares), 0) AS holder_shares
           FROM user_vault_positions
           WHERE vault_id = $1 AND shares > 0
         )
         SELECT t.holder_count::text AS holder_count,
                t.holder_shares::text AS holder_shares,
                COALESCE((
                  SELECT SUM(POWER(p.shares::numeric / NULLIF(t.holder_shares, 0), 2))
                  FROM user_vault_positions p
                  WHERE p.vault_id = $1 AND p.shares > 0
                ), 0)::text AS hhi
         FROM totals t`,
        [vault.id],
      ),
    ]);

    const aggregate = aggregateRows[0];
    const totalSupply = Number(vault.total_supply);
    const holderShares = Number(aggregate?.holder_shares ?? "0");
    // Prefer the on-chain supply; fall back to tracked shares when the vault
    // has none, so percentages are never divided by zero.
    const denominator = totalSupply > 0 ? totalSupply : holderShares;
    const sharePct = (shares: number): number =>
      denominator > 0 ? round4((shares / denominator) * 100) : 0;
    const cumulativeShares = (rank: number): number =>
      holderRows.slice(0, rank).reduce((sum, row) => sum + Number(row.shares), 0);

    const hhi = Number(aggregate?.hhi ?? "0");
    const hhiIndex = Math.round(hhi * 10_000);

    res.json({
      generatedAt: new Date().toISOString(),
      vault: {
        contractId: vault.contract_id,
        name: vault.name,
        state: vault.state,
        totalSupply: vault.total_supply,
        totalValueLocked: vault.total_assets,
      },
      holders: {
        holderCount: parseInt(aggregate?.holder_count ?? "0", 10),
        trackedShares: aggregate?.holder_shares ?? "0",
        // Share of the supply the tracked positions add up to, as a percentage.
        // Under 100 when the indexer is behind chain.
        coverage: denominator > 0 ? round4((holderShares / denominator) * 100) : 0,
      },
      concentration: {
        top1SharePct: sharePct(cumulativeShares(REPORTED_RANKS[0])),
        top5SharePct: sharePct(cumulativeShares(REPORTED_RANKS[1])),
        top10SharePct: sharePct(cumulativeShares(REPORTED_RANKS[2])),
        hhi: round4(hhi),
        hhiIndex,
        riskLevel: riskLevelFor(hhiIndex),
      },
      topHolders: holderRows.slice(0, topN).map((row, index) => ({
        rank: index + 1,
        address: row.address,
        shares: row.shares,
        sharePct: sharePct(Number(row.shares)),
        valueLocked: row.value_locked,
      })),
    });
  } catch (err) {
    next(err);
  }
}
