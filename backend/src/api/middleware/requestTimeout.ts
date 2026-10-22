import type { NextFunction, Request, Response } from "express";
import { config } from "../../config.js";
import { logger } from "../../logger.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Aborted once the request exceeds REQUEST_TIMEOUT_MS (#1250). */
    signal?: AbortSignal;
  }
}

const RETRY_AFTER_SECONDS = "5";

/**
 * SSE streams are long-lived by design, so the timeout must not end them.
 * Every SSE route in this app is mounted at a path ending in `/stream`.
 */
export function isSseRequest(req: Pick<Request, "path">): boolean {
  return /\/stream\/?$/.test(req.path);
}

/**
 * Stop calls to the response after a timeout reply has been sent. A handler
 * that is still running may call res.json/res.set/etc. once the headers are
 * out, which throws ERR_HTTP_HEADERS_SENT. Inside an async handler that becomes
 * an unhandled rejection, and Node exits the process on those. Swallowing the
 * writes keeps a slow handler from taking the server down.
 */
function discardLaterWrites(res: Response): void {
  const discard = (): Response => res;
  Object.assign(res, {
    json: discard,
    send: discard,
    end: discard,
    write: discard,
    set: discard,
    setHeader: discard,
    header: discard,
    type: discard,
  });
}

/**
 * Bound how long any single request may run (#1250). When the limit passes
 * before the response starts, the client gets a 503 with `Retry-After: 5` and
 * `req.signal` is aborted so handlers that honour it can stop early. Once a
 * response has started, it is left alone: changing it mid-body would corrupt
 * the stream.
 */
export function requestTimeout(timeoutMs: number = config.requestTimeoutMs) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isSseRequest(req)) {
      next();
      return;
    }

    const controller = new AbortController();
    req.signal = controller.signal;

    const timer = setTimeout(() => {
      controller.abort(new Error(`Request exceeded ${timeoutMs} ms`));
      if (res.headersSent) return;

      (req.log ?? logger).warn({ method: req.method, path: req.path, timeoutMs }, "Request timed out");
      res.setHeader("Retry-After", RETRY_AFTER_SECONDS);
      res.status(503).json({ error: "ServiceUnavailable", message: "Request timed out" });
      discardLaterWrites(res);
    }, timeoutMs);

    const clear = (): void => clearTimeout(timer);
    res.once("finish", clear);
    res.once("close", clear);

    next();
  };
}
