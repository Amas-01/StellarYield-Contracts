import { Router } from "express";
import changelog from "../../changelog.json" with { type: "json" };

export const changelogRouter = Router();

changelogRouter.get("/", (_req, res) => {
  res.json(changelog);
});