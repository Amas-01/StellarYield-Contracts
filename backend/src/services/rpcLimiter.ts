import { config } from "../config.js";
import { logger } from "../logger.js";
import { rpcConcurrentRequestsLimited } from "./metrics.js";

/**
 * Semaphore-based concurrency limiter for RPC calls.
 * 
 * Prevents overwhelming the RPC endpoint by limiting the number of concurrent
 * requests. When the limit is reached, additional requests wait in a queue
 * until a slot becomes available.
 */
class RpcSemaphore {
  private permits: number;
  private available: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
    this.available = permits;
  }

  /**
   * Acquire a permit, waiting if necessary until one is available.
   */
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }

    // No permits available - wait in queue
    rpcConcurrentRequestsLimited.inc();
    logger.debug(
      { waiting: this.waiting.length + 1, permits: this.permits },
      "RPC request queued due to concurrency limit"
    );

    return new Promise<() => void>((resolve) => {
      this.waiting.push(() => {
        this.available--;
        resolve(() => this.release());
      });
    });
  }

  /**
   * Release a permit, allowing a waiting request to proceed.
   */
  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.available++;
    }
  }

  /**
   * Get current usage statistics.
   */
  getStats(): { total: number; available: number; waiting: number } {
    return {
      total: this.permits,
      available: this.available,
      waiting: this.waiting.length,
    };
  }
}

// Global semaphore instance - configured from RPC_MAX_CONCURRENT_REQUESTS
export const rpcSemaphore = new RpcSemaphore(config.rpcMaxConcurrentRequests);

/**
 * Execute an RPC call with concurrency limiting.
 * 
 * Acquires a semaphore permit before executing the call, ensuring that
 * no more than RPC_MAX_CONCURRENT_REQUESTS are in flight at once.
 */
export async function withRpcLimit<T>(fn: () => Promise<T>): Promise<T> {
  const release = await rpcSemaphore.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
