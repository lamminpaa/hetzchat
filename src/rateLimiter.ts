/**
 * R1: never issue more than `limit` requests inside any rolling `windowMs`.
 *
 * Hetzner's documented ceiling is 10 requests per 60 s per key; going over
 * returns 429. Waiting is cheaper than being rejected, so the limiter blocks
 * rather than throwing.
 */

export interface LimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: LimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class SlidingWindowLimiter {
  private readonly grants: number[] = [];

  /**
   * Serialises reservations. Without this, two callers could both observe
   * `grants.length < limit` before either had recorded its own grant.
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: LimiterClock = systemClock,
  ) {
    if (limit < 1) throw new RangeError("rate limit must allow at least one request");
    if (windowMs < 1) throw new RangeError("rate limit window must be positive");
  }

  acquire(): Promise<void> {
    const next = this.tail.then(
      () => this.reserve(),
      () => this.reserve(),
    );
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Requests still counted against the current window. */
  used(): number {
    this.evictExpired(this.clock.now());
    return this.grants.length;
  }

  /** Milliseconds until a slot frees up, or 0 if one is free now. */
  waitTime(): number {
    const now = this.clock.now();
    this.evictExpired(now);
    if (this.grants.length < this.limit) return 0;
    const oldest = this.grants[0] as number;
    return this.windowMs - (now - oldest);
  }

  private async reserve(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.evictExpired(now);

      if (this.grants.length < this.limit) {
        this.grants.push(now);
        return;
      }

      const oldest = this.grants[0] as number;
      // +1 so the oldest grant is strictly outside the window when we re-check.
      await this.clock.sleep(this.windowMs - (now - oldest) + 1);
    }
  }

  private evictExpired(now: number): void {
    while (this.grants.length > 0 && now - (this.grants[0] as number) >= this.windowMs) {
      this.grants.shift();
    }
  }
}
