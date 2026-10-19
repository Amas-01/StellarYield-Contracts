import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { config } from "../../config.js";
import { setRetryAfter } from "./retryAfter.js";

const WINDOW_MS = 60 * 1000;

/** `req.rateLimit` is set by express-rate-limit before the handler runs. */
type RateLimitedRequest = Request & { rateLimit?: { resetTime?: Date } };

/**
 * 429 body for an exhausted window. `Retry-After` counts down to the window
 * reset, so clients retry when a slot opens instead of immediately (#1253).
 */
function rateLimitedHandler(req: Request, res: Response): void {
  const resetTime = (req as RateLimitedRequest).rateLimit?.resetTime;
  const secondsUntilReset = resetTime ? (resetTime.getTime() - Date.now()) / 1000 : WINDOW_MS / 1000;
  setRetryAfter(res, secondsUntilReset);
  res.status(429).json({ error: "TooManyRequests", message: "Rate limit exceeded" });
}

export const publicLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: config.rateLimit.public,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitedHandler,
});

export const authLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: config.rateLimit.auth,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitedHandler,
});

export const simulateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: config.rateLimit.simulate,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitedHandler,
});

export function perKeyLimiter(overrideLimit: number) {
  return rateLimit({
    windowMs: WINDOW_MS,
    max: overrideLimit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => {
      return req.apiKey?.label ?? req.ip ?? "unknown";
    },
    handler: rateLimitedHandler,
  });
}
