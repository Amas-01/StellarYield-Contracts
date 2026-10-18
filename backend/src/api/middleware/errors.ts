import type { ErrorRequestHandler, Request } from "express";
import { logger } from "../../logger.js";
import { recordHttpError } from "../../services/metrics.js";

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

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  (req.log ?? logger).error(err, "Unhandled error");

  const statusCode = err instanceof AppError ? err.statusCode : (err.statusCode ?? 500);

  // Error-rate metric (#831) — 4xx and 5xx only, tagged with the route pattern.
  recordHttpError(routeLabel(req), statusCode);

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

