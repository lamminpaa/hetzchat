import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InferenceClient } from "../../src/client/inference.js";
import { InferenceError } from "../../src/client/errors.js";
import { resolveConfig, TOKEN_ENV_VAR } from "../../src/config.js";
import type { ChatMessage } from "../../src/conversation.js";
import { Session } from "../../src/session.js";
import { BUILTIN_TOOLS } from "../../src/tools/builtin.js";
import { ToolRunner, type Approver } from "../../src/tools/runner.js";
import { captureOutput } from "../helpers/captureOutput.js";
import { FakeClock } from "../helpers/fakeClock.js";
import { FakeTransport, type StreamScript } from "../helpers/fakeTransport.js";

const TOKEN = "token-value-1234567890";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hetzchat-loop-"));
  await writeFile(join(root, "notes.txt"), "the file says hello\n", "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const yes: Approver = { interactive: true, confirm: async () => true };

function makeSession(env: Record<string, string> = {}, approver?: Approver) {
  const transport = new FakeTransport();
  const captured = captureOutput([TOKEN]);
  const config = resolveConfig({ env: { [TOKEN_ENV_VAR]: TOKEN, ...env } });
  const clock = new FakeClock();

  const client = new InferenceClient({
    transport,
    requestsPerWindow: 100,
    rateWindowMs: 60_000,
    maxAttempts: 1,
    limiterClock: clock,
    retryClock: clock,
  });

  const tools = new ToolRunner({ tools: BUILTIN_TOOLS, root });
  if (approver) tools.approver = approver;

  const session = new Session({ config, client, output: captured.output, tools });
  return { transport, captured, session, tools };
}

const callFor = (name: string, args: unknown) => ({
  name,
  arguments: JSON.stringify(args),
});

describe("R10 tools are opt-in", () => {
  it("sends no tool definitions when tools are off", async () => {
    const { session, transport } = makeSession();

    expect(session.toolsEnabled).toBe(false);
    await session.ask("hello");

    expect(transport.streamCalls[0]?.tools).toBeUndefined();
  });

  it("sends tool definitions once tools are on", async () => {
    const { session, transport } = makeSession({ HETZCHAT_TOOLS: "on" });

    expect(session.toolsEnabled).toBe(true);
    await session.ask("hello");

    const names = (transport.streamCalls[0]?.tools ?? []).map(
      (spec) => (spec["function"] as { name: string }).name,
    );
    expect(names).toContain("read_file");
    expect(names).toContain("run_shell");
  });

  it("ignores tool calls the model makes while tools are off", async () => {
    const { session, transport } = makeSession();
    transport.queue({ deltas: ["ignoring that"], toolCalls: [callFor("run_shell", { command: "x" })] });

    const result = await session.ask("hello");

    expect(result.ok).toBe(true);
    expect(transport.streamCalls).toHaveLength(1);
    expect(session.conversation.history().at(-1)).toEqual({
      role: "assistant",
      content: "ignoring that",
    });
  });
});

describe("tool loop", () => {
  it("runs the tool and feeds the result back for a second response", async () => {
    const { session, transport } = makeSession({ HETZCHAT_TOOLS: "on" });
    transport.queue(
      { deltas: [""], toolCalls: [callFor("read_file", { path: "notes.txt" })] },
      { deltas: ["The file says hello."] },
    );

    const result = await session.ask("what is in notes.txt?");

    expect(result.ok).toBe(true);
    expect(result.text).toBe("The file says hello.");
    expect(transport.streamCalls).toHaveLength(2);

    const secondRequest = transport.streamCalls[1]?.messages ?? [];
    expect(secondRequest.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(secondRequest[3]?.content).toBe("the file says hello\n");
  });

  it("runs every call the model asks for in one round", async () => {
    const { session, transport } = makeSession({ HETZCHAT_TOOLS: "on" });
    transport.queue(
      {
        deltas: [""],
        toolCalls: [
          { ...callFor("read_file", { path: "notes.txt" }), id: "a" },
          { ...callFor("list_files", {}), id: "b" },
        ],
      },
      { deltas: ["done"] },
    );

    await session.ask("look around");

    const toolResults = (transport.streamCalls[1]?.messages ?? []).filter(
      (m) => m.role === "tool",
    );
    expect(toolResults.map((m) => m.tool_call_id)).toEqual(["a", "b"]);
  });

  it("feeds a refusal back to the model rather than pretending the tool ran", async () => {
    const { session, transport } = makeSession({ HETZCHAT_TOOLS: "on" }, {
      interactive: true,
      confirm: async () => false,
    });
    transport.queue(
      { deltas: [""], toolCalls: [callFor("run_shell", { command: "echo hi" })] },
      { deltas: ["Understood, I will not run that."] },
    );

    const result = await session.ask("run something");

    expect(result.ok).toBe(true);
    const toolResult = (transport.streamCalls[1]?.messages ?? []).find((m) => m.role === "tool");
    expect(toolResult?.content).toMatch(/Refused by the user/);
  });
});

describe("R12 the tool loop is bounded", () => {
  it("stops after the configured number of rounds", async () => {
    const { session, transport, captured } = makeSession({
      HETZCHAT_TOOLS: "on",
      HETZCHAT_MAX_TOOL_ROUNDS: "3",
    });
    // The model never stops asking for tools.
    const script: StreamScript = {
      deltas: [""],
      toolCalls: [callFor("read_file", { path: "notes.txt" })],
    };
    transport.queue(...Array.from({ length: 20 }, () => script));

    const result = await session.ask("loop forever");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/tool round budget/);
    // Three rounds of tool use plus the request that exhausted the budget.
    expect(transport.streamCalls).toHaveLength(4);
    expect(captured.stderr()).toMatch(/Stopped after 3 tool rounds/);
  });

  it("answers every outstanding call when it stops, so history stays valid", async () => {
    const { session, transport } = makeSession({
      HETZCHAT_TOOLS: "on",
      HETZCHAT_MAX_TOOL_ROUNDS: "1",
    });
    const script: StreamScript = {
      deltas: [""],
      toolCalls: [callFor("read_file", { path: "notes.txt" })],
    };
    transport.queue(script, script, script);

    await session.ask("loop");

    assertToolCallsAnswered(session.conversation.history());
  });
});

describe("R15 tool results stay attached to their call", () => {
  it("never sends an assistant tool call without its result", async () => {
    const { session, transport } = makeSession({ HETZCHAT_TOOLS: "on" });
    transport.queue(
      { deltas: [""], toolCalls: [{ ...callFor("read_file", { path: "notes.txt" }), id: "xyz" }] },
      { deltas: ["done"] },
    );

    await session.ask("read it");

    for (const request of transport.streamCalls) {
      assertToolCallsAnswered(request.messages);
    }
    assertToolCallsAnswered(session.conversation.history());
  });

  it("keeps a tool exchange together when history is trimmed", async () => {
    const { session, transport } = makeSession({
      HETZCHAT_TOOLS: "on",
      HETZCHAT_CONTEXT_BUDGET: "300",
    });

    for (let turn = 0; turn < 6; turn++) {
      transport.queue(
        { deltas: [""], toolCalls: [callFor("read_file", { path: "notes.txt" })] },
        { deltas: [`answer ${turn} ${"padding ".repeat(40)}`] },
      );
      await session.ask(`question ${turn} ${"padding ".repeat(40)}`);
    }

    const lastRequest = transport.streamCalls.at(-1)?.messages ?? [];
    assertToolCallsAnswered(lastRequest);
    expect(lastRequest[0]?.role).toBe("system");
    expect(lastRequest[1]?.role, "trimming left a dangling tool exchange").toBe("user");
  });
});

describe("R7 a failed tool turn is rolled back whole", () => {
  it("leaves no assistant tool call behind when the follow-up request fails", async () => {
    const { session, transport } = makeSession({ HETZCHAT_TOOLS: "on" });
    transport.queue(
      { deltas: [""], toolCalls: [callFor("read_file", { path: "notes.txt" })] },
      { error: new InferenceError("Bad Request", 400) },
    );

    const result = await session.ask("read it");

    expect(result.ok).toBe(false);
    expect(session.conversation.history()).toHaveLength(0);
  });

  it("leaves earlier turns intact", async () => {
    const { session, transport } = makeSession({ HETZCHAT_TOOLS: "on" });
    transport.queue({ deltas: ["first answer"] });
    await session.ask("first");

    transport.queue(
      { deltas: [""], toolCalls: [callFor("read_file", { path: "notes.txt" })] },
      { error: new InferenceError("Bad Request", 400) },
    );
    await session.ask("second");

    expect(session.conversation.history()).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "first answer" },
    ]);
  });
});

/**
 * R15 as a checkable property of any message list: every assistant tool call
 * is followed immediately by tool results covering exactly its call ids, in
 * order, and no tool result appears without a call to answer.
 *
 * Positional rather than set-based, because a set lets an unanswered call in a
 * later round match an answered one from an earlier round.
 */
function assertToolCallsAnswered(messages: readonly ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] as ChatMessage;

    if (message.role === "tool") {
      const previous = messages[i - 1];
      const answersSomething =
        previous !== undefined &&
        (previous.role === "tool" ||
          (previous.tool_calls ?? []).some((call) => call.id === message.tool_call_id));
      expect(answersSomething, `tool result ${message.tool_call_id} answers no call`).toBe(true);
      continue;
    }

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) continue;

    const following = messages.slice(i + 1, i + 1 + calls.length);
    expect(
      following.map((m) => m.role),
      `tool calls at index ${i} are not followed by ${calls.length} results`,
    ).toEqual(calls.map(() => "tool"));
    expect(
      following.map((m) => m.tool_call_id),
      `tool results at index ${i} do not match the call ids`,
    ).toEqual(calls.map((call) => call.id));
  }
}
