import { Router } from "express";
import { formatAmount } from "../controllers/utils.js";

export const utilsRouter = Router();

/** POST /api/v1/utils/format-amount — locale-aware token amount formatting (#1132) */
utilsRouter.post("/format-amount", formatAmount);
