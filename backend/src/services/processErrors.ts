import { logger as defaultLogger } from "../logger.js";

/** Exit status the supervisor sees after a fatal process error (#1249). */
export const FATAL_EXIT_CODE = 1;
/** Longest we wait for logs to drain before exiting anyway. */
const FLUSH_TIMEOUT_MS = 2_000;

export type FatalOrigin = "unhandledRejection" | "uncaughtException";

interface FatalLog {
  fatal(obj: object, msg: string): void;
  flush(cb?: (err?: Error) => void): void;
}

interface FatalDeps {
  log: FatalLog;
  exit: (code: number) => void;
}

/**
 * Log a fatal error with its stack, flush the log, then exit non-zero so the
 * supervisor restarts the process (#1249). A timer forces the exit, so a stuck
 * flush cannot keep a broken process alive.
 */
export function exitOnFatalError(origin: FatalOrigin, reason: unknown, deps: FatalDeps): void {
  const err = reason instanceof Error ? reason : new Error(`Non-Error ${origin}: ${String(reason)}`);
  deps.log.fatal({ err, origin }, `Fatal ${origin}, exiting`);

  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    deps.exit(FATAL_EXIT_CODE);
  };

  const timer = setTimeout(exitOnce, FLUSH_TIMEOUT_MS);
  try {
    deps.log.flush(() => {
      clearTimeout(timer);
      exitOnce();
    });
  } catch {
    // A logger without flush support must not stop the exit.
    clearTimeout(timer);
    exitOnce();
  }
}

/**
 * Route unhandled promise rejections and uncaught exceptions through
 * {@link exitOnFatalError}. Node's default would already exit, but only after
 * printing to stderr, skipping the structured log and any flush (#1249).
 */
export function registerProcessErrorHandlers(
  proc: Pick<NodeJS.Process, "on"> = process,
  deps: FatalDeps = { log: defaultLogger, exit: (code) => process.exit(code) },
): void {
  proc.on("unhandledRejection", (reason) => exitOnFatalError("unhandledRejection", reason, deps));
  proc.on("uncaughtException", (err) => exitOnFatalError("uncaughtException", err, deps));
}
