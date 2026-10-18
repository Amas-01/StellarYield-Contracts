import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const validEnv = {
  PORT: "3000",
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/stellaryield",
};

describe("config startup validation", () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("dotenv/config", () => ({}));
  });

  afterEach(() => {
    process.env = { ...original };
    vi.restoreAllMocks();
    vi.doUnmock("dotenv/config");
  });

  it("logs each missing/invalid variable and exits with code 1", async () => {
    process.env = { PORT: "not-a-port" };
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: string) => void errors.push(m));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(import("./config.js")).rejects.toThrow("process.exit");

    expect(exit).toHaveBeenCalledWith(1);
    const output = errors.join("\n");
    expect(output).toContain("PORT");
    expect(output).toContain("STELLAR_RPC_URL");
    expect(output).toContain("DATABASE_URL");
  });

  it("does not exit when all required variables are valid", async () => {
    process.env = { ...validEnv };
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    const { config } = await import("./config.js");

    expect(exit).not.toHaveBeenCalled();
    expect(config.port).toBe(3000);
  });
});
