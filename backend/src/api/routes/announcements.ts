import { Router } from "express";
import { listActiveAnnouncements } from "../controllers/announcements.js";

/**
 * Public announcements feed (#1288).
 *
 * Mounted at `/api/v1/announcements`. Only currently-active notices are
 * exposed; management lives under `/api/v1/admin/announcements`.
 */
export const announcementsRouter = Router();

announcementsRouter.get("/", listActiveAnnouncements);
