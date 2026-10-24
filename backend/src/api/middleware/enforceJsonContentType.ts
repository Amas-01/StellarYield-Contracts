import type { Request, Response, NextFunction } from "express";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/**
 * Returns 415 Unsupported Media Type for POST/PUT/PATCH requests whose
 * Content-Type is not application/json (#1237).
 *
 * Requests without a body (GET, DELETE, HEAD, …) and requests that legitimately
 * carry no Content-Type (no body sent, content-length: 0) are passed through
 * unchanged so existing SSE, health and upload routes are not affected.
 */
export function enforceJsonContentType() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!BODY_METHODS.has(req.method)) {
      next();
      return;
    }

    // Skip if the request carries no body (no Content-Length / Transfer-Encoding).
    const hasBody =
      req.headers["content-length"] !== "0" &&
      (req.headers["content-length"] !== undefined ||
        req.headers["transfer-encoding"] !== undefined);

    if (!hasBody) {
      next();
      return;
    }

    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      res.status(415).json({
        error: "UnsupportedMediaType",
        message: "Content-Type must be application/json",
        accepted: ["application/json"],
      });
      return;
    }

    next();
  };
}
