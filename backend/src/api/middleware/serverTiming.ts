import type { Request, Response, NextFunction } from "express";

/** A named phase of request handling, in milliseconds. */
export interface TimingMark {
  name: string;
  durationMs: number;
}

declare module "express-serve-static-core" {
  interface Request {
    /** Record a named phase; it appears in the Server-Timing header. */
    timing?: {
      mark: (name: string, durationMs: number) => void;
    };
  }
}

const TOKEN_RE = /[^A-Za-z0-9_-]/g;

/** Format marks as a Server-Timing header value (`name;dur=1.23, ...`). */
export function formatServerTiming(marks: TimingMark[]): string {
  return marks
    .map((m) => `${m.name.replace(TOKEN_RE, "_")};dur=${m.durationMs.toFixed(2)}`)
    .join(", ");
}

/**
 * Adds a `Server-Timing` response header with the total handling time plus any
 * phases handlers recorded via `req.timing.mark(name, ms)`, so the browser
 * devtools network waterfall shows where server time went.
 */
export function serverTiming(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  const marks: TimingMark[] = [];

  req.timing = {
    mark: (name, durationMs) => {
      marks.push({ name, durationMs });
    },
  };

  const originalWriteHead = res.writeHead;
  res.writeHead = function patchedWriteHead(this: Response, ...args: unknown[]) {
    if (!this.headersSent) {
      const totalMs = Number(process.hrtime.bigint() - start) / 1e6;
      this.setHeader(
        "Server-Timing",
        formatServerTiming([...marks, { name: "total", durationMs: totalMs }]),
      );
    }
    return (originalWriteHead as (...a: unknown[]) => Response).apply(this, args);
  } as typeof res.writeHead;

  next();
}
