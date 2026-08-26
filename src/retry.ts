/**
 * R2: retries are bounded and honour Retry-After. The client must never retry
 * indefinitely, however insistent the server is.
 */

export interface RetryClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemRetryClock: RetryClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }

      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      // Without this, Ctrl+C during a backoff is only noticed after the wait.
      function onAbort(): void {
        clearTimeout(timer);
        reject(signal?.reason);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  clock?: RetryClock;
  signal?: AbortSignal | undefined;
  /** Called before each wait, so the CLI can tell the user why it is stalling. */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    error: unknown;
    /** Set when the server asked for longer than maxDelayMs. */
    requestedMs?: number;
  }) => void;
}

export class RetryableError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryAfterMs: number | undefined,
    override readonly cause: unknown,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

/**
 * Parses a Retry-After header value into milliseconds.
 * Accepts delta-seconds and HTTP-dates (RFC 9110 §10.2.3).
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

export function backoffDelay(attempt: number, base: number, max: number): number {
  const exponential = base * 2 ** (attempt - 1);
  return Math.min(exponential, max);
}

/**
 * Runs `fn`, retrying while `isRetryable` says so and the attempt budget holds.
 *
 * `fn` receives the attempt number (1-based). Throwing a non-retryable error
 * aborts immediately — this is how R9 (do not retry a stream that already
 * printed output) is enforced by the caller.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: RetryOptions,
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, onRetry } = options;
  const clock = options.clock ?? systemRetryClock;

  if (maxAttempts < 1) throw new RangeError("maxAttempts must be at least 1");

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    options.signal?.throwIfAborted();

    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (!isRetryable(error)) throw error;
      if (attempt === maxAttempts) break;

      const hinted = error instanceof RetryableError ? error.retryAfterMs : undefined;

      // A server is free to ask for a day. Attempts were already bounded; this
      // bounds the wall clock too, so a large Retry-After cannot park the CLI
      // in a silent sleep with no way out.
      const requested = hinted ?? backoffDelay(attempt, baseDelayMs, maxDelayMs);
      const delayMs = Math.min(requested, maxDelayMs);

      onRetry?.({
        attempt,
        delayMs,
        error,
        ...(requested > delayMs ? { requestedMs: requested } : {}),
      });
      await clock.sleep(delayMs, options.signal);
    }
  }

  throw lastError;
}
