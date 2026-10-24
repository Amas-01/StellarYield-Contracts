import { describe, it, expect } from "vitest";
import { eventLoopLagSeconds, getMetrics } from "./metrics.js";
import { getEventLoopLagSnapshot } from "./eventLoopLag.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function blockEventLoop(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Busy-wait on purpose: this is the saturation the metric must detect.
  }
}

function readSum(text: string): number {
  const match = text.match(/^nodejs_event_loop_lag_seconds_sum (\S+)$/m);
  return match ? Number(match[1]) : 0;
}

describe("nodejs_event_loop_lag_seconds (#1252)", () => {
  it("is exposed in /metrics as a summary with p50 and p99 quantiles", async () => {
    eventLoopLagSeconds.observe(0.2);

    const text = await getMetrics();

    expect(text).toContain("# TYPE nodejs_event_loop_lag_seconds summary");
    expect(text).toMatch(/nodejs_event_loop_lag_seconds\{quantile="0\.5"\} /);
    expect(text).toMatch(/nodejs_event_loop_lag_seconds\{quantile="0\.99"\} /);
  });

  it("grows when the event loop is blocked", async () => {
    // Let the sampler settle so the blocked window is the only lag in range.
    await sleep(150);
    const before = readSum(await getMetrics());

    blockEventLoop(200);
    await sleep(150);

    const after = readSum(await getMetrics());
    expect(after - before).toBeGreaterThanOrEqual(0.1);
  });

  it("keeps a loop-lag snapshot that the load shedder can read", () => {
    const snapshot = getEventLoopLagSnapshot();

    expect(snapshot.p50Ms).toBeGreaterThanOrEqual(0);
    expect(snapshot.p99Ms).toBeGreaterThanOrEqual(snapshot.p50Ms);
  });
});
