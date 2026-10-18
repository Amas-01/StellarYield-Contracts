/**
 * Express request augmentation.
 *
 * This lives apart from `types/index.ts` on purpose. That file is the data
 * contract the API serialises, and other packages need to import those
 * interfaces to check their own types against it (Issue #867). An Express
 * module augmentation in the same file makes the file unimportable from
 * outside the backend: TypeScript cannot resolve `express-serve-static-core`
 * from a package that does not depend on Express, and the import fails before
 * any of the data types are read.
 *
 * The backend's tsconfig includes everything under `src`, so this augmentation
 * is still applied everywhere inside the backend. `queryTimeoutMs` is set by
 * `api/middleware/queryTimeout.ts` and read by the vault and yield
 * controllers, so if this file stopped being picked up the backend would fail
 * to compile rather than silently lose the property.
 */

declare module "express-serve-static-core" {
  interface Request {
    /** Per-request query timeout in ms, set by `api/middleware/queryTimeout.ts`. */
    queryTimeoutMs?: number;
  }
}

export {};
