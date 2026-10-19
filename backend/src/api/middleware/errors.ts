import type { ErrorRequestHandler, Request, Response } from "express";
import { logger } from "../../logger.js";
import { recordHttpError } from "../../services/metrics.js";
import { isDatabaseUnavailableError } from "../../db/unavailable.js";
import { sendStaleResponse } from "./staleResponse.js";
import { UNAVAILABLE_RETRY_AFTER_SECONDS, setRetryAfter } from "./retryAfter.js";

export enum ErrorCode {
  VAULT_NOT_FOUND = "VAULT_NOT_FOUND",
  USER_NOT_FOUND = "USER_NOT_FOUND",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  UNAUTHORIZED = "UNAUTHORIZED",
  RATE_LIMITED = "RATE_LIMITED",
  RPC_ERROR = "RPC_ERROR",
  INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR",
  NOT_FOUND = "NOT_FOUND",
  WEBHOOK_INVALID = "WEBHOOK_INVALID",
  QUERY_TIMEOUT = "QUERY_TIMEOUT",
  SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
}

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public statusCode: number = 500,
  ) {
    super(message);
    this.name = "AppError";
  }
}

function routeLabel(req: Request): string {
  return req.route?.path ?? req.path;
}

/**
 * The database is unreachable (#1254). A public vault read gets its last stored
 * copy, marked STALE. Anything else gets a 503 with `Retry-After` (#1253).
 */
function respondDatabaseUnavailable(err: unknown, req: Request, res: Response): void {
  (req.log ?? logger).warn({ err }, "Database unavailable");
  if (sendStaleResponse(req, res)) return;

  recordHttpError(routeLabel(req), 503);
  setRetryAfter(res, UNAVAILABLE_RETRY_AFTER_SECONDS);
  res.status(503).json({
    code: ErrorCode.SERVICE_UNAVAILABLE,
    error: "ServiceUnavailable",
    message: "Service temporarily unavailable, please retry shortly",
    statusCode: 503,
  });
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (isDatabaseUnavailableError(err)) {
    respondDatabaseUnavailable(err, req, res);
    return;
  }

  (req.log ?? logger).error(err, "Unhandled error");

  const statusCode = err instanceof AppError ? err.statusCode : (err.statusCode ?? 500);

  // Error-rate metric (#831) — 4xx and 5xx only, tagged with the route pattern.
  recordHttpError(routeLabel(req), statusCode);

  if (statusCode === 503) {
    setRetryAfter(res, UNAVAILABLE_RETRY_AFTER_SECONDS);
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
    });
    return;
  }

  res.status(err.statusCode ?? 500).json({
    code: ErrorCode.INTERNAL_SERVER_ERROR,
    error: err.name ?? "InternalServerError",
    message: err.message ?? "An unexpected error occurred",
    statusCode: err.statusCode ?? 500,
  });
};

/**
 * Terminal 404 handler (#831). Without this Express answers unmatched paths
 * with its own plain-text 404 that never reaches the error handler, so those
 * responses would be missing from http_errors_total.
 */
export const notFoundHandler: import("express").RequestHandler = (req, _res, next) => {
  next(new AppError(ErrorCode.NOT_FOUND, `Route ${req.method} ${req.path} not found`, 404));
};

