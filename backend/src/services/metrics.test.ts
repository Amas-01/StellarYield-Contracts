import { describe, it, expect } from "vitest";
import { httpRequestDurationSeconds, getMetrics } from "./metrics.js";

describe("httpRequestDurationSeconds metric", () => {
  it("has correct configuration and buckets for p95/p99 latency", async () => {
    // Record observations across various durations
    httpRequestDurationSeconds.observe({ method: "GET", route: "/api/v1/vaults" }, 0.04);
    httpRequestDurationSeconds.observe({ method: "GET", route: "/api/v1/vaults" }, 0.08);
    httpRequestDurationSeconds.observe({ method: "GET", route: "/api/v1/vaults" }, 0.2);
    httpRequestDurationSeconds.observe({ method: "GET", route: "/api/v1/vaults" }, 0.45);
    httpRequestDurationSeconds.observe({ method: "GET", route: "/api/v1/vaults" }, 0.9);
    httpRequestDurationSeconds.observe({ method: "GET", route: "/api/v1/vaults" }, 1.8);
    httpRequestDurationSeconds.observe({ method: "GET", route: "/api/v1/vaults" }, 3.5);

    const metricsText = await getMetrics();

    expect(metricsText).toContain("# HELP http_request_duration_seconds HTTP request duration in seconds");
    expect(metricsText).toContain("# TYPE http_request_duration_seconds histogram");
    expect(metricsText).toMatch(/http_request_duration_seconds_bucket\{le="0\.05",method="GET",route="\/api\/v1\/vaults"\}/);
    expect(metricsText).toMatch(/http_request_duration_seconds_bucket\{le="0\.1",method="GET",route="\/api\/v1\/vaults"\}/);
    expect(metricsText).toMatch(/http_request_duration_seconds_bucket\{le="0\.25",method="GET",route="\/api\/v1\/vaults"\}/);
    expect(metricsText).toMatch(/http_request_duration_seconds_bucket\{le="0\.5",method="GET",route="\/api\/v1\/vaults"\}/);
    expect(metricsText).toMatch(/http_request_duration_seconds_bucket\{le="1",method="GET",route="\/api\/v1\/vaults"\}/);
    expect(metricsText).toMatch(/http_request_duration_seconds_bucket\{le="2",method="GET",route="\/api\/v1\/vaults"\}/);
    expect(metricsText).toMatch(/http_request_duration_seconds_bucket\{le="5",method="GET",route="\/api\/v1\/vaults"\}/);
    expect(metricsText).toMatch(/http_request_duration_seconds_bucket\{le="\+Inf",method="GET",route="\/api\/v1\/vaults"\}/);
    expect(metricsText).toMatch(/http_request_duration_seconds_count\{method="GET",route="\/api\/v1\/vaults"\}/);
  });
});
