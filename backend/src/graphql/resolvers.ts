import { tvlPubSub } from "../services/tvlPubSub.js";
import { GraphQLError } from "graphql";
import { UserService } from "../services/user.js";
import { YieldService } from "../services/yield.js";
import { query } from "../db/index.js";
import type { GraphQLContext } from "./context.js";

const userService = new UserService();
const yieldService = new YieldService();

/** Throws when the resolved API key role does not grant access (#772). */
function requireRole(role: string, context: GraphQLContext): void {
  if (context?.role !== role) {
    throw new GraphQLError("Forbidden", { extensions: { code: "FORBIDDEN" } });
  }
}

function computeYieldPerShare(yieldAmount: string, totalShares: string): string {
  const yieldBig = BigInt(yieldAmount);
  const sharesBig = BigInt(totalShares);
  if (sharesBig === BigInt(0)) return "0";
  const DECIMALS = BigInt(10) ** BigInt(18);
  const result = (yieldBig * DECIMALS) / sharesBig;
  const padded = result.toString().padStart(19, "0");
  return `${padded.slice(0, -18)}.${padded.slice(-18)}`;
}

// Vault lifecycle states stored in vaults.state (#1117).
const VAULT_STATES = ["Funding", "Active", "Matured", "Closed", "Cancelled"];

export const root = {
  health: () => "ok",
  user: async ({ address }: { address: string }) => {
    const user = await userService.getUser(address);
    if (!user) return null;
    return {
      address: user.address,
      kycVerified: user.kycVerified,
      createdAt: user.createdAt.toISOString(),
    };
  },
  epochs: async ({ contractId }: { contractId: string }) => {
    const epochs = await yieldService.getVaultEpochs(contractId);
    return epochs.map((e) => ({
      epoch: e.epoch,
      yieldAmount: e.yieldAmount,
      totalShares: e.totalShares,
      yieldPerShare: computeYieldPerShare(e.yieldAmount, e.totalShares),
      distributedAt: e.distributedAt ? e.distributedAt.toISOString() : null,
    }));
  },
  vaultsByStatus: async ({ status }: { status: string }) => {
    const normalized = VAULT_STATES.find((s) => s.toLowerCase() === status.trim().toLowerCase());
    if (!normalized) {
      throw new GraphQLError(`Invalid status "${status}". Expected one of: ${VAULT_STATES.join(", ")}`, {
        extensions: { code: "BAD_USER_INPUT" },
      });
    }
    const rows = await query<{
      contract_id: string;
      asset: string;
      name: string | null;
      symbol: string | null;
      state: string;
      total_assets: string | null;
      total_supply: string | null;
    }>(
      "SELECT contract_id, asset, name, symbol, state, total_assets, total_supply FROM vaults WHERE state = $1 ORDER BY created_at DESC",
      [normalized],
    );
    return rows.map((row) => ({
      contractId: row.contract_id,
      asset: row.asset,
      name: row.name,
      symbol: row.symbol,
      state: row.state,
      totalAssets: String(row.total_assets ?? "0"),
      totalSupply: String(row.total_supply ?? "0"),
    }));
  },
  vaultTvlUpdated: async function* ({ contractId }: { contractId?: string }) {
    for await (const payload of tvlPubSub.asyncIterator(contractId)) {
      yield { vaultTvlUpdated: payload };
    }
  },
  apiKeys: async (_args: unknown, context: GraphQLContext) => {
    requireRole("admin", context);
    const rows = await query<{ id: number; label: string | null; role: string; created_at: Date }>(
      "SELECT id, label, role, created_at FROM api_keys ORDER BY created_at DESC",
    );
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      role: row.role,
      createdAt: row.created_at.toISOString(),
    }));
  },
};

