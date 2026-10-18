import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({
  query: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./sse.js", () => ({
  sseService: {
    broadcastWebhookDelivery: vi.fn(),
  },
}));

vi.mock("./webhookThrottle.js", () => ({
  isWebhookThrottled: vi.fn().mockResolvedValue(false),
}));

import { query } from "../db/index.js";
import { isWebhookThrottled } from "./webhookThrottle.js";

const mockIsThrottled = isWebhookThrottled as ReturnType<typeof vi.fn>;

const mockQuery = query as ReturnType<typeof vi.fn>;

function makeBossMock() {
  return { send: vi.fn() } as any;
}

describe("processWebhookDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("increments consecutive_failures on delivery failure", async () => {
    const { processWebhookDelivery } = await import("./webhookWorker.js");
    const notifMod = await import("./notifications.js");
    vi.spyOn(notifMod, "validateWebhookUrl").mockResolvedValue(undefined);

    mockQuery.mockResolvedValueOnce([
      { id: 1, url: "https://example.com/hook", events: ["deposit"], secret: null, consecutive_failures: 0 },
    ]);

    (fetch as any).mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" });

    const boss = makeBossMock();
    await processWebhookDelivery(boss, 1, '{"event":"deposit"}');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("consecutive_failures = $1"),
      [1, 1],
    );
  });

  it("resets consecutive_failures to 0 on success", async () => {
    const { processWebhookDelivery } = await import("./webhookWorker.js");
    const notifMod = await import("./notifications.js");
    vi.spyOn(notifMod, "validateWebhookUrl").mockResolvedValue(undefined);

    mockQuery.mockResolvedValueOnce([
      { id: 2, url: "https://example.com/hook", events: ["deposit"], secret: null, consecutive_failures: 5 },
    ]);

    (fetch as any).mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" });

    const boss = makeBossMock();
    await processWebhookDelivery(boss, 2, '{"event":"deposit"}');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("consecutive_failures = 0"),
      [2],
    );
  });

  it("opens the circuit after 5 consecutive failures (#1061)", async () => {
    const { processWebhookDelivery } = await import("./webhookWorker.js");
    const notifMod = await import("./notifications.js");
    vi.spyOn(notifMod, "validateWebhookUrl").mockResolvedValue(undefined);

    mockQuery.mockResolvedValueOnce([
      { id: 3, url: "https://example.com/hook", events: ["deposit"], secret: null, consecutive_failures: 4 },
    ]);

    (fetch as any).mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" });

    const boss = makeBossMock();
    await processWebhookDelivery(boss, 3, '{"event":"deposit"}');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("circuit_open = TRUE"),
      [5, 3],
    );
    // The endpoint is suspended, not deactivated, so a reset alone resumes it.
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("active = FALSE"),
      expect.anything(),
    );
  });

  it("marks the delivery failed_permanent once the circuit opens (#1061)", async () => {
    const { processWebhookDelivery } = await import("./webhookWorker.js");
    const notifMod = await import("./notifications.js");
    vi.spyOn(notifMod, "validateWebhookUrl").mockResolvedValue(undefined);

    mockQuery.mockResolvedValueOnce([
      { id: 6, url: "https://example.com/hook", events: ["deposit"], secret: null, consecutive_failures: 4 },
    ]);
    (fetch as any).mockResolvedValueOnce({ ok: false, status: 503, statusText: "Unavailable" });

    await processWebhookDelivery(makeBossMock(), 6, '{"event":"deposit"}');

    const deliveryInsert = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO webhook_deliveries"),
    );
    expect(deliveryInsert?.[1][3]).toBe("failed_permanent");
  });

  it("makes no delivery attempt while the circuit is open (#1061)", async () => {
    const { processWebhookDelivery } = await import("./webhookWorker.js");

    mockQuery.mockResolvedValueOnce([
      {
        id: 7,
        url: "https://example.com/hook",
        events: ["deposit"],
        secret: null,
        consecutive_failures: 5,
        circuit_open: true,
      },
    ]);

    await processWebhookDelivery(makeBossMock(), 7, '{"event":"deposit"}');

    expect(fetch).not.toHaveBeenCalled();
    // Only the initial SELECT ran — no failure bookkeeping, no retry row.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("broadcasts via SSE on delivery success", async () => {
    const { processWebhookDelivery } = await import("./webhookWorker.js");
    const notifMod = await import("./notifications.js");
    vi.spyOn(notifMod, "validateWebhookUrl").mockResolvedValue(undefined);

    mockQuery.mockResolvedValueOnce([
      { id: 4, url: "https://example.com/hook", events: ["deposit"], secret: null, consecutive_failures: 0 },
    ]);

    (fetch as any).mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" });

    const boss = makeBossMock();
    await processWebhookDelivery(boss, 4, '{"event":"deposit"}');

    const { sseService } = await import("./sse.js");
    expect(sseService.broadcastWebhookDelivery).toHaveBeenCalledWith(4, {
      type: "delivery",
      attempt: 1,
      statusCode: 200,
      durationMs: expect.any(Number),
      success: true,
    });
  });

  it("skips delivery without recording a failure when throttled (#1022)", async () => {
    const { processWebhookDelivery } = await import("./webhookWorker.js");

    mockQuery.mockResolvedValueOnce([
      {
        id: 5,
        url: "https://example.com/hook",
        events: ["deposit"],
        secret: null,
        consecutive_failures: 0,
        max_per_hour: 100,
      },
    ]);
    mockIsThrottled.mockResolvedValueOnce(true);

    const boss = makeBossMock();
    await processWebhookDelivery(boss, 5, '{"event":"deposit"}');

    expect(mockIsThrottled).toHaveBeenCalledWith(5, 100);
    expect(fetch).not.toHaveBeenCalled();
    // Only the initial SELECT ran — no failure bookkeeping.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("returns early when webhook not found", async () => {
    const { processWebhookDelivery } = await import("./webhookWorker.js");

    mockQuery.mockResolvedValueOnce([]);

    const boss = makeBossMock();
    await processWebhookDelivery(boss, 999, '{"event":"deposit"}');

    expect(fetch).not.toHaveBeenCalled();
  });
});
