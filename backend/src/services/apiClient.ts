import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Outbound HTTP client for the StellarYield API.
 *
 * Three behaviours every caller would otherwise reimplement:
 *   - #871 automatic retry with exponential backoff for transient failures
 *   - #872 a per-client / per-request timeout so a hung socket cannot wedge a worker
 *   - #873 automatic `Authorization: Bearer` attachment from the configured key
 *
 * Defaults come from `config.apiClient` (see `API_CLIENT_*` in `.env.example`);
 * `createApiClient()` reads them, or pass explicit options to `new ApiClient()`.
 */

export type HttpMethod = "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE";

export type QueryValue = string | number | boolean | null | undefined;

/** Transport- or server-side conditions that are worth replaying. */
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Methods that are safe to replay — repeating them cannot change server state. */
const IDEMPOTENT_METHODS = new Set<HttpMethod>(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 5_000;
const DEFAULT_RETRY_JITTER = 0.2;

/** Base class so callers can catch every failure this client produces at once. */
export class ApiClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** The request exceeded its timeout budget and was aborted. */
export class ApiTimeoutError extends ApiClientError {
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "ApiTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** A non-2xx response. `body` is the raw response text, truncated for safety. */
export class ApiHttpError extends ApiClientError {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly body: string;
  readonly attempts: number;

  constructor(url: string, status: number, statusText: string, body: string, attempts: number) {
    super(`Request to ${url} failed with ${status} ${statusText}`.trimEnd());
    this.name = "ApiHttpError";
    this.status = status;
    this.statusText = statusText;
    this.url = url;
    this.body = body;
    this.attempts = attempts;
  }
}

export interface ApiClientOptions {
  /** Absolute base URL, e.g. `https://api.stellaryield.xyz`. */
  baseUrl: string;
  /** Bearer token sent on every request. `null`/empty disables authentication. */
  apiKey?: string | null;
  /** Per-request timeout in ms. `0` disables the timeout entirely. */
  timeoutMs?: number;
  /** Retries after the initial attempt, for idempotent methods. */
  maxRetries?: number;
  /** First backoff delay; doubles per attempt. */
  retryBaseDelayMs?: number;
  /** Ceiling for a single backoff delay (also caps an honoured `Retry-After`). */
  retryMaxDelayMs?: number;
  /** Fraction of the delay randomised, to avoid synchronised retry storms. */
  retryJitter?: number;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Injection point for tests. */
  fetchImpl?: typeof fetch;
  /** Injection point for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ApiRequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, QueryValue>;
  /** Overrides the client timeout for this call. `0` disables it. */
  timeoutMs?: number;
  /** Overrides the retry budget for this call. */
  maxRetries?: number;
  /** Force retries on/off for this call. Defaults to "only idempotent methods". */
  retry?: boolean;
  /** Overrides the client key; `null` sends the request unauthenticated. */
  apiKey?: string | null;
  /** Caller cancellation — aborts the request and suppresses retries. */
  signal?: AbortSignal;
}

const MAX_ERROR_BODY_CHARS = 2_000;

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

/**
 * `fetch` reports connection resets, DNS failures and unreachable peers as
 * `TypeError`. Anything else (a bug in this module, an `AbortError` from the
 * caller's own signal) must not be silently replayed.
 */
function isRetryableNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

/** `Retry-After` is either delta-seconds or an HTTP date. Returns ms or null. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;

  const trimmed = header.trim();
  if (trimmed !== "") {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_BODY_CHARS ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}…` : text;
}

async function readBody(response: Response): Promise<string> {
  try {
    return truncate(await response.text());
  } catch {
    return "";
  }
}

/** Resolve the response payload, tolerating 204 and empty bodies. */
async function parseJsonBody<T>(response: Response, url: string): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (text.trim() === "") return undefined as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiClientError(`Response from ${url} was not valid JSON`);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryJitter: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ApiClientOptions) {
    // Fail fast on a misconfigured base URL rather than on the first request.
    const base = new URL(options.baseUrl);

    this.baseUrl = base.toString().replace(/\/+$/, "");
    this.apiKey = options.apiKey ? options.apiKey : null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.retryJitter = options.retryJitter ?? DEFAULT_RETRY_JITTER;
    this.defaultHeaders = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
  }

  get<T>(path: string, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  post<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }

  put<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body });
  }

  patch<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, { ...options, body });
  }

  delete<T>(path: string, options?: ApiRequestOptions): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  /**
   * Perform a request, retrying transient failures with exponential backoff
   * (#871) under a hard timeout (#872), authenticating with the configured
   * API key when one is set (#873).
   *
   * Resolves with the decoded JSON body; rejects with {@link ApiHttpError},
   * {@link ApiTimeoutError} or {@link ApiClientError}.
   */
  async request<T>(method: HttpMethod, path: string, options: ApiRequestOptions = {}): Promise<T> {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("Request aborted by caller");
    }

    const url = this.buildUrl(path, options.query);
    const init = this.buildInit(method, options);
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const retryAllowed = options.retry ?? IDEMPOTENT_METHODS.has(method);
    const retryBudget = Math.max(0, options.maxRetries ?? (retryAllowed ? this.maxRetries : 0));

    let attempt = 0;
    for (;;) {
      attempt += 1;

      let response: Response;
      try {
        response = await this.send(url, init, timeoutMs, options.signal);
      } catch (err) {
        // A caller-cancelled request is a decision, not a transient failure.
        if (options.signal?.aborted) throw err;
        if (!(err instanceof ApiTimeoutError) && !isRetryableNetworkError(err)) throw err;
        if (attempt > retryBudget) throw err;
        await this.waitBeforeRetry(attempt, url, method, err, null);
        continue;
      }

      if (response.ok) return parseJsonBody<T>(response, url);

      const error = new ApiHttpError(
        url,
        response.status,
        response.statusText,
        await readBody(response),
        attempt,
      );
      if (!isRetryableStatus(response.status) || attempt > retryBudget) throw error;
      await this.waitBeforeRetry(
        attempt,
        url,
        method,
        error,
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const suffix = path === "" || path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${suffix}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private buildInit(method: HttpMethod, options: ApiRequestOptions): RequestInit {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.defaultHeaders,
      ...options.headers,
    };

    // #873 — attach the key unless the caller opted out or set the header
    // themselves, so a per-request token always wins over the client default.
    const apiKey = options.apiKey === undefined ? this.apiKey : options.apiKey;
    if (apiKey && !hasHeader(headers, "authorization")) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    let body: string | undefined;
    if (options.body !== undefined && options.body !== null) {
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      if (!hasHeader(headers, "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }

    return { method, headers, body };
  }

  /** One fetch attempt under the timeout budget (#872). */
  private async send(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (timeoutMs <= 0) {
      return this.fetchImpl(url, { ...init, signal });
    }

    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });

    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (timedOut) throw new ApiTimeoutError(url, timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  /** `base * 2^(attempt-1)`, capped, then jittered by ±`retryJitter`. */
  private backoffDelay(attempt: number): number {
    const capped = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * 2 ** (attempt - 1));
    if (this.retryJitter <= 0) return capped;

    const spread = capped * this.retryJitter;
    return Math.round(capped - spread + Math.random() * spread * 2);
  }

  private async waitBeforeRetry(
    attempt: number,
    url: string,
    method: HttpMethod,
    err: unknown,
    retryAfterMs: number | null,
  ): Promise<void> {
    // A server-supplied `Retry-After` is authoritative, but never trusted past
    // the configured ceiling — a bad header must not park a worker for an hour.
    const delayMs =
      retryAfterMs === null
        ? this.backoffDelay(attempt)
        : Math.min(retryAfterMs, this.retryMaxDelayMs);

    logger.warn(
      { url, method, attempt, delayMs, reason: err instanceof Error ? err.message : String(err) },
      "API request failed; retrying with backoff",
    );
    await this.sleep(delayMs);
  }
}

/** Build a client from `config.apiClient` (the `API_CLIENT_*` env vars). */
export function createApiClient(overrides: Partial<ApiClientOptions> = {}): ApiClient {
  return new ApiClient({
    baseUrl: config.apiClient.baseUrl,
    apiKey: config.apiClient.apiKey,
    timeoutMs: config.apiClient.timeoutMs,
    maxRetries: config.apiClient.maxRetries,
    ...overrides,
  });
}
