import { describe, it, expect, beforeEach, vi } from "vitest";
import { VaultService } from "./vault.js";
import * as db from "../db/index.js";

vi.mock("../db/index.js");
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../cache/redis.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

const CONTRACT_ID = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3B";

function baseRow(overrides: Record<string, unknown> = {}) {
  const createdAt = new Date();
  return {
    id: 1,
    contract_id: CONTRACT_ID,
    factory_id: null,
    asset: "USDC",
    name: "Treasury Bill Vault",
    symbol: "sTBill",
    state: "Active",
    total_assets: "1000",
    total_supply: "1000",
    total_shares_ever_minted: "1000",
    total_shares_ever_burned: "0",
    depositor_count: 5,
    funding_target: null,
    funding_deadline: null,
    min_deposit: null,
    max_deposit_per_user: null,
    zkme_verifier_address: null,
    rwa_name: null,
    rwa_symbol: null,
    rwa_document_uri: null,
    rwa_category: null,
    description: null,
    logo_uri: null,
    created_at: createdAt,
    updated_at: createdAt,
    settlement_status: null,
    supply_at_maturity: null,
    ...overrides,
  };
}

describe("VaultService.getVault redeemedPct (#1275)", () => {
  let vaultService: VaultService;

  beforeEach(() => {
    vaultService = new VaultService();
    vi.clearAllMocks();
  });

  it("omits redeemedPct for a non-matured vault", async () => {
    vi.mocked(db.query).mockResolvedValueOnce([
      baseRow({ state: "Active", total_supply: "1000", supply_at_maturity: null }),
    ]);

    const vault = await vaultService.getVault(CONTRACT_ID);

    expect(vault).not.toBeNull();
    expect(vault).not.toHaveProperty("redeemedPct");
    expect(JSON.stringify(vault)).not.toContain("redeemedPct");
  });

  it("is 0 right after maturity, when no redemptions have happened yet", async () => {
    vi.mocked(db.query).mockResolvedValueOnce([
      baseRow({ state: "Matured", total_supply: "1000", supply_at_maturity: "1000" }),
    ]);

    const vault = await vaultService.getVault(CONTRACT_ID);

    expect(vault?.redeemedPct).toBe(0);
  });

  it("is 1 once the supply reaches zero", async () => {
    vi.mocked(db.query).mockResolvedValueOnce([
      baseRow({ state: "Matured", total_supply: "0", supply_at_maturity: "1000" }),
    ]);

    const vault = await vaultService.getVault(CONTRACT_ID);

    expect(vault?.redeemedPct).toBe(1);
  });

  it("reports the fraction redeemed partway through settlement", async () => {
    vi.mocked(db.query).mockResolvedValueOnce([
      baseRow({ state: "Matured", total_supply: "400", supply_at_maturity: "1000" }),
    ]);

    const vault = await vaultService.getVault(CONTRACT_ID);

    // 1 - 400/1000 = 0.6
    expect(vault?.redeemedPct).toBe(0.6);
  });

  it("omits redeemedPct for a matured vault with no recorded baseline", async () => {
    vi.mocked(db.query).mockResolvedValueOnce([
      baseRow({ state: "Matured", total_supply: "400", supply_at_maturity: null }),
    ]);

    const vault = await vaultService.getVault(CONTRACT_ID);

    expect(vault).not.toHaveProperty("redeemedPct");
  });
});
