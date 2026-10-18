import { describe, it, expect, vi, beforeEach } from "vitest";
import { runSanctionsCheck, parseSanctionsContent } from "./sanctionsWorker.js";
import { query } from "../db/index.js";

vi.mock("../db/index.js", () => ({
  query: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("Sanctions auto-blacklist worker (#1113)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses JSON sanctions list correctly", () => {
    const json = JSON.stringify([
      "GAX111111111111111111111111111111111111111111111111111111111",
      { address: "GAY222222222222222222222222222222222222222222222222222222222" },
    ]);
    const set = parseSanctionsContent(json);
    expect(set.has("GAX111111111111111111111111111111111111111111111111111111111")).toBe(true);
    expect(set.has("GAY222222222222222222222222222222222222222222222222222222222")).toBe(true);
  });

  it("parses CSV sanctions list correctly", () => {
    const csv = `# OFAC SDN List\nGAX111111111111111111111111111111111111111111111111111111111,Individual\n"GAY222222222222222222222222222222222222222222222222222222222",Entity`;
    const set = parseSanctionsContent(csv);
    expect(set.has("GAX111111111111111111111111111111111111111111111111111111111")).toBe(true);
    expect(set.has("GAY222222222222222222222222222222222222222222222222222222222")).toBe(true);
  });

  it("identifies matching transfer addresses, blacklists them, and records in admin_audit_log", async () => {
    const sanctionedAddress = "GSANCTIONED1111111111111111111111111111111111111111111111111";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify([sanctionedAddress]),
    } as any);

    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM transfers")) {
        return [{ address: sanctionedAddress }, { address: "GCLEAN11111111111111111111111111111111111111111111111111111" }] as any;
      }
      if (sql.includes("FROM vaults")) {
        return [{ id: 1 }, { id: 2 }] as any;
      }
      return [] as any;
    });

    const result = await runSanctionsCheck("https://example.com/sanctions.json");
    expect(result.scannedAddresses).toBe(2);
    expect(result.blacklistedAddresses).toEqual([sanctionedAddress]);

    // Verify user table updated
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("aml_flagged = TRUE"),
      [sanctionedAddress]
    );

    // Verify admin_audit_log entry created
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO admin_audit_log"),
      [sanctionedAddress, expect.any(String)]
    );
  });
});
