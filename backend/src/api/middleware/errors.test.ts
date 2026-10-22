import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";
import { AppError, ErrorCode, errorHandler } from "./errors.js";
import { rememberStaleResponse, resetStaleResponsesForTests } from "./staleResponse.js";

function makeRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as any;
}

function makeReq(overrides: Record<string, unknown> = {}) {
  return { method: "GET", path: "/api/v1/vaults", originalUrl: "/api/v1/vaults", ...overrides } as unknown as Request;
}

function dbDownError(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
}

describe("errorHandler database outage (#1254, #1253)", () => {
  beforeEach(() => {
    resetStaleResponsesForTests();
  });

  it("serves the stored copy when the database is unreachable", () => {
    rememberStaleResponse("/api/v1/vaults", '{"items":["cached"]}');
    const res = makeRes();

    errorHandler(dbDownError(), makeReq(), res, vi.fn());

    expect(res.set).toHaveBeenCalledWith("X-Cache", "STALE");
    expect(res.set).toHaveBeenCalledWith("Warning", '110 - "Response is Stale"');
    expect(res.send).toHaveBeenCalledWith('{"items":["cached"]}');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("answers 503 with Retry-After when there is no stored copy", () => {
    const res = makeRes();

    errorHandler(dbDownError(), makeReq(), res, vi.fn());

    expect(res.set).toHaveBeenCalledWith("Retry-After", "30");
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: ErrorCode.SERVICE_UNAVAILABLE, statusCode: 503 }),
    );
  });

  it("does not serve a stale copy to an authenticated request", () => {
    rememberStaleResponse("/api/v1/vaults", '{"items":["cached"]}');
    const res = makeRes();

    errorHandler(dbDownError(), makeReq({ apiKey: { id: 7 } }), res, vi.fn());

    expect(res.send).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("adds Retry-After to any 503 AppError", () => {
    const res = makeRes();

    errorHandler(new AppError(ErrorCode.INTERNAL_SERVER_ERROR, "down for maintenance", 503), makeReq(), res, vi.fn());

    expect(res.set).toHaveBeenCalledWith("Retry-After", "30");
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("leaves non-503 errors without Retry-After", () => {
    const res = makeRes();

    errorHandler(new AppError(ErrorCode.VAULT_NOT_FOUND, "missing", 404), makeReq(), res, vi.fn());

    expect(res.set).not.toHaveBeenCalledWith("Retry-After", expect.anything());
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
