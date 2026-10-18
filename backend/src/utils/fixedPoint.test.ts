import { describe, it, expect } from "vitest";
import {
  FIXED_POINT_DECIMALS,
  formatRatio,
  formatYieldPerShare,
  parseFixedPoint,
} from "./fixedPoint.js";

/** Build the exact 18-decimal string for a scaled BigInt, without using the code under test. */
function expected(scaled: bigint): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(19, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -18)}.${digits.slice(-18)}`;
}

describe("formatRatio", () => {
  it("defaults to 18 fractional digits", () => {
    expect(FIXED_POINT_DECIMALS).toBe(18);
    expect(formatRatio(1n, 1n)).toBe("1.000000000000000000");
  });

  it("always emits exactly 18 fractional digits, zero-padded", () => {
    // 1/1e18 scaled to 18 digits is 1e-18, which must not collapse to "0".
    expect(formatRatio(1n, 10n ** 18n)).toBe("0.000000000000000001");
    // A whole number keeps its full .000… tail.
    expect(formatRatio(10n ** 18n, 10n ** 18n)).toBe("1.000000000000000000");
  });

  it("keeps full precision far beyond Number.MAX_SAFE_INTEGER", () => {
    const numerator = 123456789012345678901234567890n;
    const denominator = 1000000007n;

    const result = formatRatio(numerator, denominator);

    // Recompute with the same exact integer arithmetic to pin the value down;
    // a float round-trip would lose digits here.
    const exact = (numerator * 10n ** 18n + denominator / 2n) / denominator;
    expect(result).toBe(expected(exact));
    expect(result).not.toBe(expect.stringContaining("e+"));
  });

  it("divides exactly when the ratio terminates within 18 digits", () => {
    expect(formatRatio(500n, 1000n)).toBe("0.500000000000000000");
    expect(formatRatio(1n, 4n)).toBe("0.250000000000000000");
    expect(formatRatio(1n, 8n)).toBe("0.125000000000000000");
  });

  it("rounds half-up rather than truncating", () => {
    // 0.5 ULP: truncating would give 0, half-up must give 1.
    expect(formatRatio(5n, 10n ** 19n)).toBe("0.000000000000000001");
    // 1.5 ULP: truncation gives 1, half-up gives 2.
    expect(formatRatio(15n, 10n ** 19n)).toBe("0.000000000000000002");
    // Just under half an ULP must still truncate down.
    expect(formatRatio(4n, 10n ** 19n)).toBe("0.000000000000000000");
    expect(formatRatio(14n, 10n ** 19n)).toBe("0.000000000000000001");
  });

  it("rounds half-up on the integer boundary, not just on the fraction", () => {
    // 1.9999999999999999995 -> 2.000000000000000000
    expect(formatRatio(2n * 10n ** 18n - 1n, 10n ** 18n)).toBe("1.999999999999999999");
    expect(formatRatio(3999999999999999999n, 2n * 10n ** 18n)).toBe("2.000000000000000000");
  });

  it("returns zero for a zero denominator instead of dividing by zero", () => {
    expect(formatRatio(1000n, 0n)).toBe("0.000000000000000000");
  });

  it("accepts numeric strings, including amounts beyond safe-integer range", () => {
    expect(formatRatio("1500000000000000000", "3000000000000000000")).toBe("0.500000000000000000");
    expect(formatRatio("170141183460469231731687303715884105727", "1")).toBe(
      "170141183460469231731687303715884105727.000000000000000000",
    );
  });

  it("preserves sign for a negative numerator and never emits negative zero", () => {
    expect(formatRatio(-1n, 2n)).toBe("-0.500000000000000000");
    expect(formatRatio(1n, -2n)).toBe("-0.500000000000000000");
    expect(formatRatio(-1n, -2n)).toBe("0.500000000000000000");
    expect(formatRatio(0n, 5n)).toBe("0.000000000000000000");
    // A tiny negative that rounds to zero must not come back as "-0.000…".
    expect(formatRatio(-1n, 10n ** 20n)).toBe("0.000000000000000000");
  });

  it("honours a custom decimal count", () => {
    expect(formatRatio(1n, 3n, 4)).toBe("0.3333");
    expect(formatRatio(2n, 3n, 4)).toBe("0.6667");
    expect(formatRatio(1n, 2n, 0)).toBe("1");
    expect(formatRatio(1n, 3n, 0)).toBe("0");
  });

  it("rejects a negative decimal count", () => {
    expect(() => formatRatio(1n, 1n, -1)).toThrow(RangeError);
  });
});

describe("formatYieldPerShare", () => {
  it("renders yield over shares at 18 decimals", () => {
    expect(formatYieldPerShare("1000000", "1000000")).toBe("1.000000000000000000");
  });

  it("handles a very small per-share yield without losing it to truncation", () => {
    // 1 stroop of yield across 1e7 shares: 1e-7 per share, which must not be
    // truncated away to zero at this precision.
    expect(formatYieldPerShare("1", "10000000")).toBe("0.000000100000000000");
    // 1 stroop across a very large share supply is the case the old formatter
    // truncated to zero.
    expect(formatYieldPerShare("1", "1000000000000")).toBe("0.000000000001000000");
  });

  it("matches the previous truncating formatter where the old one was exact", () => {
    // Regression guard: the shared helper replaced two copies of a formatter that
    // truncated. Where the old output was already exact, it must be unchanged.
    const cases: Array<[string, string]> = [
      ["1000000", "1000000"],
      ["250", "1000"],
      ["123456789", "1000000000"],
      ["0", "1"],
    ];
    for (const [yieldAmount, shares] of cases) {
      const old = (() => {
        const y = BigInt(yieldAmount);
        const s = BigInt(shares);
        if (s === 0n) return "0";
        const padded = ((y * 10n ** 18n) / s).toString().padStart(19, "0");
        return `${padded.slice(0, -18)}.${padded.slice(-18)}`;
      })();
      expect(formatYieldPerShare(yieldAmount, shares)).toBe(old);
    }
  });
});

describe("parseFixedPoint", () => {
  it("round-trips a formatted ratio", () => {
    const scaled = parseFixedPoint(formatYieldPerShare("1000000", "3000000"));
    expect(scaled).toBe(333333333333333333n);
  });

  it("parses integers, negatives and short fractions", () => {
    expect(parseFixedPoint("2")).toBe(2n * 10n ** 18n);
    expect(parseFixedPoint("-0.5")).toBe(-5n * 10n ** 17n);
    expect(parseFixedPoint("1.5")).toBe(15n * 10n ** 17n);
  });

  it("truncates digits beyond the requested precision", () => {
    expect(parseFixedPoint("1.0000000000000000009")).toBe(10n ** 18n);
  });

  it("round-trips zero", () => {
    expect(parseFixedPoint(formatRatio(1000n, 0n))).toBe(0n);
  });

  it("rejects malformed input", () => {
    expect(() => parseFixedPoint("abc")).toThrow(TypeError);
    expect(() => parseFixedPoint("1.2.3")).toThrow(TypeError);
    expect(() => parseFixedPoint("")).toThrow(TypeError);
  });
});
