/**
 * Fixed-point helpers for on-chain token amounts.
 *
 * Token amounts are base-unit integers that routinely exceed
 * `Number.MAX_SAFE_INTEGER`, so every ratio is computed with `BigInt` and
 * returned as a decimal string — never as a JS number, which would silently
 * lose precision. Ratios are scaled to {@link FIXED_POINT_DECIMALS} fractional
 * digits, matching the 7-decimal asset convention used on-chain while keeping
 * enough headroom for share ratios that divide by a very large supply.
 */

/** Fractional digits every fixed-point ratio is quantized to. */
export const FIXED_POINT_DECIMALS = 18;

const POW10_CACHE = new Map<number, bigint>();

function pow10(exponent: number): bigint {
  let cached = POW10_CACHE.get(exponent);
  if (cached === undefined) {
    cached = 10n ** BigInt(exponent);
    POW10_CACHE.set(exponent, cached);
  }
  return cached;
}

/**
 * Render an already-scaled `BigInt` as a fixed-point decimal string with
 * exactly `decimals` fractional digits.
 *
 * The fractional part is zero-padded rather than trimmed, so every value has a
 * stable width and consumers can parse it positionally.
 */
function renderFixedPoint(scaled: bigint, decimals: number): string {
  const negative = scaled < 0n;
  const magnitude = (negative ? -scaled : scaled).toString();
  // `slice(0, -0)` would drop the whole string, so integer-only output is
  // handled before the fractional split.
  if (decimals === 0) return `${negative ? "-" : ""}${magnitude}`;

  const digits = magnitude.padStart(decimals + 1, "0");
  const integer = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals);
  return `${negative ? "-" : ""}${integer}.${fraction}`;
}

/**
 * Compute `numerator / denominator` as an exact fixed-point decimal string.
 *
 * The quotient is quantised half-up to `decimals` fractional digits: the
 * remainder beyond the last retained digit is compared against half of the
 * divisor, so ties round away from zero rather than being truncated. This is
 * the usual convention for DeFi ratios and keeps the result within one unit in
 * the last place of the exact value.
 *
 * A zero (or negative) denominator has no defined ratio, so `"0.000…"` is
 * returned rather than throwing — a vault with no shares outstanding is a
 * legitimate state, not a programming error.
 *
 * @param numerator - Value in base units (e.g. stroops).
 * @param denominator - Value in base units (e.g. shares).
 * @param decimals - Fractional digits to keep; defaults to 18.
 */
export function formatRatio(
  numerator: bigint | string,
  denominator: bigint | string,
  decimals: number = FIXED_POINT_DECIMALS,
): string {
  if (decimals < 0) {
    throw new RangeError(`decimals must be >= 0, received ${decimals}`);
  }

  const num = typeof numerator === "bigint" ? numerator : BigInt(numerator);
  const den = typeof denominator === "bigint" ? denominator : BigInt(denominator);

  if (den === 0n) return renderFixedPoint(0n, decimals);

  const scale = pow10(decimals);
  const negative = num < 0n !== den < 0n;
  const absNum = num < 0n ? -num : num;
  const absDen = den < 0n ? -den : den;

  // Scale before dividing so the quotient is already in fixed-point units.
  const scaledNumerator = absNum * scale;
  const quotient = scaledNumerator / absDen;
  const remainder = scaledNumerator % absDen;

  // Round half-up: bump the quotient when the dropped remainder is at least
  // half the divisor, which is exact because both are BigInts.
  const rounded = remainder * 2n >= absDen ? quotient + 1n : quotient;

  return renderFixedPoint(negative ? -rounded : rounded, decimals);
}

/**
 * Yield attributable to a single share, i.e. `yieldAmount / totalShares`,
 * rendered as an 18-decimal fixed-point string.
 */
export function formatYieldPerShare(
  yieldAmount: bigint | string,
  totalShares: bigint | string,
): string {
  return formatRatio(yieldAmount, totalShares, FIXED_POINT_DECIMALS);
}

/**
 * Parse a fixed-point decimal string back into base units.
 *
 * Inverse of {@link formatRatio} for values it produced, up to the rounding
 * step: digits past `decimals` are dropped and missing digits are zero-padded,
 * so the result is the value truncated to that precision.
 */
export function parseFixedPoint(value: string, decimals: number = FIXED_POINT_DECIMALS): bigint {
  if (decimals < 0) {
    throw new RangeError(`decimals must be >= 0, received ${decimals}`);
  }

  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) {
    throw new TypeError(`Not a fixed-point decimal string: ${value}`);
  }

  const [, sign, integer, fraction = ""] = match;
  const scaled = BigInt(integer + fraction.padEnd(decimals, "0").slice(0, decimals));
  return sign === "-" ? -scaled : scaled;
}
