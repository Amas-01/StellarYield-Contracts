import { Router } from "express";
import { pool } from "../../db/index.js";
import { config } from "../../config.js";
import { readTotalVaults } from "../../services/stellar.js";
import { indexer } from "../../services/indexerSingleton.js";

export const statusRouter = Router();

type ComponentStatus = "operational" | "degraded" | "outage";
type OverallStatus = "operational" | "degraded" | "outage";

interface StatusComponent {
  name: string;
  status: ComponentStatus;
  message: string;
}

const RPC_CHECK_TIMEOUT_MS = 3000;

/**
 * GET /api/status
 *
 * Returns a public status page showing whether the API is degraded and which
 * components are affected (#917).
 *
 * Components checked: api, database, indexer, rpc.
 * - status: "operational" — all components healthy.
 * - status: "degraded"    — at least one non-api component is unhealthy.
 * - status: "outage"      — the api component itself is reporting an error.
 */
statusRouter.get("/", async (_req, res) => {
  const components: StatusComponent[] = [];

  // ── database ─────────────────────────────────────────────────────────────
  let dbStatus: ComponentStatus = "operational";
  let dbMessage = "Database is reachable";
  try {
    await pool.query("SELECT 1");
  } catch {
    dbStatus = "degraded";
    dbMessage = "Database query failed";
  }
  components.push({ name: "database", status: dbStatus, message: dbMessage });

  // ── indexer ───────────────────────────────────────────────────────────────
  let indexerStatus: ComponentStatus = "operational";
  let indexerMessage = "Indexer is running";
  try {
    const running = indexer.isRunning();
    if (!running) {
      indexerStatus = "degraded";
      indexerMessage = "Indexer is not running";
    }
  } catch {
    indexerStatus = "degraded";
    indexerMessage = "Indexer status unavailable";
  }
  components.push({ name: "indexer", status: indexerStatus, message: indexerMessage });

  // ── rpc ───────────────────────────────────────────────────────────────────
  let rpcStatus: ComponentStatus = "operational";
  let rpcMessage = "RPC is reachable";
  const contractId = config.stellar.vaultFactoryContractId || null;
  if (contractId) {
    try {
      await Promise.race([
        readTotalVaults(contractId),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("rpc check timed out")), RPC_CHECK_TIMEOUT_MS),
        ),
      ]);
    } catch {
      rpcStatus = "degraded";
      rpcMessage = "RPC is unreachable or timed out";
    }
  } else {
    rpcStatus = "degraded";
    rpcMessage = "RPC not configured";
  }
  components.push({ name: "rpc", status: rpcStatus, message: rpcMessage });

  // ── api (self) ────────────────────────────────────────────────────────────
  // The api component is healthy as long as this handler is executing. An
  // "outage" would only occur if the process itself can't respond — which by
  // definition can't be self-reported. We mark it operational here; callers
  // can infer outage from a total lack of response.
  const apiStatus: ComponentStatus = "operational";
  const apiMessage = "API is responding";
  components.push({ name: "api", status: apiStatus, message: apiMessage });

  // ── derive overall status ─────────────────────────────────────────────────
  // Per spec: "outage" only if api itself is reporting an error; "degraded" if
  // any other component is unhealthy.
  let overall: OverallStatus = "operational";
  if (components.some((c) => c.status !== "operational")) {
    overall = "degraded";
  }

  res.json({ status: overall, components });
});
