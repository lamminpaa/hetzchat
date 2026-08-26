import { describe, expect, it, vi } from "vitest";
import { backoffDelay, parseRetryAfter, RetryableError, withRetry } from "../../src/retry.js";
import { isRetryable } from "../../src/client/errors.js";
import { FakeClock } from "../helpers/fakeClock.js";

const rateLimited = (retryAfterMs?: number) =>
  new RetryableError("Too Many Requests", 429, retryAfterMs, undefined);

describe("R2 bounded 429 handling", () => {
  it("stops after the attempt budget instead of retrying forever", async () => {
    const clock = new FakeClock();
    const fn = vi.fn(async () => {
      throw rateLimited(3000);
    });

    await expect(
      withRetry(fn, isRetryable, {
        maxAttempts: 4,
        baseDelayMs: 1000,
        maxDelayMs: 30_000,
        clock,
      }),
    ).rejects.toThrow("Too Many Requests");

    expect(fn).toHaveBeenCalledTimes(4);
    // Three waits between four attempts, none after the last.
    expect(clock.sleeps).toEqual([3000, 3000, 3000]);
  });

  it("honours Retry-After in preference to its own backoff", async () => {
    const clock = new FakeClock();
    const fn = vi.fn(async () => {
      throw rateLimited(7000);
    });

    await expect(
      withRetry(fn, isRetryable, { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000, clock }),
    ).rejects.toBeInstanceOf(RetryableError);

    expect(clock.sleeps).toEqual([7000, 7000]);
  });

  it("backs off exponentially when the server gives no hint", async () => {
    const clock = new FakeClock();
    const fn = vi.fn(async () => {
      throw rateLimited(undefined);
    });

    await expect(
      withRetry(fn, isRetryable, { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 30_000, clock }),
    ).rejects.toBeInstanceOf(RetryableError);

    expect(clock.sleeps).toEqual([1000, 2000, 4000]);
  });

  it("caps the backoff at maxDelayMs", () => {
    expect(backoffDelay(1, 1000, 5000)).toBe(1000);
    expect(backoffDelay(3, 1000, 5000)).toBe(4000);
    expect(backoffDelay(10, 1000, 5000)).toBe(5000);
  });

  it("returns the first success without further attempts", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw rateLimited(500);
      return "answer";
    });

    const result = await withRetry(fn, isRetryable, {
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      clock,
    });

    expect(result).toBe("answer");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(clock.sleeps).toEqual([500, 500]);
  });

  it("does not retry an error the caller called final", async () => {
    const clock = new FakeClock();
    const fn = vi.fn(async () => {
      throw Object.assign(new Error("Bad Request"), { status: 400 });
    });

    await expect(
      withRetry(fn, isRetryable, { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 30_000, clock }),
    ).rejects.toThrow("Bad Request");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });
});

describe("R2 Retry-After parsing", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("30", 0)).toBe(30_000);
    expect(parseRetryAfter("0", 0)).toBe(0);
  });

  it("reads an HTTP-date relative to now", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:45 GMT", now)).toBe(45_000);
  });

  it("clamps a date already in the past to zero rather than going negative", () => {
    const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:27:00 GMT", now)).toBe(0);
  });

  it("ignores absent or unparseable values", () => {
    expect(parseRetryAfter(undefined, 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
    expect(parseRetryAfter("  ", 0)).toBeUndefined();
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
  });
});

describe("R2 retry classification", () => {
  it("retries transient statuses and transport failures", () => {
    expect(isRetryable(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isRetryable(Object.assign(new Error("x"), { status: 500 }))).toBe(true);
    expect(isRetryable(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isRetryable(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
  });

  it("gives up immediately on errors another attempt cannot fix", () => {
    expect(isRetryable(Object.assign(new Error("x"), { status: 400 }))).toBe(false);
    expect(isRetryable(Object.assign(new Error("x"), { status: 401 }))).toBe(false);
    expect(isRetryable(Object.assign(new Error("x"), { status: 404 }))).toBe(false);
  });
});
