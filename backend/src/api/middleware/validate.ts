import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";
import { z } from "zod";
import { classifyAddress } from "../../utils/address.js";

// Stellar address validator: Valid account address (G...) checked via classifyAddress
export const stellarAddressSchema = z
  .string()
  .refine((val) => classifyAddress(val) === "account", {
    message: "Invalid Stellar address format",
  });

// Stellar contract address validator: Valid contract address (C...) checked via classifyAddress
export const contractAddressSchema = z
  .string()
  .refine((val) => classifyAddress(val) === "contract", {
    message: "Invalid Stellar contract address format",
  });

/**
 * Zod transform that normalises a free-text string to Unicode NFC (#1236).
 * Visually identical names in different compositions (e.g. é = e + combining
 * accent vs. precomposed é) are reduced to the same canonical form before
 * storage, so uniqueness checks and searches work correctly regardless of how
 * a client encoded the character.
 *
 * Usage: z.string().transform(nfcNormalize)
 *         or: nfcStringSchema
 */
export function nfcNormalize(value: string): string {
  return value.normalize("NFC");
}

/** A string field that is automatically NFC-normalised on parse (#1236). */
export const nfcStringSchema = z.string().transform(nfcNormalize);

/**
 * Maximum allowed span for a date-range query (in days, inclusive) (#1235).
 * Requests spanning more than this many days return HTTP 422.
 */
export const MAX_DATE_RANGE_DAYS = 366;

/**
 * Shared date-range schema for endpoints that accept `from` / `to` Unix
 * timestamps (seconds). Enforces:
 *   - `from <= to`
 *   - span ≤ MAX_DATE_RANGE_DAYS
 * (#1235)
 */
export const dateRangeSchema = z
  .object({
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
  })
  .superRefine((data, ctx) => {
    const { from, to } = data;
    if (from !== undefined && to !== undefined) {
      if (from > to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "`from` must not be after `to`",
          path: ["from"],
        });
        return;
      }
      const spanDays = (to - from) / 86_400;
      if (spanDays > MAX_DATE_RANGE_DAYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Date range must not exceed ${MAX_DATE_RANGE_DAYS} days (requested ${Math.ceil(spanDays)})`,
          path: ["to"],
        });
      }
    }
  });

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res
        .status(400)
        .json({ error: "ValidationError", issues: result.error.issues });
      return;
    }
    req.body = result.data;
    next();
  };
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Detect duplicate scalar query parameters (#1238).
    // Express parses `?limit=10&limit=500` as `{ limit: ["10", "500"] }`.
    // A schema that expects a scalar (non-array) type would silently use the
    // first value or fail with a confusing type error. Reject early instead.
    const duplicates: string[] = [];
    for (const [key, value] of Object.entries(req.query)) {
      if (Array.isArray(value)) {
        // Check whether the schema's shape declares this key as an array.
        // If the schema has no shape (e.g. z.record), skip the check.
        const shape = (schema as any)._def?.shape?.();
        const fieldDef = shape?.[key]?._def;
        // ZodArray inner type is stored under _def.type === "ZodArray".
        const isArrayType = fieldDef?.typeName === "ZodArray";
        if (!isArrayType) {
          duplicates.push(key);
        }
      }
    }
    if (duplicates.length > 0) {
      res.status(422).json({
        error: "DuplicateQueryParameter",
        message: `Scalar query parameter(s) must not appear more than once: ${duplicates.join(", ")}`,
        params: duplicates,
      });
      return;
    }

    const result = schema.safeParse(req.query);
    if (!result.success) {
      res
        .status(400)
        .json({ error: "ValidationError", issues: result.error.issues });
      return;
    }
    req.query = result.data;
    next();
  };
}

export function validateParams(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      res
        .status(400)
        .json({ error: "ValidationError", issues: result.error.issues });
      return;
    }
    req.params = result.data;
    next();
  };
}
