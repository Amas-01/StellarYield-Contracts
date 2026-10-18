// Test data builders for epochs (#1297).
//
// Mirrors the `epochs` table row shape used by the yield epoch endpoints
// (`getVaultEpochs`, `getEpochsInRange`, batch endpoints).
import type { EpochRow } from "./epoch.js";

export function buildEpoch(overrides: Partial<EpochRow> = {}): EpochRow {
  const epoch = overrides.epoch ?? 1;
  return {
    id: overrides.id ?? epoch,
    vault_id: overrides.vault_id ?? 1,
    epoch,
    yield_amount: overrides.yield_amount ?? "1000",
    total_shares: overrides.total_shares ?? "1000",
    distributed_at:
      overrides.distributed_at ?? new Date("2025-02-01T00:00:00.000Z"),
    net_yield: overrides.net_yield ?? null,
  };
}

/** Build a run of epoch rows for a vault, ascending by `epoch`. */
export function buildEpochs(
  epochs: number[],
  overrides: Partial<EpochRow> = {},
): EpochRow[] {
  return epochs.map((epoch) => buildEpoch({ ...overrides, epoch }));
}
