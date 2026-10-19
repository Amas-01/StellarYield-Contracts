import type { Request, Response, NextFunction } from "express";
import { config } from "../../config.js";

export function webhookHttpsEnforcement() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const isProduction = config.nodeEnv === "production";

    if (!isProduction) {
      next();
      return;
    }

    if (req.method !== "POST" && req.method !== "PUT") {
      next();
      return;
    }

    const body = req.body as any;
    if (!body || typeof body !== "object") {
      next();
      return;
    }

    const url = body.url;
    if (!url || typeof url !== "string") {
      next();
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      next();
      return;
    }

    if (parsed.protocol === "http:") {
      res.status(422).json({
        error: "UnprocessableEntity",
        message: "Webhook URLs must use HTTPS in production mode",
      });
      return;
    }

    next();
  };
}
