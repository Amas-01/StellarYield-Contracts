import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: { totalCount: 5, idleCount: 5, waitingCount: 0, query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock("../cache/redis.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

import { sseManager } from "./sseManager.js";
import { sseService } from "./sse.js";
import { decrementSseConnections, getMetrics, resetSseConnections } from "./metrics.js";

type Handler = (...args: unknown[]) => void;

/** Minimal req/res pair that records the `close` handlers the manager registers. */
function makeStream() {
  const handlers = new Map<string, Handler[]>();
  const res = {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return res;
    }),
  };
  const req = {
    headers: {},
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return req;
    }),
  };
  return {
    req,
    res,
    emitClose: () => (handlers.get("close") ?? []).forEach((handler) => handler()),
    closeCount: () => (handlers.get("close") ?? []).length,
  };
}

async function scrapeGauge(name: string): Promise<string> {
  return (await getMetrics())
    .split("\n")
    .filter((line) => line.startsWith(name))
    .join("\n");
}

describe("sse_active_connections (#1092)", () => {
  beforeEach(() => {
    sseManager.reset();
    resetSseConnections();
    vi.clearAllMocks();
  });

  it("is exposed by /metrics with a value of 0 when no stream is open", async () => {
    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 0");
  });

  it("counts a vault stream from open to close", async () => {
    const stream = makeStream();

    sseManager.addVaultClient(stream.req as never, stream.res as never);
    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 1");

    stream.emitClose();
    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 0");
  });

  it("counts an indexer progress stream from open to close", async () => {
    const stream = makeStream();

    sseManager.addIndexerClient(stream.req as never, stream.res as never);
    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 1");

    stream.emitClose();
    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 0");
  });

  it("counts every concurrently open stream", async () => {
    const streams = [makeStream(), makeStream(), makeStream()];

    for (const stream of streams) {
      sseManager.addVaultClient(stream.req as never, stream.res as never);
    }
    expect(sseManager.getSseConnectionCount()).toBe(3);
    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 3");

    streams[0]!.emitClose();
    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 2");

    streams[1]!.emitClose();
    streams[2]!.emitClose();
    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 0");
  });

  it("does not double count a close that fires on both the request and the response", async () => {
    const stream = makeStream();

    sseManager.addVaultClient(stream.req as never, stream.res as never);
    // The manager registers one handler on the request and one on the response,
    // and a disconnect can fire both.
    expect(stream.closeCount()).toBe(2);

    stream.emitClose();
    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 0");
  });

  it("never goes below zero", async () => {
    const stream = makeStream();
    sseManager.addVaultClient(stream.req as never, stream.res as never);
    stream.emitClose();

    decrementSseConnections();
    decrementSseConnections();

    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 0");
  });

  it("tracks streams opened through SseService (yields and webhook feeds)", async () => {
    const res = { write: vi.fn() } as never;

    const clientId = sseService.registerClient(res, "127.0.0.1", false);
    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 1");

    sseService.unregisterClient(clientId);
    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 0");
  });

  it("ignores an unregister for a client it never registered", async () => {
    sseService.unregisterClient("never-registered");

    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 0");
  });

  it("resets the gauge together with the manager's connection state", async () => {
    sseManager.addVaultClient(makeStream().req as never, makeStream().res as never);
    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 1");

    sseManager.reset();

    expect(await scrapeGauge("sse_active_connections")).toContain("sse_active_connections 0");
  });
});
