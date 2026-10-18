import { createHash } from "crypto";

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  enabledForRoles: string[];
  rolloutPercent: number;
  updatedAt: Date;
}

/**
 * In-memory feature flag store.
 *
 * For production use the flags would be persisted to the `feature_flags`
 * table (see schema.sql). The in-memory map is the source of truth here so
 * the system works without a live DB during development/testing.
 *
 * Schema (for reference):
 *   CREATE TABLE IF NOT EXISTS feature_flags (
 *     name               TEXT PRIMARY KEY,
 *     enabled            BOOLEAN NOT NULL DEFAULT FALSE,
 *     enabled_for_roles  TEXT[] NOT NULL DEFAULT '{}',
 *     rollout_percent    INT NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
 *     updated_at         TIMESTAMPTZ DEFAULT NOW()
 *   );
 *
 * Closes #916
 */
const flags: Map<string, FeatureFlag> = new Map();

export function listFlags(): FeatureFlag[] {
  return Array.from(flags.values());
}

export function getFlag(name: string): FeatureFlag | undefined {
  return flags.get(name);
}

export function upsertFlag(
  name: string,
  patch: { enabled?: boolean; rolloutPercent?: number; enabledForRoles?: string[] },
): FeatureFlag {
  const existing = flags.get(name) ?? {
    name,
    enabled: false,
    enabledForRoles: [],
    rolloutPercent: 0,
    updatedAt: new Date(),
  };
  const updated: FeatureFlag = {
    ...existing,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.rolloutPercent !== undefined ? { rolloutPercent: patch.rolloutPercent } : {}),
    ...(patch.enabledForRoles !== undefined ? { enabledForRoles: patch.enabledForRoles } : {}),
    updatedAt: new Date(),
  };
  flags.set(name, updated);
  return updated;
}

/**
 * Returns true when a flag is considered active for the given request
 * identifier (e.g. an IP address or user ID).
 *
 * - If `enabled` is false → always off.
 * - If `rolloutPercent` is 100 → always on.
 * - Otherwise we hash the identifier to get a stable 0-99 bucket; the flag
 *   is active when bucket < rolloutPercent (50 % ≈ half the identifiers).
 */
export function isFlagEnabled(name: string, requestId: string): boolean {
  const flag = flags.get(name);
  if (!flag || !flag.enabled) return false;
  if (flag.rolloutPercent >= 100) return true;
  if (flag.rolloutPercent <= 0) return false;

  // Stable hash-based bucketing — same requestId always lands in the same bucket.
  const hash = createHash("sha256").update(`${name}:${requestId}`).digest("hex");
  const bucket = parseInt(hash.slice(0, 8), 16) % 100;
  return bucket < flag.rolloutPercent;
}
