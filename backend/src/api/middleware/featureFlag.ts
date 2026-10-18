import type { Request, Response, NextFunction } from "express";
import { isFlagEnabled } from "../../services/featureFlags.js";

/**
 * Express middleware that gates a route behind a named feature flag.
 * Returns 404 when the flag is disabled or the requester is not in the
 * rollout cohort (hash-based, keyed on IP address).
 *
 * Usage:
 *   router.get("/new-feature", requireFlag("my-feature"), handler)
 *
 * Closes #916
 */
export function requireFlag(flagName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Use the client IP as the stable request identifier for rollout bucketing.
    const requestId =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
      req.socket.remoteAddress ??
      "unknown";

    if (!isFlagEnabled(flagName, requestId)) {
      res.status(404).json({ error: "NotFound", message: "Feature not available" });
      return;
    }
    next();
  };
}
