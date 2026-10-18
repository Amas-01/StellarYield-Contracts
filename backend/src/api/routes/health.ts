import { readFileSync } from "fs";
import { Router } from "express";
import { pool } from "../../db/index.js";
import { config } from "../../config.js";
import { readTotalVaults, getLatestLedger, getSorobanRpc } from "../../services/stellar.js";
import { sseManager } from "../../services/sseManager.js";

const { version } = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf-8"),
) as { version: string };

// Captured once, when this module is first loaded at process startup (#830),
// so uptimeSeconds is relative to process start and resets to 0 on restart.
// process.hrtime.bigint() is a monotonic clock, unaffected by system clock
// adjustments, so uptimeSeconds only ever increases between health checks.
const startedAtHrTime = process.hrtime.bigint();

export const healthRouter = Router();

const FACTORY_HEALTH_CHECK_TIMEOUT_MS = 3000;
const RPC_HEALTH_CHECK_TIMEOUT_MS = 3000;

/**
 * Check whether the factory contract is reachable via a lightweight view
 * call, bounded by a timeout so a stalled RPC never blocks /health (#844).
 */
async function checkFactoryReachable(contractId: string): Promise<boolean> {
  try {
    await Promise.race([
      readTotalVaults(contractId),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("factory reachability check timed out")), FACTORY_HEALTH_CHECK_TIMEOUT_MS),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether the Stellar RPC endpoint is reachable and measure latency via a
 * lightweight getLatestLedger call bounded by a 3-second timeout.
 */
async function checkRpcHealth(): Promise<{ latencyMs: number | null; reachable: boolean }> {
  const start = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error("RPC health check timed out")),
        RPC_HEALTH_CHECK_TIMEOUT_MS,
      );
    });

    const callPromise = typeof getLatestLedger === "function"
      ? getLatestLedger()
      : getSorobanRpc().getLatestLedger();

    await Promise.race([callPromise, timeoutPromise]);
    const latencyMs = Math.max(0, Date.now() - start);
    return { latencyMs, reachable: true };
  } catch {
    return { latencyMs: null, reachable: false };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

healthRouter.get("/", async (_req, res) => {
  // Surface connection pool utilisation so operators can detect connection
  // exhaustion before it causes query timeouts (#657). `waiting > 0` means
  // requests are queued for a connection — a sign of pool pressure.
  const dbPool = {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };

  const mem = process.memoryUsage();
  const memory = {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
  };

  const contractId = config.stellar.vaultFactoryContractId || null;
  const [factoryReachable, rpc] = await Promise.all([
    contractId !== null ? checkFactoryReachable(contractId) : Promise.resolve(false),
    checkRpcHealth(),
  ]);
  const factory = {
    reachable: factoryReachable,
    contractId,
  };
  const sseConnections = sseManager.getSseConnectionCount();
  const uptimeSeconds = Number(process.hrtime.bigint() - startedAtHrTime) / 1e9;

  try {
    await pool.query("SELECT 1");
    res.json({ version, status: "ok", uptimeSeconds, dbPool, factory, rpc, memory, sseConnections });
  } catch {
    res.status(503).json({ version, status: "error", uptimeSeconds, dbPool, factory, rpc, memory, sseConnections });
  }
});

