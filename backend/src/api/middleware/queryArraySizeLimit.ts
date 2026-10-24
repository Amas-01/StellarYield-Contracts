import type { Request, Response, NextFunction } from "express";

const DEFAULT_MAX_ARRAY_SIZE = 50;

interface QueryArrayLimitConfig {
  maxSize?: number;
  perRoute?: Record<string, number>;
}

export function queryArraySizeLimit(config: QueryArrayLimitConfig = {}) {
  const defaultMaxSize = config.maxSize ?? DEFAULT_MAX_ARRAY_SIZE;
  const perRouteConfig = config.perRoute ?? {};

  return (req: Request, res: Response, next: NextFunction): void => {
    const routeKey =
      req.baseUrl + (req.route?.path && req.route.path !== "/" ? req.route.path : "") ||
      req.path;
    const maxSize = perRouteConfig[routeKey] ?? defaultMaxSize;

    const query = req.query || {};

    for (const [paramName, paramValue] of Object.entries(query)) {
      if (Array.isArray(paramValue)) {
        if (paramValue.length > maxSize) {
          res.status(422).json({
            error: "UnprocessableEntity",
            message: `Query parameter '${paramName}' has ${paramValue.length} values, maximum allowed is ${maxSize}`,
            parameter: paramName,
            received: paramValue.length,
            maximum: maxSize,
          });
          return;
        }
      }
    }

    next();
  };
}
