import { createHash } from "node:crypto";
import type { Request } from "express";
import { query } from "../db/index.js";

export function getClientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]?.trim() || null;
  }
  if (Array.isArray(forwarded)) {
    return forwarded[0] ?? null;
  }
  return req.ip ?? null;
}

export function getRequestBodyHash(body: unknown): string {
  const normalized = typeof body === "string"
    ? body
    : body == null
      ? ""
      : JSON.stringify(body);
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Appends an entry to the admin audit trail: which API key (or session) did
 * what, to which target, from where. Every destructive or privacy-sensitive
 * admin action goes through here, so it lives in its own module rather than in
 * the admin controller where it was originally defined.
 */
export async function logAdminAudit(req: Request, action: string, target: string): Promise<void> {
  await query(
    `INSERT INTO admin_audit_log (api_key_label, action, target, ip_address, request_body_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [req.apiKey?.label ?? null, action, target, getClientIp(req), getRequestBodyHash(req.body)],
  );
}

/**
 * Audit entry for actions taken by background workers rather than an
 * API request — the indexer, for example. `request_body_hash` is derived from
 * the structured `details` so the NOT NULL column stays satisfied.
 *
 * Callers that must be replay-safe should pass `conflictTarget: true`: the
 * insert then becomes an `ON CONFLICT DO NOTHING` guarded by the partial
 * unique index for `action`, which keeps a ledger re-scan from writing the
 * same entry twice.
 */
export async function logSystemAudit(
  action: string,
  target: string,
  details?: Record<string, unknown>,
  options: { apiKeyLabel?: string | null; conflictTarget?: boolean } = {},
): Promise<void> {
  const serialized = details ? JSON.stringify(details) : null;
  await query(
    `INSERT INTO admin_audit_log (api_key_label, action, target, ip_address, request_body_hash, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
     ${options.conflictTarget ? "ON CONFLICT DO NOTHING" : ""}`,
    [
      options.apiKeyLabel ?? "system:indexer",
      action,
      target,
      "127.0.0.1",
      createHash("sha256").update(serialized ?? "").digest("hex"),
      serialized,
    ],
  );
}
