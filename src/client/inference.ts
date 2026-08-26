import { SlidingWindowLimiter, type LimiterClock } from "../rateLimiter.js";
import { withRetry, type RetryClock } from "../retry.js";
import { isRetryable, StreamInterruptedError } from "./errors.js";
import type { ChatRequest, ChatResult, DeltaHandler, Transport, Usage } from "./transport.js";

export interface InferenceClientOptions {
  transport: Transport;
  requestsPerWindow: number;
  rateWindowMs: number;
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  limiterClock?: LimiterClock;
  retryClock?: RetryClock;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  onThrottle?: (waitMs: number) => void;
}

export interface SessionUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Composes transport, rate limiting (R1) and bounded retry (R2), and enforces
 * that a stream which already printed output is not retried (R9).
 */
export class InferenceClient {
  private readonly limiter: SlidingWindowLimiter;
  private readonly usage: SessionUsage = { requests: 0, promptTokens: 0, completionTokens: 0 };

  constructor(private readonly options: InferenceClientOptions) {
    this.limiter = new SlidingWindowLimiter(
      options.requestsPerWindow,
      options.rateWindowMs,
      options.limiterClock,
    );
  }

  sessionUsage(): SessionUsage {
    return { ...this.usage };
  }

  /** Requests still counted against the current rate-limit window. */
  rateLimitUsed(): number {
    return this.limiter.used();
  }

  async stream(
    request: ChatRequest,
    onDelta: DeltaHandler,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    return this.run((attemptSignal) => {
      let printed = 0;

      return this.options.transport
        .stream(
          request,
          (delta) => {
            printed += delta.length;
            onDelta(delta);
          },
          attemptSignal,
        )
        .catch((error: unknown) => {
          // R9: output is already on screen for this turn. Retrying would
          // repeat it, so the failure is made terminal instead.
          if (printed > 0) throw new StreamInterruptedError(printed, error);
          throw error;
        });
    }, signal);
  }

  async complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    return this.run((attemptSignal) => this.options.transport.complete(request, attemptSignal), signal);
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    return this.run((attemptSignal) => this.options.transport.listModels(attemptSignal), signal);
  }

  private async run<T>(
    attempt: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await withRetry(
      async () => {
        await this.waitForSlot();
        signal?.throwIfAborted();
        return attempt(signal);
      },
      isRetryable,
      {
        maxAttempts: this.options.maxAttempts,
        baseDelayMs: this.options.baseDelayMs ?? 1000,
        maxDelayMs: this.options.maxDelayMs ?? 30_000,
        ...(signal ? { signal } : {}),
        ...(this.options.retryClock ? { clock: this.options.retryClock } : {}),
        ...(this.options.onRetry ? { onRetry: this.options.onRetry } : {}),
      },
    );

    this.usage.requests += 1;
    this.recordUsage(result);
    return result;
  }

  /**
   * R1: every attempt, including retries, takes a slot in the sliding window.
   * A retry that jumped the queue would be exactly the request the server is
   * already refusing.
   */
  private async waitForSlot(): Promise<void> {
    const waitMs = this.limiter.waitTime();
    if (waitMs > 0) this.options.onThrottle?.(waitMs);
    await this.limiter.acquire();
  }

  private recordUsage(result: unknown): void {
    const usage = (result as { usage?: Usage }).usage;
    if (!usage) return;
    this.usage.promptTokens += usage.promptTokens;
    this.usage.completionTokens += usage.completionTokens;
  }
}
