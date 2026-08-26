import { describe, expect, it } from "vitest";
import { InferenceClient } from "../../src/client/inference.js";
import { InferenceError, StreamInterruptedError } from "../../src/client/errors.js";
import { RetryableError } from "../../src/retry.js";
import type { ChatRequest } from "../../src/client/transport.js";
import { FakeClock } from "../helpers/fakeClock.js";
import { FakeTransport } from "../helpers/fakeTransport.js";

const request: ChatRequest = {
  model: "Qwen/Qwen3.6-35B-A3B-FP8",
  messages: [{ role: "user", content: "hi" }],
  temperature: 0.7,
  maxOutputTokens: 256,
};

function makeClient(transport: FakeTransport, maxAttempts = 4) {
  const clock = new FakeClock();
  const throttles: number[] = [];

  const client = new InferenceClient({
    transport,
    requestsPerWindow: 10,
    rateWindowMs: 60_000,
    maxAttempts,
    limiterClock: clock,
    retryClock: clock,
    onThrottle: (waitMs) => throttles.push(waitMs),
  });

  return { client, clock, throttles };
}

describe("R1 retries consume rate-limit budget", () => {
  it("counts every attempt, not just the first, against the window", async () => {
    const transport = new FakeTransport({ error: new RetryableError("429", 429, 0, undefined) });
    const { client } = makeClient(transport, 4);

    await expect(client.stream(request, () => {})).rejects.toBeInstanceOf(RetryableError);

    // Four attempts were made, so four slots are spent — a retry that skipped
    // the limiter would be exactly the request the server is refusing.
    expect(transport.streamCalls).toHaveLength(4);
    expect(client.rateLimitUsed()).toBe(4);
  });

  it("waits rather than overrunning the window across many turns", async () => {
    const transport = new FakeTransport({ deltas: ["ok"] });
    const { client, clock, throttles } = makeClient(transport, 1);

    for (let i = 0; i < 12; i++) await client.stream(request, () => {});

    expect(transport.streamCalls).toHaveLength(12);
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
    expect(throttles.length).toBeGreaterThan(0);
  });
});

describe("R9 stream interruption is terminal", () => {
  it("wraps a post-output failure so the retry layer refuses it", async () => {
    const transport = new FakeTransport({
      deltas: ["partial"],
      error: new RetryableError("503", 503, 0, undefined),
    });
    const { client } = makeClient(transport, 4);

    await expect(client.stream(request, () => {})).rejects.toBeInstanceOf(StreamInterruptedError);
    expect(transport.streamCalls).toHaveLength(1);
  });

  it("reports how much output survived", async () => {
    const transport = new FakeTransport({
      deltas: ["twelve chars"],
      error: new RetryableError("503", 503, 0, undefined),
    });
    const { client } = makeClient(transport, 4);

    await expect(client.stream(request, () => {})).rejects.toThrow(/12 characters/);
  });
});

describe("session usage accounting", () => {
  it("adds up token usage across turns", async () => {
    const transport = new FakeTransport();
    transport.queue(
      { deltas: ["a"], usage: { promptTokens: 10, completionTokens: 3 } },
      { deltas: ["b"], usage: { promptTokens: 20, completionTokens: 5 } },
    );
    const { client } = makeClient(transport, 1);

    await client.stream(request, () => {});
    await client.stream(request, () => {});

    expect(client.sessionUsage()).toEqual({
      requests: 2,
      promptTokens: 30,
      completionTokens: 8,
    });
  });

  it("does not count a request that never succeeded", async () => {
    const transport = new FakeTransport({ error: new InferenceError("400", 400) });
    const { client } = makeClient(transport, 4);

    await expect(client.stream(request, () => {})).rejects.toBeInstanceOf(InferenceError);
    expect(client.sessionUsage().requests).toBe(0);
  });
});
