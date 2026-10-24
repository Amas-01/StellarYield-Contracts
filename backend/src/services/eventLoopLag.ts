import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { eventLoopLagSeconds } from "./metrics.js";

/** Length of the window the load shedder reads its p99 from (#1251). */
const WINDOW_MS = 1000;
/** Cadence of the timer that feeds nodejs_event_loop_lag_seconds (#1252). */
const SAMPLE_INTERVAL_MS = 100;
const NS_PER_MS = 1_000_000;
const MS_PER_S = 1000;

interface LagSnapshot {
  p50Ms: number;
  p99Ms: number;
}

/**
 * Event loop delay histogram from perf_hooks (#1251). It is reset at the end of
 * every window, so a stall stops counting once the loop has recovered.
 */
const delayHistogram = monitorEventLoopDelay({ resolution: 10 });
delayHistogram.enable();

let windowSnapshot: LagSnapshot = { p50Ms: 0, p99Ms: 0 };

setInterval(() => {
  windowSnapshot = {
    p50Ms: delayHistogram.percentile(50) / NS_PER_MS,
    p99Ms: delayHistogram.percentile(99) / NS_PER_MS,
  };
  delayHistogram.reset();
}, WINDOW_MS).unref();

/** Event loop lag over the most recent completed window, in milliseconds. */
export function getEventLoopLagSnapshot(): LagSnapshot {
  return windowSnapshot;
}

/**
 * Feeds nodejs_event_loop_lag_seconds (#1252). A timer due every
 * SAMPLE_INTERVAL_MS fires late by however long the loop was busy, so each
 * tick's lateness is one lag observation. The summary's sliding window in
 * metrics.ts turns those observations into p50 and p99.
 */
let lastTickAt = performance.now();

setInterval(() => {
  const now = performance.now();
  const lagMs = Math.max(0, now - lastTickAt - SAMPLE_INTERVAL_MS);
  lastTickAt = now;
  eventLoopLagSeconds.observe(lagMs / MS_PER_S);
}, SAMPLE_INTERVAL_MS).unref();
