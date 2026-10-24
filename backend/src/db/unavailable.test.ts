import { describe, it, expect } from "vitest";
import { isDatabaseUnavailableError } from "./unavailable.js";

describe("isDatabaseUnavailableError (#1254)", () => {
  it("treats connection-level network codes as unavailable", () => {
    expect(isDatabaseUnavailableError(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isDatabaseUnavailableError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
  });

  it("treats admin shutdown and connection-exception SQLSTATE classes as unavailable", () => {
    expect(isDatabaseUnavailableError(Object.assign(new Error("shutdown"), { code: "57P01" }))).toBe(true);
    expect(isDatabaseUnavailableError(Object.assign(new Error("conn"), { code: "08006" }))).toBe(true);
  });

  it("recognises pg-pool messages that carry no code", () => {
    expect(isDatabaseUnavailableError(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isDatabaseUnavailableError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("looks inside an AggregateError from a multi-address connect attempt", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED ::1"), { code: "ECONNREFUSED" });
    expect(isDatabaseUnavailableError(new AggregateError([inner], "connect failed"))).toBe(true);
  });

  it("does not treat a query that ran and failed as unavailable", () => {
    expect(isDatabaseUnavailableError(Object.assign(new Error("relation missing"), { code: "42P01" }))).toBe(false);
    expect(isDatabaseUnavailableError(Object.assign(new Error("cancelled"), { code: "57014" }))).toBe(false);
  });

  it("returns false for values that are not errors", () => {
    expect(isDatabaseUnavailableError(undefined)).toBe(false);
    expect(isDatabaseUnavailableError(null)).toBe(false);
    expect(isDatabaseUnavailableError("ECONNREFUSED")).toBe(false);
    expect(isDatabaseUnavailableError(new Error("something else"))).toBe(false);
  });
});
