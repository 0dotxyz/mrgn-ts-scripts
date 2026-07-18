/** Shared RPC pacing and retry helpers for scripts that issue thousands of requests. */

/**
 * Returns an awaitable gate that spaces request starts so at most requestsPerSecond begin
 * per second across all callers sharing the pacer.
 */
export function makePacer(requestsPerSecond: number): () => Promise<void> {
  const interval = 1_000 / requestsPerSecond;
  let nextAt = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + interval;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
}

export function isRateLimit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|too many requests/i.test(message);
}

/** Retries with exponential backoff; rate-limit errors back off twice as long. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 5,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i === attempts - 1) break;
      const backoff = 1_000 * 2 ** i * (isRateLimit(error) ? 2 : 1);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastError;
}
