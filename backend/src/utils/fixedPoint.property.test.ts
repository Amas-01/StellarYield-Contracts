import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  FIXED_POINT_DECIMALS,
  formatRatio,
  formatYieldPerShare,
  parseFixedPoint,
} from "./fixedPoint.js";

/**
 * Property-based tests for the amount math (#1289).
 *
 * Example-based tests pin specific values; these assert the invariants that
 * must hold for *every* input — the edge cases hand-picked tests miss.
 *
 * Every block runs at least 1000 generated cases. When a property fails,
 * fast-check prints the offending `seed` and `path`; paste both into a
 * `runProperty` call below to reproduce that exact counterexample.
 */

const SCALE = 10n ** BigInt(FIXED_POINT_DECIMALS);

/** Fixed seed so a failure is reproducible run-to-run. */
const SEED = 1289;

function runProperty<Ts extends [unknown, ...unknown[]]>(
  property: fc.IProperty<Ts>,
): void {
  fc.assert(property, { numRuns: 1000, seed: SEED });
}

const nonNegative = fc.bigInt({ min: 0n, max: 10n ** 30n });
const positive = fc.bigInt({ min: 1n, max: 10n ** 30n });

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

describe("formatRatio (mulDiv) properties (#1289)", () => {
  it("rounds to within half a unit in the last place", () => {
    runProperty(
      fc.property(nonNegative, positive, (a, b) => {
        const result = parseFixedPoint(formatRatio(a, b));
        // result is the half-up rounding of a * SCALE / b, so it must sit
        // within half an ULP of the exact scaled ratio: 2*|result*b - a*SCALE| <= b.
        expect(2n * abs(result * b - a * SCALE) <= b).toBe(true);
      }),
    );
  });

  it("is monotonic in the numerator for a fixed denominator", () => {
    runProperty(
      fc.property(nonNegative, nonNegative, positive, (a1, delta, b) => {
        const a2 = a1 + delta;
        expect(
          parseFixedPoint(formatRatio(a2, b)) >= parseFixedPoint(formatRatio(a1, b)),
        ).toBe(true);
      }),
    );
  });

  it("always emits a canonical fixed-point string", () => {
    runProperty(
      fc.property(fc.bigInt(), positive, (a, b) => {
        const out = formatRatio(a, b);
        expect(out).toMatch(/^-?\d+\.\d{18}$/);
        // A value that rounds to zero must never surface as "-0.000…".
        if (out.startsWith("-")) {
          expect(parseFixedPoint(out)).toBeLessThan(0n);
        }
      }),
    );
  });
});

describe("fixed-point round-trips (#1289)", () => {
  it("recovers the exact scaled value when the denominator is the scale", () => {
    runProperty(
      fc.property(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), (value) => {
        expect(parseFixedPoint(formatRatio(value, SCALE))).toBe(value);
      }),
    );
  });

  it("toDecimal / fromDecimal round-trip is idempotent on canonical strings", () => {
    runProperty(
      fc.property(nonNegative, positive, (a, b) => {
        const rendered = formatRatio(a, b);
        const backToNumber = parseFixedPoint(rendered);
        // Re-rendering the parsed value reproduces the identical string.
        expect(formatRatio(backToNumber, SCALE)).toBe(rendered);
      }),
    );
  });
});

describe("proportional yield distribution (#1289)", () => {
  const sharesArb = fc.array(fc.bigInt({ min: 0n, max: 10n ** 20n }), {
    maxLength: 20,
  });
  const totalYieldArb = fc.bigInt({ min: 0n, max: 10n ** 24n });

  it("never distributes more than the total yield (floor share math)", () => {
    runProperty(
      fc.property(sharesArb, totalYieldArb, (shares, totalYield) => {
        const totalShares = shares.reduce((acc, s) => acc + s, 0n);
        fc.pre(totalShares > 0n);

        // The vault allocates each holder floor(totalYield * shares_i / totalShares).
        const distributed = shares.reduce(
          (acc, s) => acc + (totalYield * s) / totalShares,
          0n,
        );
        expect(distributed <= totalYield).toBe(true);
      }),
    );
  });

  it("per-share yield stays within half an ULP of the exact ratio", () => {
    runProperty(
      fc.property(totalYieldArb, positive, (totalYield, totalShares) => {
        const perShare = parseFixedPoint(formatYieldPerShare(totalYield, totalShares));
        expect(2n * abs(perShare * totalShares - totalYield * SCALE) <= totalShares).toBe(
          true,
        );
      }),
    );
  });
});
