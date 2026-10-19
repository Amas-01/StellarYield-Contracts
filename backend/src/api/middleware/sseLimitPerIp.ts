import type { Request, Response, NextFunction } from "express";
import { sseService } from "../../services/sse.js";
import { setRetryAfter } from "./retryAfter.js";

const SSE_MAX_CONNECTIONS_PER_IP = parseInt(process.env.SSE_MAX_CONNECTIONS_PER_IP ?? "5", 10);
/** Connections free up when streams close, not on a timer, so a one-minute back-off is the hint (#1253). */
const SSE_RETRY_AFTER_SECONDS = 60;

export function sseLimitPerIp() {
  return (_req: Request, res: Response, next: NextFunction) => {
    const isAuthenticated = Boolean((_req as any).apiKey);
    if (isAuthenticated) {
      next();
      return;
    }

    const ip = getClientIp(_req);
    const unauthenticatedCount = sseService.getUnauthenticatedClientsForIp(ip);

    if (unauthenticatedCount >= SSE_MAX_CONNECTIONS_PER_IP) {
      setRetryAfter(res, SSE_RETRY_AFTER_SECONDS);
      res.status(429).json({
        error: "TooManyRequests",
        message: `Too many SSE connections from this IP. Limit: ${SSE_MAX_CONNECTIONS_PER_IP}`,
      });
      return;
    }

    next();
  };
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]!.trim();
  }
  return req.ip ?? "unknown";
}
