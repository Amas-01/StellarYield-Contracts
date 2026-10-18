import { query } from "../db/index.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

const INTERVAL_MS = 24 * 60 * 60 * 1000;

export class EventsPruner {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.runOnce().catch((err) => logger.error({ err }, "EventsPruner: initial run failed"));
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => logger.error({ err }, "EventsPruner: scheduled run failed"));
    }, INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runOnce(): Promise<void> {
    const retentionDays = config.eventsRetentionDays;

    // Issue #918: move expired events into indexed_events_archive instead of
    // permanently deleting them so they remain available for long-term audit.
    const archived = await query<{ count: string }>(
      `WITH moved AS (
         INSERT INTO indexed_events_archive (id, ledger, tx_hash, contract_id, event_type, payload, parsed_data, created_at)
         SELECT id, ledger, tx_hash, contract_id, event_type, payload, parsed_data, created_at
           FROM indexed_events
          WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
         ON CONFLICT (id) DO NOTHING
         RETURNING id
       ),
       deleted AS (
         DELETE FROM indexed_events
          WHERE id IN (SELECT id FROM moved)
         RETURNING id
       )
       SELECT COUNT(*)::text AS count FROM deleted`,
      [retentionDays],
    );
    const archivedCount = parseInt(archived[0]?.count ?? "0", 10);

    const sizeRows = await query<{ total_bytes: string }>(
      `SELECT pg_total_relation_size('indexed_events')::text AS total_bytes`,
    );
    const totalBytes = sizeRows[0]?.total_bytes ?? "0";

    logger.info({ archivedCount, totalBytes, retentionDays }, "EventsPruner: archival complete");
  }
}
