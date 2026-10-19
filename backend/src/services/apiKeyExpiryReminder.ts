import { query } from "../db/index.js";
import { logger } from "../logger.js";

/** Window used by the daily reminder job (#1245). */
export const EXPIRY_REMINDER_WINDOW_DAYS = 7;

/** A row of the admin key listing; `expires_at` is non-null only inside the window. */
export interface ApiKeyListRow {
  id: number;
  label: string | null;
  role: string;
  description: string | null;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  active: boolean;
  deactivated_at: Date | null;
  allowed_methods: string[] | null;
  allowed_cidrs: string[] | null;
  allowed_contract_ids: string[] | null;
}

/**
 * Active keys whose expiry falls between now and `days` from now (#1245).
 *
 * Keys that have already expired are not included, since they can no longer
 * authenticate and a reminder is no longer useful. The query never reads
 * `key_hash`, so the result carries no secret material.
 */
export async function findApiKeysExpiringWithin(days: number): Promise<ApiKeyListRow[]> {
  // `make_interval` keeps the window a bound parameter rather than
  // interpolated SQL, as in the inactivity sweep.
  return query<ApiKeyListRow>(
    `SELECT id, label, role, description, created_at, expires_at, last_used_at, active,
            deactivated_at, allowed_methods, allowed_cidrs, allowed_contract_ids
       FROM api_keys
      WHERE active
        AND expires_at > NOW()
        AND expires_at <= NOW() + make_interval(days => $1::int)
      ORDER BY expires_at ASC, id ASC`,
    [days],
  );
}

/**
 * Log a `warn` entry per key expiring within the window. Only the label, id and
 * expiry date are logged, never the key itself.
 */
export async function logApiKeysExpiringSoon(days = EXPIRY_REMINDER_WINDOW_DAYS): Promise<number> {
  const rows = await findApiKeysExpiringWithin(days);
  const now = Date.now();

  for (const row of rows) {
    // The query only returns rows inside the window, so expires_at is set.
    if (!row.expires_at) continue;
    logger.warn(
      {
        event: "api_key_expiring_soon",
        keyId: row.id,
        keyLabel: row.label,
        expiresAt: row.expires_at,
        daysRemaining: Math.ceil((row.expires_at.getTime() - now) / (24 * 60 * 60 * 1000)),
        windowDays: days,
      },
      "API key expires soon",
    );
  }

  if (rows.length > 0) {
    logger.info({ expiring: rows.length, windowDays: days }, "API key expiry reminder complete");
  }

  return rows.length;
}
