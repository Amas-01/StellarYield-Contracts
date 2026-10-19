import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { queryArraySizeLimit } from "./queryArraySizeLimit.js";

describe("queryArraySizeLimit", () => {
  function createApp(config = {}) {
    const app = express();
    app.use(queryArraySizeLimit(config));

    app.get("/test", (req, res) => {
      res.json({ success: true });
    });

    app.post("/test", (req, res) => {
      res.json({ success: true });
    });

    return app;
  }

  it("accepts 50 repeated values (default max)", async () => {
    const app = createApp();
    const params = new Array(50).fill("value").map((v, i) => `address=${v}${i}`).join("&");
    const res = await request(app).get(`/test?${params}`);
    expect(res.status).toBe(200);
  });

  it("rejects 51 repeated values", async () => {
    const app = createApp();
    const params = new Array(51).fill("value").map((v, i) => `address=${v}${i}`).join("&");
    const res = await request(app).get(`/test?${params}`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("UnprocessableEntity");
    expect(res.body.parameter).toBe("address");
    expect(res.body.received).toBe(51);
    expect(res.body.maximum).toBe(50);
  });

  it("accepts single values", async () => {
    const app = createApp();
    const res = await request(app).get("/test?address=value");
    expect(res.status).toBe(200);
  });

  it("respects custom maxSize", async () => {
    const app = createApp({ maxSize: 5 });
    const params = new Array(5).fill("v").map((v, i) => `id=${v}${i}`).join("&");
    const res = await request(app).get(`/test?${params}`);
    expect(res.status).toBe(200);

    const params6 = new Array(6).fill("v").map((v, i) => `id=${v}${i}`).join("&");
    const res6 = await request(app).get(`/test?${params6}`);
    expect(res6.status).toBe(422);
  });

  it("handles mixed single and array parameters", async () => {
    const app = createApp({ maxSize: 50 });
    const params = "name=test&" + new Array(40).fill("id").map((v, i) => `${v}=${i}`).join("&");
    const res = await request(app).get(`/test?${params}`);
    expect(res.status).toBe(200);
  });

  it("rejects exceeding array in mixed parameters", async () => {
    const app = createApp({ maxSize: 50 });
    const params = "name=test&" + new Array(51).fill("id").map((v, i) => `${v}=${i}`).join("&");
    const res = await request(app).get(`/test?${params}`);
    expect(res.status).toBe(422);
    expect(res.body.parameter).toBe("id");
  });

  it("works with POST requests", async () => {
    const app = createApp();
    const params = new Array(51).fill("v").map((v, i) => `flag=${v}${i}`).join("&");
    const res = await request(app)
      .post(`/test?${params}`)
      .send({});
    expect(res.status).toBe(422);
  });
});
