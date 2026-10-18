import type { NextFunction, Request, Response } from "express";
import { performance } from "node:perf_hooks";
import { query } from "../../db/index.js";
import { config } from "../../config.js";

function routePatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/:[^/]+/g, "[^/]+")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}/?$`);
}

const archiveMatchers = () => config.debugArchiveRoutes.map(routePatternToRegExp);

function serializableBody(body: unknown): unknown {
  if (body === undefined) return null;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  try {
    JSON.stringify(body);
    return body;
  } catch {
    return String(body);
  }
}

export function requestArchive(req: Request, res: Response, next: NextFunction): void {
  if (!archiveMatchers().some((matcher) => matcher.test(req.path))) {
    next();
    return;
  }

  const startedAt = performance.now();
  let responseBody: unknown;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  const originalEnd = res.end.bind(res);

  res.json = ((body: unknown) => {
    responseBody = body;
    return originalJson(body);
  }) as typeof res.json;
  res.send = ((body?: unknown) => {
    responseBody = body;
    return originalSend(body);
  }) as typeof res.send;
  res.end = ((body?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    if (body !== undefined) responseBody = body;
    return originalEnd(body as never, encoding as never, callback);
  }) as typeof res.end;

  res.on("finish", () => {
    void query(
      `WITH inserted AS (
         INSERT INTO request_archive
           (request_id, method, path, status, request_body, response_body, duration_ms, timestamp)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, NOW())
         RETURNING id
       )
       DELETE FROM request_archive
       WHERE id IN (
         SELECT id FROM request_archive
         ORDER BY timestamp DESC, id DESC
         OFFSET 1000
       )`,
      [
        req.requestId,
        req.method,
        req.path,
        res.statusCode,
        JSON.stringify(serializableBody(req.body)),
        JSON.stringify(serializableBody(responseBody)),
        Math.round((performance.now() - startedAt) * 100) / 100,
      ],
    ).catch(() => undefined);
  });
  next();
}