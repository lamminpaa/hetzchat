import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockInferenceServer } from "../helpers/mockInference.js";
import { runCli } from "../helpers/runCli.js";

const TOKEN = "hetzner-token-e2e-abcdef1234567890";

let server: MockInferenceServer;
let baseUrl: string;

const env = (extra: Record<string, string> = {}) => ({
  HETZNER_INFERENCE_TOKEN: TOKEN,
  HETZNER_INFERENCE_BASE_URL: baseUrl,
  ...extra,
});

beforeEach(async () => {
  server = new MockInferenceServer();
  baseUrl = await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe("single-shot mode", () => {
  it("answers a prompt given as an argument and exits cleanly", async () => {
    server.queue({ kind: "content", deltas: ["Berlin", " is", " the", " capital."] });

    const result = await runCli({ args: ["What is the capital of Germany?"], env: env() });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("Berlin is the capital.\n");
    expect(server.chatRequests).toHaveLength(1);
  });

  it("reads the prompt from piped stdin", async () => {
    server.queue({ kind: "content", deltas: ["piped answer"] });

    const result = await runCli({ stdin: "a question from a pipe\n", env: env() });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("piped answer\n");
    expect(server.chatRequests[0]?.body?.messages?.at(-1)?.content).toBe(
      "a question from a pipe",
    );
  });

  it("sends the token as a bearer credential", async () => {
    server.queue({ kind: "content", deltas: ["ok"] });

    await runCli({ args: ["hi"], env: env() });

    expect(server.chatRequests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("honours --no-stream by asking for a whole response", async () => {
    server.queue({ kind: "content", deltas: ["one shot answer"] });

    const result = await runCli({ args: ["--no-stream", "hi"], env: env() });

    expect(result.stdout).toBe("one shot answer\n");
    expect(server.chatRequests[0]?.body?.stream).toBe(false);
  });

  it("passes model, temperature and output cap through to the request", async () => {
    server.queue({ kind: "content", deltas: ["ok"] });

    await runCli({
      args: ["-m", "Qwen3.8-27B", "-t", "0.1", "--max-output-tokens", "128", "hi"],
      env: env(),
    });

    const body = server.chatRequests[0]?.body;
    expect(body?.model).toBe("Qwen3.8-27B");
    expect(body?.temperature).toBe(0.1);
    expect(body?.max_tokens).toBe(128);
  });

  it("only sends the thinking extension when it is asked for", async () => {
    server.queue({ kind: "content", deltas: ["ok"] }, { kind: "content", deltas: ["ok"] });

    await runCli({ args: ["hi"], env: env() });
    expect(server.chatRequests[0]?.body).not.toHaveProperty("enable_thinking");

    await runCli({ args: ["--think", "hi"], env: env() });
    expect(server.chatRequests[1]?.body?.enable_thinking).toBe(true);
  });
});

describe("R8 configuration and startup", () => {
  it("exits non-zero and names the variable when the token is missing", async () => {
    const result = await runCli({
      args: ["hi"],
      env: { HETZNER_INFERENCE_TOKEN: undefined, HETZNER_INFERENCE_BASE_URL: baseUrl },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HETZNER_INFERENCE_TOKEN");
    expect(server.chatRequests).toHaveLength(0);
  });

  it("rejects contradictory flags with a usage error", async () => {
    const result = await runCli({ args: ["--stream", "--no-stream", "hi"], env: env() });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("contradict");
  });

  it("prints help without calling the API", async () => {
    const result = await runCli({ args: ["--help"], env: env() });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hetzchat");
    expect(server.requests).toHaveLength(0);
  });
});

describe("R4 the token never reaches the terminal", () => {
  it("keeps the token out of an authentication failure", async () => {
    server.queue({ kind: "status", status: 401, message: `bad token ${TOKEN}` });

    const result = await runCli({ args: ["-v", "hi"], env: env() });

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stderr).not.toContain(TOKEN);
    expect(result.stderr).toContain("[redacted]");
  });

  it("keeps the token out of verbose output on a successful run", async () => {
    server.queue({ kind: "content", deltas: ["ok"] });

    const result = await runCli({ args: ["-v", "hi"], env: env() });

    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stderr).not.toContain(TOKEN);
  });
});

describe("R2 retry behaviour against a real 429", () => {
  it("retries after Retry-After and then succeeds", async () => {
    server.queue(
      { kind: "status", status: 429, retryAfter: "1" },
      { kind: "content", deltas: ["answered on the retry"] },
    );

    const result = await runCli({ args: ["-v", "hi"], env: env() });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("answered on the retry");
    expect(server.chatRequests).toHaveLength(2);
    expect(result.stderr).toContain("retrying");
  });

  it("gives up after the attempt budget rather than hammering the API", async () => {
    server.setFallback({ kind: "status", status: 429, retryAfter: "0" });

    const result = await runCli({
      args: ["hi"],
      env: env({ HETZCHAT_MAX_ATTEMPTS: "3" }),
    });

    expect(result.code).toBe(1);
    expect(server.chatRequests).toHaveLength(3);
    expect(result.stderr).toContain("429");
  });

  it("does not retry a request the server called invalid", async () => {
    server.setFallback({ kind: "status", status: 400, message: "unknown model" });

    const result = await runCli({ args: ["hi"], env: env() });

    expect(result.code).toBe(1);
    expect(server.chatRequests).toHaveLength(1);
  });
});

describe("R9 a stream cut short is not replayed", () => {
  it("keeps the partial answer and does not print it twice", async () => {
    server.setFallback({ kind: "truncate", deltas: ["The answer begins here"] });

    const result = await runCli({ args: ["hi"], env: env() });

    expect(result.code).toBe(1);
    expect(server.chatRequests).toHaveLength(1);
    expect(result.stdout.match(/The answer begins here/g)).toHaveLength(1);
    expect(result.stderr).toContain("cut off");
  });
});

describe("interactive session", () => {
  it("holds a multi-turn conversation and carries history forward", async () => {
    server.queue(
      { kind: "content", deltas: ["Helsinki."] },
      { kind: "content", deltas: ["About 660,000."] },
    );

    const result = await runCli({
      args: ["-i"],
      stdin: "What is the capital of Finland?\nHow many people live there?\n/exit\n",
      env: env(),
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Helsinki.");
    expect(result.stdout).toContain("About 660,000.");

    const second = server.chatRequests[1]?.body?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(second[2]?.content).toBe("Helsinki.");
  });

  it("R5: runs slash commands locally without sending them to the model", async () => {
    const result = await runCli({
      args: ["-i"],
      stdin: "/help\n/model\n/temp 0.3\n/usage\n/clear\n/exit\n",
      env: env(),
    });

    expect(result.code).toBe(0);
    expect(server.chatRequests, "a command was sent to the model").toHaveLength(0);
    expect(result.stdout).toContain("/help");
  });

  it("R5: // escapes a message that genuinely starts with a slash", async () => {
    server.queue({ kind: "content", deltas: ["That is a path."] });

    const result = await runCli({
      args: ["-i"],
      stdin: "//usr/bin is on my PATH\n/exit\n",
      env: env(),
    });

    expect(server.chatRequests).toHaveLength(1);
    expect(server.chatRequests[0]?.body?.messages?.at(-1)?.content).toBe(
      "/usr/bin is on my PATH",
    );
    expect(result.stdout).toContain("That is a path.");
  });

  it("/models asks the API and lists what it serves", async () => {
    const result = await runCli({ args: ["-i"], stdin: "/models\n/exit\n", env: env() });

    expect(result.stdout).toContain("Qwen3.8-27B");
    expect(server.requests.some((r) => r.path.endsWith("/models"))).toBe(true);
    expect(server.chatRequests).toHaveLength(0);
  });

  it("R7: a failed turn does not poison the next one", async () => {
    server.queue(
      { kind: "status", status: 400, message: "nope" },
      { kind: "content", deltas: ["second turn worked"] },
    );

    const result = await runCli({
      args: ["-i"],
      stdin: "this one fails\nthis one works\n/exit\n",
      env: env(),
    });

    expect(result.stdout).toContain("second turn worked");

    const second = server.chatRequests[1]?.body?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(["system", "user"]);
    expect(second[1]?.content).toBe("this one works");
  });

  it("/system replaces the prompt sent with the next message", async () => {
    server.queue({ kind: "content", deltas: ["Arr."] });

    await runCli({
      args: ["-i"],
      stdin: "/system You are a pirate.\nhello\n/exit\n",
      env: env(),
    });

    expect(server.chatRequests[0]?.body?.messages?.[0]).toEqual({
      role: "system",
      content: "You are a pirate.",
    });
  });

  it("/clear drops the history from later requests", async () => {
    server.setFallback({ kind: "content", deltas: ["ok"] });

    await runCli({
      args: ["-i"],
      stdin: "first\n/clear\nsecond\n/exit\n",
      env: env(),
    });

    const second = server.chatRequests[1]?.body?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(["system", "user"]);
    expect(second[1]?.content).toBe("second");
  });

  it("leaves on end of input without needing /exit", async () => {
    server.setFallback({ kind: "content", deltas: ["bye"] });

    const result = await runCli({ args: ["-i"], stdin: "one question\n", env: env() });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("bye");
  });
});
