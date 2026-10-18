import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { query } from "../../db/index.js";

/**
 * Operator announcements (#1287, #1288).
 *
 * Short notices (planned maintenance, delayed epochs) that operators publish
 * and frontends display. Active notices are served publicly; creating and
 * deleting them requires an admin key.
 */

/** Severity values, most urgent first — also the public list ordering. */
export const ANNOUNCEMENT_SEVERITIES = ["critical", "warning", "info"] as const;
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];

/** Public cache lifetime for the active-announcements response (#1288). */
export const ANNOUNCEMENTS_CACHE_MAX_AGE_SECONDS = 60;

interface AnnouncementRow {
  id: number;
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  starts_at: Date | string;
  ends_at: Date | string;
  created_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapAnnouncement(row: AnnouncementRow) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    severity: row.severity,
    startsAt: toIso(row.starts_at),
    endsAt: toIso(row.ends_at),
    createdAt: toIso(row.created_at),
  };
}

const createAnnouncementSchema = z
  .object({
    title: z.string().trim().min(1, "title is required"),
    body: z.string().trim().min(1, "body is required"),
    severity: z.enum(ANNOUNCEMENT_SEVERITIES).default("info"),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
  })
  // The table stores snake_case columns; accept those spellings too so callers
  // can mirror the schema directly.
  .or(
    z.object({
      title: z.string().trim().min(1, "title is required"),
      body: z.string().trim().min(1, "body is required"),
      severity: z.enum(ANNOUNCEMENT_SEVERITIES).default("info"),
      starts_at: z.string().datetime({ offset: true }),
      ends_at: z.string().datetime({ offset: true }),
    }).transform((v) => ({
      title: v.title,
      body: v.body,
      severity: v.severity,
      startsAt: v.starts_at,
      endsAt: v.ends_at,
    })),
  );

/**
 * POST /api/v1/admin/announcements (#1287) — publish a notice.
 *
 * `endsAt` must be strictly after `startsAt`; a notice with an empty or
 * inverted window could never appear in the public feed, so it is rejected
 * with 400 rather than silently accepted.
 */
export async function createAnnouncement(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createAnnouncementSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "BadRequest",
        message: parsed.error.issues[0]?.message ?? "Invalid announcement payload",
      });
      return;
    }

    const { title, body, severity, startsAt, endsAt } = parsed.data;
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      res.status(400).json({
        error: "BadRequest",
        message: "endsAt must be after startsAt",
      });
      return;
    }

    const rows = await query<AnnouncementRow>(
      `INSERT INTO announcements (title, body, severity, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, body, severity, starts_at, ends_at, created_at`,
      [title, body, severity, startsAt, endsAt],
    );

    res.status(201).json(mapAnnouncement(rows[0]));
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/v1/admin/announcements/:id (#1287) — remove a notice.
 * A missing id is a client error (404), not a no-op.
 */
export async function deleteAnnouncement(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params["id"]);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "BadRequest", message: "Invalid announcement id" });
      return;
    }

    const rows = await query<{ id: number }>(
      "DELETE FROM announcements WHERE id = $1 RETURNING id",
      [id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: "NotFound", message: "Announcement not found" });
      return;
    }

    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/announcements (#1288) — notices currently in effect.
 *
 * Only announcements whose window contains "now" are returned
 * (`starts_at <= now < ends_at`), most severe first, then by start time. The
 * response is cacheable for 60 seconds.
 */
export async function listActiveAnnouncements(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const rows = await query<AnnouncementRow>(
      `SELECT id, title, body, severity, starts_at, ends_at, created_at
         FROM announcements
        WHERE starts_at <= NOW() AND ends_at > NOW()
        ORDER BY
          CASE severity
            WHEN 'critical' THEN 0
            WHEN 'warning'  THEN 1
            ELSE 2
          END ASC,
          starts_at ASC`,
    );

    res.set("Cache-Control", `public, max-age=${ANNOUNCEMENTS_CACHE_MAX_AGE_SECONDS}`);
    res.json(rows.map(mapAnnouncement));
  } catch (err) {
    next(err);
  }
}
