import type { Request, Response, NextFunction } from "express";
import { performance } from "node:perf_hooks";
import { ROUTE_SLA_MS } from "../../config.js";

function routePatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/:[^/]+/g, "[^/]+")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}/?$`);
}

const routeSlas = Object.entries(ROUTE_SLA_MS).map(([pattern, slaMs]) => ({
  matcher: routePatternToRegExp(pattern),
  slaMs,
}));

export function responseSla(req: Request, res: Response, next: NextFunction): void {
  const sla = routeSlas.find(({ matcher }) => matcher.test(req.path));
  if (!sla) {
    next();
    return;
  }

  const startedAt = performance.now();
  res.setHeader("X-SLA-Ms", String(sla.slaMs));
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = ((statusCode: number, ...args: any[]) => {
    if (performance.now() - startedAt > sla.slaMs) {
      res.setHeader("X-SLA-Exceeded", "true");
    }
    return originalWriteHead(statusCode, ...args);
  }) as typeof res.writeHead;
  next();
}