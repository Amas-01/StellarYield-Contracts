import type { Request, Response, NextFunction } from "express";
import { query } from "../../db/index.js";

export async function getRequestArchive(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const rows = await query<{
      request_id: string;
      method: string;
      path: string;
      status: number;
      request_body: unknown;
      response_body: unknown;
      duration_ms: number;
      timestamp: Date;
    }>(
      `SELECT request_id, method, path, status, request_body, response_body, duration_ms, timestamp
       FROM request_archive
       ORDER BY timestamp DESC, id DESC
       LIMIT 50`,
    );

    res.json(rows.map((row) => ({
      requestId: row.request_id,
      method: row.method,
      path: row.path,
      status: row.status,
      requestBody: row.request_body,
      responseBody: row.response_body,
      duration: row.duration_ms,
      timestamp: row.timestamp,
    })));
  } catch (err) {
    next(err);
  }
}