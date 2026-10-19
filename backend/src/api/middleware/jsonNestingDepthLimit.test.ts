import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { jsonNestingDepthLimit } from "./jsonNestingDepthLimit.js";

describe("jsonNestingDepthLimit", () => {
  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(jsonNestingDepthLimit(10));

    app.post("/test", (req, res) => {
      res.json({ success: true });
    });

    return app;
  }

  it("accepts body with nesting depth <= 10", async () => {
    const app = createApp();
    const body = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: "value" } } } } } } } } } };
    const res = await request(app)
      .post("/test")
      .send(body);
    expect(res.status).toBe(200);
  });

  it("rejects body with nesting depth > 10", async () => {
    const app = createApp();
    const body = { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: "value" } } } } } } } } } } };
    const res = await request(app)
      .post("/test")
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("RequestValidationError");
    expect(res.body.message).toContain("nesting depth");
  });

  it("accepts shallow nesting", async () => {
    const app = createApp();
    const body = { a: 1, b: 2, c: 3 };
    const res = await request(app)
      .post("/test")
      .send(body);
    expect(res.status).toBe(200);
  });

  it("skips GET requests", async () => {
    const app = createApp();
    const res = await request(app).get("/test");
    expect(res.status).toBe(200);
  });

  it("handles deeply nested arrays", async () => {
    const app = createApp();
    const body = [[[[[[[[[[["value"]]]]]]]]]]];
    const res = await request(app)
      .post("/test")
      .send(body);
    expect(res.status).toBe(400);
  });

  it("counts mixed object and array nesting", async () => {
    const app = createApp();
    const body = {
      a: {
        b: [
          {
            c: {
              d: [
                {
                  e: {
                    f: [
                      {
                        g: {
                          h: [
                            {
                              i: {
                                j: {
                                  k: "value",
                                },
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    };
    const res = await request(app)
      .post("/test")
      .send(body);
    expect(res.status).toBe(400);
  });
});
