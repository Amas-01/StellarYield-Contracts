// Mock Soroban JSON-RPC server (#1298).
//
// A tiny, dependency-free (express only) stand-in for a real Soroban RPC node
// so local development and tests can run offline instead of against flaky,
// rate-limited testnet. Responses are loaded from JSON fixtures in
// `dev/fixtures/`; `getEvents` entries may be written with plain native values
// (strings/numbers/arrays), which this server encodes into base64 XDR ScVals so
// the Stellar SDK and the indexer pipelines decode them exactly like real data.
//
// Usage: `npm run mock-rpc` and point `STELLAR_RPC_URL` at
// `http://localhost:8001` (see backend/README.md).
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(__dirname, "fixtures");

export const SUPPORTED_METHODS = [
  "getHealth",
  "getLatestLedger",
  "getEvents",
  "simulateTransaction",
] as const;
export type SupportedMethod = (typeof SUPPORTED_METHODS)[number];

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

function loadFixture<T = unknown>(method: string): T {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, `${method}.json`), "utf8"),
  ) as T;
}

// ── Fixture → wire-format helpers ─────────────────────────────────────────────

/** Encode a plain native value (string/number/array/…) as a base64 XDR ScVal. */
function toScValWire(value: unknown): string {
  return nativeToScVal(value).toXDR("base64");
}

interface FixtureEvent {
  type?: string;
  contractId: string;
  ledger: number;
  id: string;
  txHash: string;
  ledgerClosedAt: string;
  transactionIndex?: number;
  operationIndex?: number;
  inSuccessfulContractCall?: boolean;
  topic: unknown[];
  value: unknown;
}

/** Convert one human-friendly fixture event into the raw wire event shape. */
function toWireEvent(def: FixtureEvent): Record<string, unknown> {
  return {
    type: def.type ?? "contract",
    contractId: def.contractId,
    ledger: def.ledger,
    id: def.id,
    txHash: def.txHash,
    ledgerClosedAt: def.ledgerClosedAt,
    pagingToken: `0000-${def.ledger}`,
    transactionIndex: def.transactionIndex ?? 0,
    operationIndex: def.operationIndex ?? 0,
    inSuccessfulContractCall: def.inSuccessfulContractCall ?? true,
    topic: def.topic.map((t) => toScValWire(t)),
    value: toScValWire(def.value),
  };
}

/**
 * Try to read the invoked contract function name out of the base64 transaction
 * envelope supplied in a `simulateTransaction` request, so the mock can return
 * a per-method retval from the fixture. Returns null on any decode failure.
 */
function invokedFunctionName(params: unknown): string | null {
  try {
    const transaction = (params as { transaction?: unknown } | undefined)?.transaction;
    if (typeof transaction !== "string") return null;
    const envelope = xdr.TransactionEnvelope.fromXDR(
      Buffer.from(transaction.replace(/^0x/, ""), "base64"),
    );
    const ops = envelope.v1 ? envelope.v1().tx().operations() : [];
    for (const op of ops) {
      if (!op.body().switch().equals(xdr.OperationType.invokeHostFunction())) {
        continue;
      }
      return op.body().invokeHostFunctionOp().hostFunction().invokeContract()
        .functionName()
        .toString();
    }
  } catch {
    // Fall through to the default retval.
  }
  return null;
}

// ── JSON-RPC dispatch (exported for tests) ────────────────────────────────────

export function dispatchJsonRpc(request: JsonRpcRequest): JsonRpcResponse {
  const respond = (body: Partial<JsonRpcResponse>): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: request.id ?? null,
    ...body,
  });

  if (
    typeof request.method !== "string" ||
    !SUPPORTED_METHODS.includes(request.method as SupportedMethod)
  ) {
    return respond({
      error: { code: -32601, message: "Method not found" },
    });
  }

  switch (request.method) {
    case "getHealth":
      return respond({ result: loadFixture(request.method) });
    case "getLatestLedger":
      return respond({ result: loadFixture(request.method) });
    case "getEvents": {
      const fixture = loadFixture<{ events: FixtureEvent[]; latestLedger: number; pagingToken: string }>(
        "getEvents",
      );
      return respond({
        result: {
          events: fixture.events.map(toWireEvent),
          latestLedger: fixture.latestLedger,
          pagingToken: fixture.pagingToken,
        },
      });
    }
    case "simulateTransaction": {
      const fixture = loadFixture<{
        contractMethods: Record<string, unknown>;
        default: unknown;
        feeBump?: boolean;
      }>("simulateTransaction");
      const fn = invokedFunctionName(request.params);
      const native = (fn && fixture.contractMethods[fn] !== undefined
        ? fixture.contractMethods[fn]
        : fixture.default) ?? 0;
      return respond({
        result: {
          result: { retval: toScValWire(native) },
          events: [],
          minResourceFee: "0",
        },
      });
    }
    default:
      break;
  }
  return respond({ error: { code: -32601, message: "Method not found" } });
}

// ── HTTP server ───────────────────────────────────────────────────────────────

export function createMockRpcApp(): express.Express {
  const app = express();
  app.use(express.json({ type: "*/*" }));

  app.post("/*", (req, res) => {
    res.type("application/json").json(dispatchJsonRpc(req.body ?? {}));
  });

  return app;
}

const MOCK_RPC_PORT = Number(process.env["MOCK_RPC_PORT"] ?? 8001);

const isDirectScriptRun = (() => {
  const scriptPath = process.argv[1] ? resolve(process.argv[1]) : null;
  return scriptPath !== null && scriptPath === fileURLToPath(import.meta.url);
})();

if (isDirectScriptRun) {
  const app = createMockRpcApp();
  app.listen(MOCK_RPC_PORT, () => {
    console.log(
      `Mock Soroban RPC listening on http://localhost:${MOCK_RPC_PORT}`,
    );
    console.log(
      `Start the API/indexer with STELLAR_RPC_URL=http://localhost:${MOCK_RPC_PORT}`,
    );
  });
}
