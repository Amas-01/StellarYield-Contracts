import type { Request, Response } from "express";
import { restoreFromArchive, getArchiveStatus } from "../../services/archivalService.js";
import { logger } from "../../logger.js";

// #921 — POST /api/v1/admin/archive/restore
// Moves matching rows from an archive table back to the live table.
// Protected by admin API key (enforced in the router).
export async function postArchiveRestore(req: Request, res: Response): Promise<void> {
  const { contractId, fromDate, toDate, table } = req.body as {
    contractId: string;
    fromDate: string;
    toDate: string;
    table: "indexed_events" | "vault_tvl_snapshots";
  };

  if (!contractId || !fromDate || !toDate || !table) {
    res.status(400).json({ error: "contractId, fromDate, toDate, and table are required" });
    return;
  }

  const allowedTables = ["indexed_events", "vault_tvl_snapshots"];
  if (!allowedTables.includes(table)) {
    res.status(400).json({ error: `table must be one of: ${allowedTables.join(", ")}` });
    return;
  }

  try {
    const adminUserId = (req as any).apiKey?.id ?? "unknown";
    const result = await restoreFromArchive({ contractId, fromDate, toDate, table }, adminUserId);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "Archive restore failed");
    res.status(500).json({ error: "Archive restore failed" });
  }
}

// #922 — GET /api/v1/admin/archive/status
// Returns live vs archive row counts for all archivable tables.
// Protected by admin API key (enforced in the router).
export async function getArchiveStatusHandler(req: Request, res: Response): Promise<void> {
  try {
    const status = await getArchiveStatus();
    res.json(status);
  } catch (err) {
    logger.error({ err }, "Failed to get archive status");
    res.status(500).json({ error: "Failed to get archive status" });
  }
}
