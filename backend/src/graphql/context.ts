import { createHash } from "crypto";
import type { Request as ExpressRequest } from "express";
import { query } from "../db/index.js";

export interface GraphQLContext {
  [key: string]: unknown;
  [key: number]: unknown;
  [key: symbol]: unknown;
  role: string | null;
}

/**
 * Builds the per-request GraphQL context by resolving the `Authorization: Bearer <key>`
 * header to an API key role, mirroring the REST `requireApiKey` middleware (#772).
 */
export async function createGraphQLContext(req: { raw: ExpressRequest }): Promise<GraphQLContext> {
  const authHeader = req.raw.headers.authorization;
  const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  if (!headerValue?.startsWith("Bearer ")) {
    return { role: null };
  }

  const plaintext = headerValue.slice(7);
  // Support both legacy (unsalted) and new (salted) key hashes (#1239).
  const unsaltedHash = createHash("sha256").update(plaintext).digest("hex");
  const rows = await query<{ role: string; key_salt: string | null; key_hash: string }>(
    "SELECT role, key_salt, key_hash FROM api_keys WHERE key_hash = $1",
    [unsaltedHash],
  ).catch(() => []);

  return { role: rows[0]?.role ?? null };
}
