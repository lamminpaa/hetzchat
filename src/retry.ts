/**
 * R2: retries are bounded and honour Retry-After. The client must never retry
 * indefinitely, however insistent the server is.
 */

export interface RetryClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemRetryClock: RetryClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  clock?: RetryClock;
  /** Called before each wait, so the CLI can tell the user why it is stalling. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
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
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (!isRetryable(error)) throw error;
      if (attempt === maxAttempts) break;

      const hinted = error instanceof RetryableError ? error.retryAfterMs : undefined;
      const delayMs = hinted ?? backoffDelay(attempt, baseDelayMs, maxDelayMs);

      onRetry?.({ attempt, delayMs, error });
      await clock.sleep(delayMs);
    }
  }

  throw lastError;
}
