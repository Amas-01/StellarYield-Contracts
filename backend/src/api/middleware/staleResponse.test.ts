import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";
import {
  captureForStaleFallback,
  getStaleResponse,
  rememberStaleResponse,
  resetStaleResponsesForTests,
  sendStaleResponse,
} from "./staleResponse.js";

// Default STALE_TTL_SECONDS is 600 and the fresh window is 10 s, so a copy is
// kept for 610 s after it was captured.
const RETENTION_MS = 610 * 1000;

function makeRes(statusCode = 200) {
  return {
    statusCode,
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as any;
}

function makeReq(overrides: Partial<Request> = {}) {
  return { method: "GET", originalUrl: "/api/v1/vaults?page=1", ...overrides } as unknown as Request;
}

describe("stale response store (#1254)", () => {
  beforeEach(() => {
    resetStaleResponsesForTests();
  });

  it("returns a stored copy until fresh plus stale TTL has passed", () => {
    rememberStaleResponse("/k", '{"v":1}', 0);

    expect(getStaleResponse("/k", RETENTION_MS - 1)).toBe('{"v":1}');
    expect(getStaleResponse("/k", RETENTION_MS)).toBeUndefined();
  });

  it("evicts the oldest copy once the store is full", () => {
    for (let i = 0; i <= 500; i += 1) {
      rememberStaleResponse(`/k/${i}`, "{}", 0);
    }

    expect(getStaleResponse("/k/0", 0)).toBeUndefined();
    expect(getStaleResponse("/k/500", 0)).toBe("{}");
  });
});

describe("captureForStaleFallback", () => {
  beforeEach(() => {
    resetStaleResponsesForTests();
  });

  it("stores the body of an anonymous 200 response", () => {
    const req = makeReq();
    const res = makeRes(200);
    const next = vi.fn();

    captureForStaleFallback(req, res, next);
    res.json({ items: [1, 2] });

    expect(next).toHaveBeenCalledOnce();
    expect(getStaleResponse("/api/v1/vaults?page=1")).toBe('{"items":[1,2]}');
  });

  it("does not store authenticated responses, which may be key-scoped", () => {
    const req = makeReq({ apiKey: { id: 7 } } as Partial<Request>);
    const res = makeRes(200);

    captureForStaleFallback(req, res, vi.fn());
    res.json({ scoped: true });

    expect(getStaleResponse("/api/v1/vaults?page=1")).toBeUndefined();
  });

  it("does not store non-200 responses", () => {
    const req = makeReq();
    const res = makeRes(404);

    captureForStaleFallback(req, res, vi.fn());
    res.json({ message: "Vault not found" });

    expect(getStaleResponse("/api/v1/vaults?page=1")).toBeUndefined();
  });

  it("passes non-GET requests straight through", () => {
    const req = makeReq({ method: "POST" } as Partial<Request>);
    const res = makeRes(200);
    const next = vi.fn();

    captureForStaleFallback(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe("sendStaleResponse", () => {
  beforeEach(() => {
    resetStaleResponsesForTests();
  });

  it("serves the stored copy with the STALE cache and Warning headers", () => {
    rememberStaleResponse("/api/v1/vaults?page=1", '{"items":[]}');
    const res = makeRes();

    const served = sendStaleResponse(makeReq(), res);

    expect(served).toBe(true);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.set).toHaveBeenCalledWith("X-Cache", "STALE");
    expect(res.set).toHaveBeenCalledWith("Warning", '110 - "Response is Stale"');
    expect(res.send).toHaveBeenCalledWith('{"items":[]}');
  });

  it("returns false when nothing is stored for the URL", () => {
    const res = makeRes();

    expect(sendStaleResponse(makeReq(), res)).toBe(false);
    expect(res.send).not.toHaveBeenCalled();
  });

  it("never serves a stored copy to an authenticated request", () => {
    rememberStaleResponse("/api/v1/vaults?page=1", '{"items":[]}');
    const res = makeRes();

    expect(sendStaleResponse(makeReq({ apiKey: { id: 7 } } as Partial<Request>), res)).toBe(false);
    expect(res.send).not.toHaveBeenCalled();
  });
});
