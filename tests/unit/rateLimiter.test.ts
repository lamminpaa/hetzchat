import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "../../src/rateLimiter.js";
import { FakeClock } from "../helpers/fakeClock.js";

/**
 * R1: never issue more than `limit` requests inside any rolling `windowMs`.
 *
 * The assertion is derived from the requirement, not the implementation: for a
 * chronologically ordered list of grants, "no more than N in any window" is
 * exactly "grant[i + N] is at least one window after grant[i]".
 */
function assertNeverExceedsWindow(grants: number[], limit: number, windowMs: number): void {
  for (let i = 0; i + limit < grants.length; i++) {
    const first = grants[i] as number;
    const overflowing = grants[i + limit] as number;
    expect(
      overflowing - first,
      `requests ${i}..${i + limit} all landed inside one ${windowMs}ms window`,
    ).toBeGreaterThanOrEqual(windowMs);
  }
}

describe("R1 rate limit compliance", () => {
  it("never grants an 11th request inside a 60s window", async () => {
    const clock = new FakeClock();
    const limiter = new SlidingWindowLimiter(10, 60_000, clock);
    const grants: number[] = [];

    for (let i = 0; i < 25; i++) {
      await limiter.acquire();
      grants.push(clock.now());
    }

    expect(grants).toHaveLength(25);
    assertNeverExceedsWindow(grants, 10, 60_000);
  });

  it("holds the limit when callers acquire concurrently", async () => {
    const clock = new FakeClock();
    const limiter = new SlidingWindowLimiter(10, 60_000, clock);
    const grants: number[] = [];

    await Promise.all(
      Array.from({ length: 25 }, () => limiter.acquire().then(() => void grants.push(clock.now()))),
    );

    expect(grants).toHaveLength(25);
    assertNeverExceedsWindow([...grants].sort((a, b) => a - b), 10, 60_000);
  });

  it("grants immediately while the window has room", async () => {
    const clock = new FakeClock();
    const limiter = new SlidingWindowLimiter(10, 60_000, clock);

    for (let i = 0; i < 10; i++) await limiter.acquire();

    expect(clock.now()).toBe(0);
    expect(limiter.used()).toBe(10);
  });

  it("reopens the window once the oldest grant ages out", async () => {
    const clock = new FakeClock();
    const limiter = new SlidingWindowLimiter(2, 60_000, clock);

    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.waitTime()).toBeGreaterThan(0);

    clock.advance(60_000);
    expect(limiter.waitTime()).toBe(0);
    expect(limiter.used()).toBe(0);
  });

  it("rejects a nonsensical configuration rather than silently allowing everything", () => {
    expect(() => new SlidingWindowLimiter(0, 60_000)).toThrow(RangeError);
    expect(() => new SlidingWindowLimiter(10, 0)).toThrow(RangeError);
  });
});
