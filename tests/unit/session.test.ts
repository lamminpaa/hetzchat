import { describe, expect, it } from "vitest";
import { InferenceClient } from "../../src/client/inference.js";
import { InferenceError } from "../../src/client/errors.js";
import { RetryableError } from "../../src/retry.js";
import { DEFAULTS, resolveConfig, TOKEN_ENV_VAR } from "../../src/config.js";
import { Session } from "../../src/session.js";
import { captureOutput } from "../helpers/captureOutput.js";
import { FakeTransport, type StreamScript } from "../helpers/fakeTransport.js";
import { FakeClock } from "../helpers/fakeClock.js";

const TOKEN = "token-value-1234567890";

function makeSession(script?: StreamScript, overrides: Record<string, string> = {}) {
  const transport = new FakeTransport(script);
  const captured = captureOutput([TOKEN]);
  const config = resolveConfig({ env: { [TOKEN_ENV_VAR]: TOKEN, ...overrides } });
  const clock = new FakeClock();

  const client = new InferenceClient({
    transport,
    requestsPerWindow: DEFAULTS.requestsPerWindow,
    rateWindowMs: DEFAULTS.rateWindowMs,
    maxAttempts: 3,
    limiterClock: clock,
    retryClock: clock,
  });

  return { transport, captured, session: new Session({ config, client, output: captured.output }) };
}

describe("R6 streaming fidelity", () => {
  it("stores exactly the text that was printed", async () => {
    const { session, captured } = makeSession({ deltas: ["Hel", "lo, ", "world", "!"] });

    const result = await session.ask("hi");

    expect(result.ok).toBe(true);
    expect(captured.stdout()).toBe("Hello, world!\n");
    expect(session.conversation.history().at(-1)).toEqual({
      role: "assistant",
      content: "Hello, world!",
    });
  });

  it("assembles deltas that split a word or a newline", async () => {
    const { session, captured } = makeSession({ deltas: ["line one\n", "li", "ne two"] });

    await session.ask("hi");

    expect(captured.stdout()).toBe("line one\nline two\n");
    expect(session.conversation.history().at(-1)?.content).toBe("line one\nline two");
  });

  it("stores the same text when streaming is off", async () => {
    const { session, captured } = makeSession({ deltas: ["complete answer"] }, {
      HETZCHAT_STREAM: "off",
    });

    await session.ask("hi");

    expect(captured.stdout()).toBe("complete answer\n");
    expect(session.conversation.history().at(-1)?.content).toBe("complete answer");
  });

  it("carries the trimmed history into the request", async () => {
    const { session, transport } = makeSession({ deltas: ["ok"] });

    await session.ask("first question");
    await session.ask("second question");

    const second = transport.streamCalls[1];
    expect(second?.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(second?.messages.at(-1)?.content).toBe("second question");
  });
});

describe("R6 the chat template's leading blank lines are dropped consistently", () => {
  it("does not open every answer with the template's newlines", async () => {
    const { session, captured } = makeSession({ deltas: ["\n\n", "The answer."] });

    await session.ask("q");

    expect(captured.stdout()).toBe("The answer.\n");
  });

  it("stores exactly what it printed", async () => {
    const { session, captured } = makeSession({ deltas: ["\n\n", "The answer."] });

    await session.ask("q");

    const printed = captured.stdout().replace(/\n$/, "");
    expect(session.conversation.history().at(-1)?.content).toBe(printed);
  });

  it("agrees however the leading whitespace was split across deltas", async () => {
    for (const deltas of [
      ["\n\nThe answer."],
      ["\n", "\n", "The answer."],
      ["\n\n", "The", " answer."],
      ["  \n\n  ", "The answer."],
    ]) {
      const { session, captured } = makeSession({ deltas });
      await session.ask("q");

      expect(captured.stdout(), JSON.stringify(deltas)).toBe("The answer.\n");
      expect(session.conversation.history().at(-1)?.content).toBe("The answer.");
    }
  });

  it("leaves whitespace inside the answer alone", async () => {
    const { session, captured } = makeSession({ deltas: ["\n\nline one\n\nline two"] });

    await session.ask("q");

    expect(captured.stdout()).toBe("line one\n\nline two\n");
  });
});

describe("R16 reasoning is surfaced, not discarded", () => {
  it("hides reasoning by default, and does not mistake it for the answer", async () => {
    const { session, captured } = makeSession({
      reasoning: ["Let me think. ", "2 + 2 = 4."],
      deltas: ["Four."],
    });

    await session.ask("what is 2+2?");

    expect(captured.stdout()).toBe("Four.\n");
    expect(captured.stdout()).not.toContain("Let me think");
    expect(session.conversation.history().at(-1)?.content).toBe("Four.");
  });

  it("shows it when asked, ahead of the answer", async () => {
    const { session, captured } = makeSession(
      { reasoning: ["Let me think. ", "2 + 2 = 4."], deltas: ["Four."] },
      { HETZCHAT_THINKING: "on" },
    );

    await session.ask("what is 2+2?");

    expect(captured.stdout()).toContain("Let me think. 2 + 2 = 4.");
    expect(captured.stdout()).toContain("Four.");
    expect(captured.stdout().indexOf("Let me think")).toBeLessThan(
      captured.stdout().indexOf("Four."),
    );
  });

  it("never puts reasoning into history, even when shown", async () => {
    const { session, transport } = makeSession(
      { reasoning: ["private deliberation"], deltas: ["Four."] },
      { HETZCHAT_THINKING: "on" },
    );

    await session.ask("first");
    await session.ask("second");

    const sent = JSON.stringify(transport.streamCalls[1]?.messages);
    expect(sent, "reasoning was sent back to the model").not.toContain("private deliberation");
    expect(session.conversation.history().map((m) => m.content)).toEqual([
      "first",
      "Four.",
      "second",
      "Four.",
    ]);
  });
});

describe("R17 an answer that never arrived says why", () => {
  it("explains an empty response that hit the token cap", async () => {
    const { session, captured } = makeSession({
      reasoning: ["thinking and thinking and thinking"],
      deltas: [],
      finishReason: "length",
    });

    const result = await session.ask("something hard");

    expect(result.text).toBe("");
    expect(captured.stderr()).toMatch(/used all \d+ output tokens thinking/);
    expect(captured.stderr()).toMatch(/--max-output-tokens/);
  });

  it("says nothing when the response ended normally", async () => {
    const { session, captured } = makeSession({ deltas: ["a real answer"] });

    await session.ask("something easy");

    expect(captured.stderr()).toBe("");
  });

  it("says nothing when the cap was hit but an answer did arrive", async () => {
    const { session, captured } = makeSession({
      deltas: ["a truncated but real answer"],
      finishReason: "length",
    });

    await session.ask("something long");

    expect(captured.stderr()).toBe("");
  });
});

describe("R7 a failed turn leaves history clean", () => {
  it("rolls the user message back out when the request fails", async () => {
    const { session } = makeSession({ error: new InferenceError("Bad Request", 400) });

    const result = await session.ask("this will fail");

    expect(result.ok).toBe(false);
    expect(session.conversation.history()).toHaveLength(0);
  });

  it("leaves earlier successful turns untouched", async () => {
    const { session, transport } = makeSession();
    transport.queue({ deltas: ["good answer"] }, { error: new InferenceError("Bad Request", 400) });

    await session.ask("first");
    await session.ask("second");

    expect(session.conversation.history()).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "good answer" },
    ]);
  });

  it("sends no dangling user message on the next turn after a failure", async () => {
    const { session, transport } = makeSession();
    transport.queue({ error: new InferenceError("Bad Request", 400) }, { deltas: ["recovered"] });

    await session.ask("doomed");
    await session.ask("retry");

    const second = transport.streamCalls[1];
    expect(second?.messages.map((m) => m.content)).toEqual([
      session.conversation.system,
      "retry",
    ]);
  });

  it("reports the failure on stderr without leaking the token", async () => {
    const { session, captured } = makeSession({
      error: new InferenceError(`401 rejected token ${TOKEN}`, 401),
    });

    await session.ask("hi");

    expect(captured.stderr()).not.toContain(TOKEN);
    expect(captured.stderr()).toContain("401");
  });
});

