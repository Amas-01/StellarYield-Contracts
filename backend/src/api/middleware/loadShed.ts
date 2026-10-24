import type { NextFunction, Request, Response } from "express";
import { config } from "../../config.js";
import { getEventLoopLagSnapshot } from "../../services/eventLoopLag.js";

const RETRY_AFTER_SECONDS = "5";

/**
 * Routes that keep answering under overload (#1251): liveness, the metrics
 * scrape that shows the overload, and the admin API.
 */
const ESSENTIAL_PATHS = ["/health", "/api/v1/health", "/metrics", "/api/v1/admin"];

export function isEssentialPath(path: string): boolean {
  return ESSENTIAL_PATHS.some((essential) => path === essential || path.startsWith(`${essential}/`));
}

/**
 * Reject non-essential requests with a 503 while the event loop is saturated
 * (#1251). Accepting more work when the loop is already behind only makes
 * every request slower, so the server sheds load and recovers faster.
 *
 * Saturation is p99 event loop lag over the last sampling window. Above
 * `loadShedLagMs` the request is refused with `Retry-After: 5`.
 */
export function loadShedder(thresholdMs: number = config.loadShedLagMs) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isEssentialPath(req.path)) {
      next();
      return;
    }

    if (getEventLoopLagSnapshot().p99Ms <= thresholdMs) {
      next();
      return;
    }

    res.setHeader("Retry-After", RETRY_AFTER_SECONDS);
    res.status(503).json({ error: "ServiceUnavailable", message: "Server is overloaded, retry shortly" });
  };
}
