import { describe, it, expect, vi } from "vitest";

vi.mock("../../db/index.js", () => ({
  query: vi.fn().mockResolvedValue([]),
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock("pino-http", () => ({ pinoHttp: () => (_req: any, _res: any, next: any) => next() }));

import supertest from "supertest";
import { createApp } from "../../app.js";
import { MAX_AMOUNT_LENGTH, MAX_DECIMALS, formatTokenAmount } from "./utils.js";

const app = createApp();

function post(body: unknown) {
  return supertest(app).post("/api/v1/utils/format-amount").send(body as object);
}

describe("formatTokenAmount (#1132)", () => {
  it("formats the acceptance-criteria example: 1000000 at 6 decimals, en-US -> 1.00", () => {
    expect(formatTokenAmount("1000000", 6, "en-US")).toBe("1.00");
  });

  it("keeps at least two fraction digits and up to `decimals`, without dropping precision", () => {
    expect(formatTokenAmount("1500000", 6, "en-US")).toBe("1.50");
    expect(formatTokenAmount("1234567", 6, "en-US")).toBe("1.234567");
    expect(formatTokenAmount("1", 6, "en-US")).toBe("0.000001");
    expect(formatTokenAmount("0", 6, "en-US")).toBe("0.00");
  });

  it("caps the minimum fraction digits at `decimals` for small decimals", () => {
    expect(formatTokenAmount("5", 1, "en-US")).toBe("0.5");
    expect(formatTokenAmount("12345", 0, "en-US")).toBe("12,345");
  });

  it("groups thousands", () => {
    expect(formatTokenAmount("1234567890000", 6, "en-US")).toBe("1,234,567.89");
  });

  it("is exact beyond 2^53 (no float rounding)", () => {
    // 2^53 + 1 is not representable as a JS number.
    expect(formatTokenAmount("9007199254740993", 0, "en-US")).toBe("9,007,199,254,740,993");
    // The fraction is 345678901234567890; the trailing zero is trimmed (only
    // the first two fraction digits are kept when zero), every other digit is exact.
    expect(formatTokenAmount("123456789012345678901234567890", 18, "en-US")).toBe(
      "123,456,789,012.34567890123456789",
    );
    // i128::MAX
    expect(formatTokenAmount("170141183460469231731687303715884105727", 18, "en-US")).toBe(
      "170,141,183,460,469,231,731.687303715884105727",
    );
  });

  it("handles negative amounts and never renders negative zero", () => {
    expect(formatTokenAmount("-1500000", 6, "en-US")).toBe("-1.50");
    expect(formatTokenAmount("-0", 6, "en-US")).toBe("0.00");
  });

  it("tolerates leading zeros in the amount", () => {
    expect(formatTokenAmount("0001000000", 6, "en-US")).toBe("1.00");
  });

  it("follows the requested locale", () => {
    expect(formatTokenAmount("1234567890000", 6, "de-DE")).toBe("1.234.567,89");
    expect(formatTokenAmount("1234567890000", 6, "fr-FR")).toMatch(/^1\s234\s567,89$/u);
  });

  it("throws RangeError for an invalid locale tag", () => {
    expect(() => formatTokenAmount("1000000", 6, "not a locale")).toThrow(RangeError);
  });
});

describe("POST /api/v1/utils/format-amount (#1132)", () => {
  it("returns { formatted } for the acceptance-criteria example", async () => {
    const res = await post({ amount: "1000000", decimals: 6, locale: "en-US" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ formatted: "1.00" });
  });

  it("defaults the locale to en-US when omitted", async () => {
    const res = await post({ amount: "1234567890000", decimals: 6 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ formatted: "1,234,567.89" });
  });

  it("uses the requested locale", async () => {
    const res = await post({ amount: "1234567890000", decimals: 6, locale: "de-DE" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ formatted: "1.234.567,89" });
  });

  it.each([
    ["negative decimals", { amount: "1000000", decimals: -1 }],
    ["non-integer decimals", { amount: "1000000", decimals: 1.5 }],
    ["decimals as a string", { amount: "1000000", decimals: "6" }],
    ["decimals above the maximum", { amount: "1000000", decimals: MAX_DECIMALS + 1 }],
    ["missing decimals", { amount: "1000000" }],
  ])("returns 422 for %s", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("ValidationError");
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it.each([
    ["a decimal amount", { amount: "1.5", decimals: 6 }],
    ["a non-numeric amount", { amount: "abc", decimals: 6 }],
    ["an empty amount", { amount: "", decimals: 6 }],
    ["a numeric (non-string) amount", { amount: 1000000, decimals: 6 }],
    ["an overlong amount", { amount: "1".repeat(MAX_AMOUNT_LENGTH + 1), decimals: 6 }],
    ["a missing amount", { decimals: 6 }],
  ])("returns 422 for %s", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("ValidationError");
  });

  it("returns 422 for an invalid locale, naming the field", async () => {
    const res = await post({ amount: "1000000", decimals: 6, locale: "not a locale" });
    expect(res.status).toBe(422);
    expect(res.body.issues[0].path).toEqual(["locale"]);
  });

  it("returns 422 for an empty locale", async () => {
    const res = await post({ amount: "1000000", decimals: 6, locale: "" });
    expect(res.status).toBe(422);
  });

  it("accepts the boundary values decimals: 0 and decimals: MAX_DECIMALS", async () => {
    const zero = await post({ amount: "42", decimals: 0 });
    expect(zero.status).toBe(200);
    expect(zero.body).toEqual({ formatted: "42" });

    const max = await post({ amount: "1", decimals: MAX_DECIMALS });
    expect(max.status).toBe(200);
    expect(max.body.formatted).toBe(`0.${"0".repeat(MAX_DECIMALS - 1)}1`);
  });
});
