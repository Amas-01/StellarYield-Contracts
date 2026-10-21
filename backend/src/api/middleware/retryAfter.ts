import type { Response } from "express";

/** Seconds a client is told to wait before retrying a 503 we return (#1253). */
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

/**
 * Set `Retry-After` as a whole number of seconds, never less than 1, so clients
 * back off instead of retrying immediately (#1253).
 */
export function setRetryAfter(res: Response, seconds: number): void {
  res.set("Retry-After", String(Math.max(1, Math.ceil(seconds))));
}
