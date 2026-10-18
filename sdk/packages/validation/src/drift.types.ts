/**
 * Guards the Zod schemas against drift from the backend's own types
 * (Issue #867).
 *
 * The schemas are hand-written, so the risk is not that they are wrong today
 * but that a field gets added to `backend/src/types/index.ts`, the API starts
 * sending it, and the schema quietly keeps stripping it. Zod drops unknown
 * keys, so that failure is invisible at runtime: the response validates and
 * the new field disappears.
 *
 * Mutual assignability catches it. Each schema's inferred type has to accept
 * every value of the corresponding backend interface and vice versa, so a
 * field present on one side and not the other is a type error rather than a
 * silent omission.
 *
 * This file is checked by `npm run typecheck`, not by `vitest`, because the
 * assertions are about types and there is nothing to execute.
 */

import type {
  Epoch,
  PaginatedResponse,
  User,
  UserPortfolioResponse,
  UserVaultPosition,
  Vault,
} from "../../../../backend/src/types/index.js";
import type {
  Epoch as EpochFromSchema,
  Position as PositionFromSchema,
  User as UserFromSchema,
  UserPortfolio as UserPortfolioFromSchema,
  Vault as VaultFromSchema,
  VaultList as VaultListFromSchema,
} from "./index.js";

/**
 * The shape a value takes on the wire, which is what a response validator sees.
 *
 * The backend interfaces are written in-process and hold `Date` values, but
 * `JSON.stringify` turns those into ISO-8601 strings before they leave the
 * process. Comparing a schema against the raw interface would therefore always
 * fail on the date fields and prove nothing, so the interface is projected
 * through this first: `Date` becomes `string`, recursively, and everything
 * else -- field names, optionality, nullability, scalar types -- is preserved.
 */
type Jsonify<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Jsonify<U>[]
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

/** Resolves to `true` only when `A` and `B` are mutually assignable. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Resolves to `true` only when `A` and `B` declare exactly the same keys.
 *
 * Assignability alone cannot catch a *missing optional* key: a type without
 * `nextCursor` is still assignable to a type that declares it optionally, so
 * dropping it from the schema would pass every other assertion here. Since a
 * client that loses the cursor cannot page, that key is checked directly.
 */
type SameKeys<A, B> = [Exclude<keyof A, keyof B>] extends [never]
  ? [Exclude<keyof B, keyof A>] extends [never]
    ? true
    : false
  : false;

/** Fails to compile unless `T` is exactly `true`. */
type Assert<T extends true> = T;

// Each alias is an assertion: drop a field from a schema, or add one to the
// backend interface without mirroring it here, and the line below stops being
// `true` and the package fails `npm run typecheck`.
//
// They are exported only so `noUnusedLocals` does not flag them; nothing
// imports them.

export type VaultDrift = Assert<MutuallyAssignable<VaultFromSchema, Jsonify<Vault>>>;
export type EpochDrift = Assert<MutuallyAssignable<EpochFromSchema, Jsonify<Epoch>>>;
export type UserDrift = Assert<MutuallyAssignable<UserFromSchema, Jsonify<User>>>;
export type PositionDrift = Assert<
  MutuallyAssignable<PositionFromSchema, Jsonify<UserVaultPosition>>
>;
export type PortfolioDrift = Assert<
  MutuallyAssignable<UserPortfolioFromSchema, Jsonify<UserPortfolioResponse>>
>;
export type VaultListDrift = Assert<
  MutuallyAssignable<VaultListFromSchema, Jsonify<PaginatedResponse<Vault>>>
>;

export type VaultKeysDrift = Assert<SameKeys<VaultFromSchema, Jsonify<Vault>>>;
export type EpochKeysDrift = Assert<SameKeys<EpochFromSchema, Jsonify<Epoch>>>;
export type UserKeysDrift = Assert<SameKeys<UserFromSchema, Jsonify<User>>>;
export type PositionKeysDrift = Assert<
  SameKeys<PositionFromSchema, Jsonify<UserVaultPosition>>
>;
export type PortfolioKeysDrift = Assert<
  SameKeys<UserPortfolioFromSchema, Jsonify<UserPortfolioResponse>>
>;
export type VaultListKeysDrift = Assert<
  SameKeys<VaultListFromSchema, Jsonify<PaginatedResponse<Vault>>>
>;

/**
 * `PaginatedResponse<Vault>` carries an optional `nextCursor`. The list schema
 * has to keep it: a client that loses the cursor cannot reach the next page,
 * and because the field is optional the drift would not surface as a type
 * error anywhere else.
 */
