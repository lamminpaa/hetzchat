import { describe, expect, it } from "vitest";
import { isCommand, runCommand, unescapeMessage, COMMANDS } from "../../src/cli/commands.js";
import { InferenceClient } from "../../src/client/inference.js";
import { DEFAULTS, resolveConfig, TOKEN_ENV_VAR } from "../../src/config.js";
import { Session } from "../../src/session.js";
import { captureOutput } from "../helpers/captureOutput.js";
import { FakeTransport } from "../helpers/fakeTransport.js";

function makeSession() {
  const transport = new FakeTransport();
  const captured = captureOutput();
  const config = resolveConfig({ env: { [TOKEN_ENV_VAR]: "token-value-1234567890" } });
  const client = new InferenceClient({
    transport,
    requestsPerWindow: DEFAULTS.requestsPerWindow,
    rateWindowMs: DEFAULTS.rateWindowMs,
    maxAttempts: 1,
  });

  const session = new Session({ config, client, output: captured.output });
  return { transport, captured, session };
}

async function dispatch(line: string) {
  const context = makeSession();
  let exited = false;

  await runCommand(line, {
    session: context.session,
    output: context.captured.output,
    requestExit: () => void (exited = true),
  });
  return { ...context, exited };
}

describe("R5 slash commands stay local", () => {
  it("recognises a leading slash as a command", () => {
    expect(isCommand("/help")).toBe(true);
    expect(isCommand("  /help")).toBe(true);
    expect(isCommand("hello")).toBe(false);
    expect(isCommand("what about a/b")).toBe(false);
  });

  it("treats // as an escape for a message that really starts with a slash", () => {
    expect(isCommand("//usr/bin is on PATH")).toBe(false);
    expect(unescapeMessage("//usr/bin is on PATH")).toBe("/usr/bin is on PATH");
    expect(unescapeMessage("ordinary message")).toBe("ordinary message");
  });

  it("sends no chat request for any command in the registry", async () => {
    const samples = [
      "/help",
      "/model",
      "/model other-model",
      "/system",
      "/system be terse",
      "/clear",
      "/temp",
      "/temp 0.2",
      "/stream off",
      "/think on",
      "/usage",
      "/exit",
      "/nonsense",
    ];

    for (const line of samples) {
      const { transport } = await dispatch(line);
      expect(transport.streamCalls, `${line} reached the model`).toHaveLength(0);
      expect(transport.completeCalls, `${line} reached the model`).toHaveLength(0);
    }
  });

  it("keeps command text out of the conversation", async () => {
    const { session, captured } = makeSession();

    await runCommand("/system you are a pirate", {
      session,
      output: captured.output,
      requestExit: () => {},
    });

    expect(session.conversation.history()).toHaveLength(0);
    expect(session.conversation.system).toBe("you are a pirate");
  });
});

describe("command behaviour", () => {
  it("/model without an argument reports, with one switches", async () => {
    const shown = await dispatch("/model");
    expect(shown.captured.stdout().trim()).toBe(DEFAULTS.model);

    const changed = await dispatch("/model Qwen3.8-27B");
    expect(changed.session.model).toBe("Qwen3.8-27B");
  });

  it("/models asks the API and marks the current model", async () => {
    const { session, captured, transport } = makeSession();
    transport.models = ["Qwen/Qwen3.6-35B-A3B-FP8", "Qwen3.8-27B"];

    await runCommand("/models", { session, output: captured.output, requestExit: () => {} });

    expect(transport.modelsCalls).toBe(1);
    expect(captured.stdout()).toContain("Qwen3.8-27B");
    expect(captured.stdout()).toContain("(current)");
  });

  it("/clear forgets the conversation and any queued attachment", async () => {
    const { session, captured } = makeSession();
    session.conversation.addUser("q");
    session.conversation.addAssistant("a");

    await runCommand("/clear", { session, output: captured.output, requestExit: () => {} });

    expect(session.conversation.history()).toHaveLength(0);
    expect(session.attachedImages).toBe(0);
  });

  it("/temp rejects a value outside the valid range instead of sending it", async () => {
    const { session, captured } = await dispatch("/temp 9");

    expect(session.temperature).toBe(DEFAULTS.temperature);
    expect(captured.stderr()).toContain("between 0 and 2");
  });

  it("/stream and /think toggle when given no argument", async () => {
    const streamOff = await dispatch("/stream");
    expect(streamOff.session.stream).toBe(!DEFAULTS.stream);

    const thinkOn = await dispatch("/think");
    expect(thinkOn.session.showReasoning).toBe(true);
  });

  it("/exit asks the loop to stop", async () => {
    expect((await dispatch("/exit")).exited).toBe(true);
    expect((await dispatch("/quit")).exited).toBe(true);
  });

  it("names an unknown command rather than failing silently", async () => {
    const { captured } = await dispatch("/frobnicate");

    expect(captured.stderr()).toContain("/frobnicate");
    expect(captured.stderr()).toContain("/help");
  });

  it("lists every registered command in /help", async () => {
    const { captured } = await dispatch("/help");

    for (const command of COMMANDS) {
      expect(captured.stdout()).toContain(`/${command.name}`);
    }
  });
});
