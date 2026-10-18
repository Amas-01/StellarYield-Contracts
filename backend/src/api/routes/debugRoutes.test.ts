import { describe, it, expect } from "vitest";
import express from "express";
import { listRoutes } from "./debugRoutes.js";

describe("listRoutes (#1137)", () => {
  it("lists direct and router-mounted routes with methods", () => {
    const app = express();
    const router = express.Router();
    router.get("/items", (_req, res) => res.end());
    router.post("/items", (_req, res) => res.end());
    app.use("/api/v1", router);
    app.get("/health", (_req, res) => res.end());

    const routes = listRoutes(app);
    expect(routes).toContainEqual({ method: "GET", path: "/health" });
    expect(routes).toContainEqual({ method: "GET", path: "/api/v1/items" });
    expect(routes).toContainEqual({ method: "POST", path: "/api/v1/items" });
  });
});
