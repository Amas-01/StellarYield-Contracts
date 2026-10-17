// Mock Soroban RPC server (#1298).
import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { dispatchJsonRpc, SUPPORTED_METHODS } from "../../dev/mock-rpc.js";

const req = (method?: string, params?: unknown, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

describe("mock Soroban RPC server (#1298)", () => {
  it("supports the methods the indexer and services need", () => {
    expect(SUPPORTED_METHODS).toEqual([
      "getHealth",
      "getLatestLedger",
      "getEvents",
      "simulateTransaction",
    ]);
  });

  it("answers getHealth and getLatestLedger from the fixtures", () => {
    const health = dispatchJsonRpc(req("getHealth"));
    expect(health).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { status: "healthy" },
    });

    const ledger = dispatchJsonRpc(req("getLatestLedger", null, 7));
    expect(ledger.id).toBe(7);
    expect(ledger.result).toMatchObject({ sequence: 1002, protocolVersion: 22 });
  });

  it("encodes getEvents fixture topics/value as base64 ScVals", () => {
    const { events, latestLedger } = dispatchJsonRpc(req("getEvents"))
      .result as { events: { topic: string[]; value: string }[]; latestLedger: number };

    expect(latestLedger).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      for (const topic of event.topic) {
        expect(topic).toMatch(/^[A-Za-z0-9+/=]+$/);
      }
      expect(event.value).toMatch(/^[A-Za-z0-9+/=]+$/);
    }
  });

  it("returns the method-not-found JSON-RPC error for unsupported methods", () => {
    const resp = dispatchJsonRpc(req("getLedgerEntries")); // real RPC method, not mocked

    expect(resp).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    });
    expect(resp.result).toBeUndefined();

    // Non-RPC garbage as well.
    expect(dispatchJsonRpc(req("frobnicate")).error?.code).toBe(-32601);
    expect(dispatchJsonRpc(req(undefined)).error?.code).toBe(-32601);
  });

  it("returns a decodable retval for simulateTransaction even without an envelope", () => {
    const resp = dispatchJsonRpc(req("simulateTransaction", {}));
    expect(resp.error).toBeUndefined();
    const retval = (resp.result as { result: { retval: string } }).result.retval;
    expect(retval).toMatch(/^[A-Za-z0-9+/=]+$/);
    // The retval must round-trip as an ScVal loaded by the Stellar SDK.
    expect(() => xdr.ScVal.fromXDR(retval, "base64")).not.toThrow();
  });
});
