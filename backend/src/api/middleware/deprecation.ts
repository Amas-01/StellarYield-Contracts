import type { Request, Response, NextFunction } from "express";

export interface DeprecationInfo {
  sunsetDate: string;
  successor: string;
}

/**
 * Express middleware that injects a `_deprecation` field into JSON response
 * bodies for deprecated routes.
 *
 * Usage:
 *   router.get("/old-path", deprecate({ sunsetDate: "2026-01-01", successor: "/api/v2/..." }), handler)
 *
 * Closes #915
 */
export function deprecate(info: DeprecationInfo) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    // Wrap res.json so every JSON response on this route includes _deprecation.
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        (body as Record<string, unknown>)["_deprecation"] = {
          sunsetDate: info.sunsetDate,
          successor: info.successor,
        };
      }
      return originalJson(body);
    };

    // Also set the standard Sunset and Deprecation headers as a courtesy.
    res.setHeader("Sunset", info.sunsetDate);
    res.setHeader("Deprecation", "true");

    next();
  };
}
