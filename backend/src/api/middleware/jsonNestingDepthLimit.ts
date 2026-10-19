import type { Request, Response, NextFunction } from "express";

const MAX_NESTING_DEPTH = 10;

function getJsonNestingDepth(obj: any): number {
  if (obj === null || typeof obj !== "object") {
    return 0;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return 1;
    return 1 + Math.max(...obj.map((item) => getJsonNestingDepth(item)));
  }

  const keys = Object.keys(obj);
  if (keys.length === 0) return 1;
  return 1 + Math.max(...keys.map((key) => getJsonNestingDepth(obj[key])));
}

export function jsonNestingDepthLimit(maxDepth: number = MAX_NESTING_DEPTH) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (
      req.method === "GET" ||
      req.method === "HEAD" ||
      req.method === "DELETE" ||
      !req.body
    ) {
      next();
      return;
    }

    const depth = getJsonNestingDepth(req.body);

    if (depth > maxDepth) {
      res.status(400).json({
        error: "RequestValidationError",
        message: `JSON nesting depth (${depth}) exceeds maximum allowed (${maxDepth})`,
      });
      return;
    }

    next();
  };
}
