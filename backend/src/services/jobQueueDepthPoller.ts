import { query } from "../db/index.js";
import { logger } from "../logger.js";
import { setJobQueueDepth, type JobQueueDepth } from "./metrics.js";

// Queue depth is sampled on a fixed interval rather than on scrape: a
// `pgboss.job` count is a full scan of the queue table, and running it once per
// Prometheus scrape would put load on the database proportional to the scrape
// interval. 30s is frequent enough to notice a backlog building and cheap
// enough to be negligible (#1093).
export const JOB_QUEUE_DEPTH_POLL_INTERVAL_MS = 30_000;

function toCount(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Count the jobs sitting in each pg-boss state in a single pass. `retry` jobs
 * are deliberately left out: they are neither waiting to be picked up for the
 * first time nor currently being processed, and `pgboss_jobs_created` already
 * covers the backlog operators alert on.
 */
export async function fetchJobQueueDepth(): Promise<JobQueueDepth> {
  const rows = await query<{ created: string; active: string; failed: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE state = 'created')::text AS created,
       COUNT(*) FILTER (WHERE state = 'active')::text  AS active,
       COUNT(*) FILTER (WHERE state = 'failed')::text  AS failed
     FROM pgboss.job`,
  );

  const row = rows[0];
  return {
    created: toCount(row?.created),
    active: toCount(row?.active),
    failed: toCount(row?.failed),
  };
}

/**
 * Background poller that keeps the pg-boss queue depth gauges fresh (#1093).
 *
 * A spike in `pgboss_jobs_created` or `pgboss_jobs_active` means workers are not
 * keeping up; a non-zero `pgboss_jobs_failed` means jobs permanently failed
 * after exhausting their retries.
 */
export class JobQueueDepthPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;

  start(): void {
    this.runOnce().catch((err) => logger.error({ err }, "JobQueueDepthPoller: initial run failed"));
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => logger.error({ err }, "JobQueueDepthPoller: scheduled run failed"));
    }, JOB_QUEUE_DEPTH_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runOnce(): Promise<void> {
    // Skip a tick when the previous query is still in flight so a slow database
    // cannot stack up overlapping count queries.
    if (this.sampling) return;
    this.sampling = true;

    try {
      const depth = await fetchJobQueueDepth();
      setJobQueueDepth(depth);
      logger.debug(depth, "JobQueueDepthPoller: sampled pg-boss queue depth");
    } catch (err) {
      // Leave the previous sample in place: reporting a stale depth is more
      // useful than resetting the gauges to a value that was never measured.
      logger.error({ err }, "JobQueueDepthPoller: failed to sample pg-boss queue depth");
    } finally {
      this.sampling = false;
    }
  }
}
