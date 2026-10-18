import type { PgBoss } from "pg-boss";
import { query } from "../db/index.js";
import { logger } from "../logger.js";
import { sseService } from "./sse.js";
import { validateWebhookUrl, CIRCUIT_BREAKER_THRESHOLD } from "./notifications.js";
import { isWebhookThrottled } from "./webhookThrottle.js";
import { buildSignatureHeaders } from "./webhookSignature.js";

export { CIRCUIT_BREAKER_THRESHOLD };

export interface WebhookRow {
  id: number;
  url: string;
  events: string[];
  secret: string | null;
  consecutive_failures: number;
  max_per_hour: number | null;
  circuit_open?: boolean;
  previous_secret?: string | null;
  secret_rotated_at?: Date | string | null;
}

export async function processWebhookDelivery(
  boss: PgBoss,
  webhookId: number,
  payload: string,
  deliveryId?: number,
): Promise<void> {
  const webhookRows = await query<WebhookRow>(
    "SELECT id, url, events, secret, consecutive_failures, max_per_hour, circuit_open, previous_secret, secret_rotated_at FROM webhooks WHERE id = $1",
    [webhookId],
  );
  if (webhookRows.length === 0) return;
  const webhook = webhookRows[0];

  // Circuit breaker (#1061): a persistently failing endpoint must stop
  // burning retry budget and queue capacity. Skipping here is not a failure.
  if (webhook.circuit_open) {
    logger.warn(
      { webhookId: webhook.id },
      "Skipping webhook delivery: circuit is open for this endpoint",
    );
    return;
  }

  // Per-event throttle (#1022): once a webhook has received max_per_hour
  // deliveries within the current clock hour, drop further events until the
  // hour rolls over. Not counted as a delivery failure.
  if (await isWebhookThrottled(webhook.id, webhook.max_per_hour)) {
    return;
  }

  try {
    await validateWebhookUrl(webhook.url);
  } catch (err) {
    logger.warn(
      { webhookId: webhook.id, url: webhook.url, err },
      "Webhook URL failed SSRF check; skipping",
    );
    await recordFailure(webhook, payload, boss, "SSRF check failed", deliveryId);
    return;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  Object.assign(headers, buildSignatureHeaders(webhook, payload));

  const start = Date.now();
  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(5000),
      redirect: "manual",
    });
    const durationMs = Date.now() - start;

    sseService.broadcastWebhookDelivery(webhook.id, {
      type: "delivery",
      attempt: 1,
      statusCode: response.status,
      durationMs,
      success: response.ok,
    });

    if (response.ok) {
      if ((webhook.consecutive_failures ?? 0) > 0) {
        await query("UPDATE webhooks SET consecutive_failures = 0 WHERE id = $1", [webhook.id]);
      }
      if (deliveryId != null) {
        await query(
          "UPDATE webhook_deliveries SET delivered_at = NOW(), status = 'delivered', last_error = NULL WHERE id = $1",
          [deliveryId],
        );
      }
      return;
    }

    await recordFailure(webhook, payload, boss, `non-2xx response: ${response.status}`, deliveryId);
  } catch (err) {
    const durationMs = Date.now() - start;
    sseService.broadcastWebhookDelivery(webhook.id, {
      type: "delivery",
      attempt: 1,
      statusCode: null,
      durationMs,
      success: false,
    });
    await recordFailure(webhook, payload, boss, String(err), deliveryId);
    throw err;
  }
}

async function recordFailure(
  webhook: WebhookRow,
  payload: string,
  boss: PgBoss,
  errorMessage: string,
  deliveryId?: number,
): Promise<void> {
  const newFailures = (webhook.consecutive_failures ?? 0) + 1;

  if (newFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    // Circuit breaker (#1061): suspend the endpoint. `active` is left alone so
    // a reset resumes deliveries without the operator re-enabling the webhook.
    await query(
      "UPDATE webhooks SET consecutive_failures = $1, circuit_open = TRUE, circuit_opened_at = COALESCE(circuit_opened_at, NOW()) WHERE id = $2",
      [newFailures, webhook.id],
    );
    logger.warn(
      { webhookId: webhook.id, consecutiveFailures: newFailures, threshold: CIRCUIT_BREAKER_THRESHOLD },
      "Webhook circuit opened after reaching consecutive failure threshold",
    );
  } else {
    await query(
      "UPDATE webhooks SET consecutive_failures = $1 WHERE id = $2",
      [newFailures, webhook.id],
    );
  }

  const permanent = newFailures >= CIRCUIT_BREAKER_THRESHOLD;

  if (deliveryId != null) {
    // Replayed/queued delivery already owns a log row: schedule its retry in
    // place instead of appending a duplicate entry (#1063).
    await query(
      `UPDATE webhook_deliveries
          SET attempt = attempt + 1,
              next_retry_at = NOW() + INTERVAL '5 seconds',
              last_error = $1,
              status = $2
        WHERE id = $3`,
      [errorMessage, permanent ? "failed_permanent" : "failed", deliveryId],
    );
  } else {
    await query(
      `INSERT INTO webhook_deliveries (webhook_id, payload, attempt, next_retry_at, last_error, status)
       VALUES ($1, $2, 1, NOW() + INTERVAL '5 seconds', $3, $4)`,
      [webhook.id, payload, errorMessage, permanent ? "failed_permanent" : "failed"],
    );
  }

  sseService.broadcastWebhookDelivery(webhook.id, {
    type: "delivery",
    attempt: 1,
    statusCode: null,
    durationMs: 0,
    success: false,
  });
}
