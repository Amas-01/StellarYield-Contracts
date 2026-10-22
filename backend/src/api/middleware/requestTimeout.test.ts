import { describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";
import { requestTimeout, isSseRequest } from "./requestTimeout.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function buildApp(timeoutMs: number, lateWriteErrors: unknown[] = []) {
  const app = express();
  app.use(requestTimeout(timeoutMs));

  app.get("/fast", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/slow", async (_req, res) => {
    await sleep(200);
    // Runs after the 503 has gone out. It must not throw or crash the process.
    try {
      res.json({ ok: true });
    } catch (err) {
      lateWriteErrors.push(err);
    }
  });

  app.get("/events/stream", async (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    await sleep(200);
    res.end("data: hello\n\n");
  });

  return app;
}

describe("requestTimeout middleware (#1250)", () => {
  it("lets a request that finishes in time through unchanged", async () => {
    const res = await supertest(buildApp(50)).get("/fast");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("answers 503 with Retry-After: 5 when a handler runs past the limit", async () => {
    const res = await supertest(buildApp(50)).get("/slow");

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.body).toEqual({ error: "ServiceUnavailable", message: "Request timed out" });
  });

  it("does not throw when the slow handler writes after the 503", async () => {
    const lateWriteErrors: unknown[] = [];
    await supertest(buildApp(50, lateWriteErrors)).get("/slow");

    // Give the handler time to finish its late write.
    await sleep(250);
    expect(lateWriteErrors).toEqual([]);
  });

  it("aborts req.signal once the limit passes", async () => {
    const app = express();
    app.use(requestTimeout(50));
    let aborted: boolean | null = null;
    app.get("/watch", async (req, res) => {
      await sleep(200);
      aborted = req.signal?.aborted ?? null;
      res.end();
    });

    const res = await supertest(app).get("/watch");
    expect(res.status).toBe(503);

    // The 503 goes out at 50 ms; the handler only looks at the signal at 200 ms.
    await sleep(250);
    expect(aborted).toBe(true);
  });

  it("does not cut off an SSE stream", async () => {
    const res = await supertest(buildApp(50)).get("/events/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain("data: hello");
  });
});

describe("isSseRequest", () => {
  it("recognises the stream routes", () => {
    expect(isSseRequest({ path: "/api/v1/vaults/stream" })).toBe(true);
    expect(isSseRequest({ path: "/api/v1/yields/stream" })).toBe(true);
    expect(isSseRequest({ path: "/api/v1/users/GABC/stream" })).toBe(true);
    expect(isSseRequest({ path: "/api/v1/webhooks/12/stream/" })).toBe(true);
  });

  it("does not treat ordinary routes as streams", () => {
    expect(isSseRequest({ path: "/api/v1/vaults" })).toBe(false);
    expect(isSseRequest({ path: "/api/v1/streams" })).toBe(false);
    expect(isSseRequest({ path: "/api/v1/vaults/stream-status" })).toBe(false);
  });
});
