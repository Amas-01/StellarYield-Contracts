import type { NextFunction, Request, Response } from "express";
import { config } from "../../config.js";

/**
 * Stale-if-error for public vault reads (#1254).
 *
 * Each successful anonymous 200 from a capture-enabled route is kept in memory,
 * keyed by its full URL. When the database is unreachable, the error handler
 * replays the last copy instead of failing. Authenticated responses are never
 * stored, because a key's vault scope can change what it sees.
 */

/** Matches the `max-age` the vault routes send, after which a copy is no longer fresh. */
const FRESH_MAX_AGE_SECONDS = 10;
/** Bounds memory: the oldest copy is dropped once this many URLs are held. */
const MAX_ENTRIES = 500;

interface StaleEntry {
  /** Serialized body, stored as text so later mutation of the response object cannot change it. */
  body: string;
  expiresAt: number;
}

const staleResponses = new Map<string, StaleEntry>();

export function rememberStaleResponse(key: string, body: string, now = Date.now()): void {
  if (config.staleTtlSeconds === 0) return;
  const ttlMs = (FRESH_MAX_AGE_SECONDS + config.staleTtlSeconds) * 1000;
  // Re-inserting moves the key to the end, so the Map's first key is always the oldest.
  staleResponses.delete(key);
  staleResponses.set(key, { body, expiresAt: now + ttlMs });
  while (staleResponses.size > MAX_ENTRIES) {
    const oldest = staleResponses.keys().next().value;
    if (oldest === undefined) break;
    staleResponses.delete(oldest);
  }
}

export function getStaleResponse(key: string, now = Date.now()): string | undefined {
  const entry = staleResponses.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    staleResponses.delete(key);
    return undefined;
  }
  return entry.body;
}

/**
 * Mount on a public GET route. Records the serialized body of each anonymous 200
 * so it can be replayed if the database goes away.
 */
export function captureForStaleFallback(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "GET") {
    next();
    return;
  }
  const sendJson = res.json.bind(res);
  res.json = ((body?: unknown) => {
    if (!req.apiKey && res.statusCode === 200) {
      const serialized = JSON.stringify(body);
      if (serialized !== undefined) rememberStaleResponse(req.originalUrl, serialized);
    }
    return sendJson(body);
  }) as Response["json"];
  next();
}

/**
 * Answer with the stored copy for this URL, marked `X-Cache: STALE` and
 * `Warning: 110` (RFC 7234). Returns false when there is nothing to serve, or
 * the request is authenticated, so the caller falls back to a 503.
 */
export function sendStaleResponse(req: Request, res: Response): boolean {
  if (req.method !== "GET" || req.apiKey) return false;
  const body = getStaleResponse(req.originalUrl);
  if (body === undefined) return false;
  res.status(200);
  res.set("Content-Type", "application/json; charset=utf-8");
  res.set("X-Cache", "STALE");
  res.set("Warning", '110 - "Response is Stale"');
  res.set("Cache-Control", "no-store");
  res.send(body);
  return true;
}

/** Test-only: clears the in-memory store between cases. */
export function resetStaleResponsesForTests(): void {
  staleResponses.clear();
}
