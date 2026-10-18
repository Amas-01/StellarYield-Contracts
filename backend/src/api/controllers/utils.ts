import type { Request, Response, NextFunction } from "express";
import { z } from "zod";

/** Locale used when the caller does not supply one. Fixed, not the server's own locale, so output never depends on where the API happens to run. */
export const DEFAULT_LOCALE = "en-US";

/**
 * Upper bound on `decimals`. Soroban token amounts are i128 (at most 39
 * decimal digits), so 38 covers every real token; the bound also stops a
 * caller from making the server build an enormous fraction string.
 */
export const MAX_DECIMALS = 38;

/** Upper bound on the length of `amount` (sign and digits), for the same reason. */
export const MAX_AMOUNT_LENGTH = 100;

export const formatAmountSchema = z.object({
  amount: z
    .string()
    .max(MAX_AMOUNT_LENGTH, `amount must be at most ${MAX_AMOUNT_LENGTH} characters`)
    .regex(/^-?\d+$/, "amount must be an integer string of digits, optionally negative"),
  decimals: z
    .number({ invalid_type_error: "decimals must be a number" })
    .int("decimals must be an integer")
    .min(0, "decimals must not be negative")
    .max(MAX_DECIMALS, `decimals must be at most ${MAX_DECIMALS}`),
  locale: z.string().min(1, "locale must not be empty").optional(),
});

export type FormatAmountBody = z.infer<typeof formatAmountSchema>;

/**
 * Format a token amount held as an arbitrary-precision integer for display.
 *
 * The value `amount / 10^decimals` is computed exactly with BigInt and string
 * arithmetic — never through a JS number — so amounts beyond 2^53 keep every
 * digit. The resulting decimal string is handed to `Intl.NumberFormat`, which
 * formats decimal strings exactly.
 *
 * Fraction digits: at least two (or `decimals` if that is smaller) so
 * `1000000` at 6 decimals reads `1.00`, and at most `decimals` so no
 * precision is dropped.
 *
 * @throws {RangeError} when `locale` is not a valid BCP 47 language tag.
 */
export function formatTokenAmount(
  amount: string,
  decimals: number,
  locale: string = DEFAULT_LOCALE,
): string {
  const value = BigInt(amount);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");

  const integerPart = digits.slice(0, digits.length - decimals);
  const fractionPart = decimals > 0 ? digits.slice(digits.length - decimals) : "";
  const decimalString = `${negative ? "-" : ""}${integerPart}${decimals > 0 ? `.${fractionPart}` : ""}`;

  if (decimals <= 20) {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: Math.min(2, decimals),
      maximumFractionDigits: decimals,
      useGrouping: true,
    }).format(decimalString as unknown as number);
  }

  const nf = new Intl.NumberFormat(locale, { useGrouping: true });
  const decimalSeparator = nf.formatToParts(1.1).find((p) => p.type === "decimal")?.value ?? ".";
  const intFormatted = nf.format(BigInt(integerPart));
  const sign = negative && !intFormatted.startsWith("-") ? "-" : "";
  return `${sign}${intFormatted}${decimalSeparator}${fractionPart}`;
}

/**
 * POST /api/v1/utils/format-amount — locale-aware display formatting for
 * token amounts (#1132).
 *
 * Any invalid input — a negative or non-integer `decimals`, a malformed
 * `amount`, or an unknown `locale` — is a 422 with the offending issues.
 */
export function formatAmount(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = formatAmountSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({ error: "ValidationError", issues: parsed.error.issues });
      return;
    }

    const { amount, decimals, locale } = parsed.data;

    let formatted: string;
    try {
      formatted = formatTokenAmount(amount, decimals, locale);
    } catch (err) {
      if (err instanceof RangeError) {
        res.status(422).json({
          error: "ValidationError",
          issues: [{ path: ["locale"], message: `"${locale}" is not a valid locale` }],
        });
        return;
      }
      throw err;
    }

    res.json({ formatted });
  } catch (err) {
    next(err);
  }
}
