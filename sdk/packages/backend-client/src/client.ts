/**
 * Typed client for the StellarYield backend API (Issue #866).
 *
 * Built on `openapi-fetch` over the types generated from
 * `backend/api/openapi.json`, so paths, parameters and response bodies are
 * all checked at compile time:
 *
 *   const client = createBackendClient("https://api.stellaryield.io");
 *   const { data, error } = await client.GET("/api/v1/vaults/{contractId}", {
 *     params: { path: { contractId: "CAUZ…" } },
 *   });
 *
 * Passing a path that is not in the spec, or omitting a required parameter, is
 * a compile error rather than a runtime 404.
 */

import createClient from "openapi-fetch";
import type { paths } from "./generated/api-types.js";

export type BackendPaths = paths;

/** Options accepted by {@link createBackendClient}. */
export interface BackendClientOptions {
  /** Sent with every request, e.g. an API key for authenticated routes. */
  headers?: Record<string, string>;
  /** Custom fetch, e.g. to add instrumentation or a timeout. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Creates a typed client for the backend API.
 *
 * A trailing slash on `baseUrl` is stripped so it never produces a `//` in the
 * request path.
 */
export function createBackendClient(
  baseUrl: string,
  options: BackendClientOptions = {},
) {
  return createClient<paths>({
    baseUrl: baseUrl.replace(/\/+$/, ""),
    headers: options.headers,
    fetch: options.fetch,
  });
}

export type BackendClient = ReturnType<typeof createBackendClient>;
