import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { serverTiming, formatServerTiming } from "./serverTiming.js";

describe("formatServerTiming", () => {
  it("formats marks with two-decimal durations", () => {
    expect(
      formatServerTiming([
        { name: "db", durationMs: 12.345 },
        { name: "total", durationMs: 20 },
      ]),
    ).toBe("db;dur=12.35, total;dur=20.00");
  });

  it("sanitises metric names to valid tokens", () => {
    expect(formatServerTiming([{ name: "db query!", durationMs: 1 }])).toBe(
      "db_query_;dur=1.00",
    );
  });
});

describe("serverTiming middleware", () => {
  it("adds a Server-Timing header with a total metric", async () => {
    const app = express();
    app.use(serverTiming);
    app.get("/", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/");
    expect(res.headers["server-timing"]).toMatch(/^total;dur=\d+\.\d{2}$/);
  });

  it("includes phases recorded through req.timing.mark", async () => {
    const app = express();
    app.use(serverTiming);
    app.get("/", (req, res) => {
      req.timing?.mark("db", 5);
      res.json({ ok: true });
    });

    const res = await request(app).get("/");
    expect(res.headers["server-timing"]).toMatch(/^db;dur=5\.00, total;dur=/);
  });
});
