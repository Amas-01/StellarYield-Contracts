import { describe, it, expect, vi, afterEach } from "vitest";
import { exitOnFatalError, registerProcessErrorHandlers } from "./processErrors.js";

function makeDeps(flush: (cb?: (err?: Error) => void) => void = (cb) => cb?.()) {
  return {
    log: { fatal: vi.fn(), flush: vi.fn(flush) },
    exit: vi.fn(),
  };
}

describe("exitOnFatalError (#1249)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs the error with its stack at fatal level, then exits 1", () => {
    const deps = makeDeps();
    const err = new Error("boom");

    exitOnFatalError("unhandledRejection", err, deps);

    expect(deps.log.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ err, origin: "unhandledRejection" }),
      "Fatal unhandledRejection, exiting",
    );
    expect(deps.log.flush).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("waits for the log flush to finish before exiting", () => {
    let flushDone: (() => void) | undefined;
    const deps = makeDeps((cb) => {
      flushDone = () => cb?.();
    });

    exitOnFatalError("uncaughtException", new Error("boom"), deps);
    expect(deps.exit).not.toHaveBeenCalled();

    flushDone?.();
    expect(deps.exit).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("forces the exit when the flush never completes", () => {
    vi.useFakeTimers();
    const deps = makeDeps(() => undefined);

    exitOnFatalError("uncaughtException", new Error("boom"), deps);
    vi.advanceTimersByTime(2_000);

    expect(deps.exit).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("still exits when the logger throws on flush", () => {
    const deps = makeDeps(() => {
      throw new Error("no flush support");
    });

    exitOnFatalError("uncaughtException", new Error("boom"), deps);

    expect(deps.exit).toHaveBeenCalledOnce();
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it("wraps a non-Error rejection reason so the log still carries a stack", () => {
    const deps = makeDeps();

    exitOnFatalError("unhandledRejection", "plain string reason", deps);

    const logged = deps.log.fatal.mock.calls[0]?.[0] as { err: Error };
    expect(logged.err).toBeInstanceOf(Error);
    expect(logged.err.message).toContain("plain string reason");
    expect(logged.err.stack).toBeDefined();
  });
});

describe("registerProcessErrorHandlers (#1249)", () => {
  it("routes unhandledRejection and uncaughtException into the fatal path", () => {
    const handlers = new Map<string, (arg: unknown) => void>();
    const proc = {
      on: vi.fn((event: string, handler: (arg: unknown) => void) => {
        handlers.set(event, handler);
      }),
    };
    const deps = makeDeps();

    registerProcessErrorHandlers(proc, deps);
    handlers.get("unhandledRejection")?.(new Error("rejected"));
    handlers.get("uncaughtException")?.(new Error("thrown"));

    expect(deps.log.fatal).toHaveBeenCalledTimes(2);
    expect(deps.log.fatal.mock.calls[0]?.[1]).toBe("Fatal unhandledRejection, exiting");
    expect(deps.log.fatal.mock.calls[1]?.[1]).toBe("Fatal uncaughtException, exiting");
    expect(deps.exit).toHaveBeenCalledWith(1);
  });
});