describe("R9 mid-stream failures are not retried", () => {
  it("does not repeat output when a stream dies after printing", async () => {
    const { session, captured, transport } = makeSession({
      deltas: ["The answer is "],
      error: new RetryableError("connection reset", 503, 0, undefined),
    });

    const result = await session.ask("hi");

    expect(result.ok).toBe(false);
    expect(transport.streamCalls, "the dead stream was retried").toHaveLength(1);
    // The partial answer is kept and the line is closed, so the error that
    // follows does not run into the model's text.
    expect(captured.stdout()).toBe("The answer is \n");
    expect(captured.stdout().match(/The answer is /g)).toHaveLength(1);
  });

  it("still retries a stream that failed before printing anything", async () => {
    const { session, transport } = makeSession();
    transport.queue(
      { error: new RetryableError("503", 503, 0, undefined) },
      { error: new RetryableError("503", 503, 0, undefined) },
      { deltas: ["third time lucky"] },
    );

    const result = await session.ask("hi");

    expect(result.ok).toBe(true);
    expect(transport.streamCalls).toHaveLength(3);
    expect(session.conversation.history().at(-1)?.content).toBe("third time lucky");
  });
});

describe("image attachments", () => {
  it("rejects a file type the models cannot read", async () => {
    const { session } = makeSession();

    await expect(session.attachImage("/tmp/notes.txt")).rejects.toThrow(/Unsupported image type/);
  });
});
