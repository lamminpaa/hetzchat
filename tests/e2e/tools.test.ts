import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockInferenceServer } from "../helpers/mockInference.js";
import { runCli } from "../helpers/runCli.js";

const TOKEN = "hetzner-token-e2e-abcdef1234567890";

let server: MockInferenceServer;
let baseUrl: string;
let workspace: string;

const env = (extra: Record<string, string> = {}) => ({
  HETZNER_INFERENCE_TOKEN: TOKEN,
  HETZNER_INFERENCE_BASE_URL: baseUrl,
  ...extra,
});

beforeEach(async () => {
  server = new MockInferenceServer();
  baseUrl = await server.start();
  workspace = await mkdtemp(join(tmpdir(), "hetzchat-e2e-tools-"));
  await writeFile(join(workspace, "notes.txt"), "the file says hello\n", "utf8");
});

afterEach(async () => {
  await server.stop();
  await rm(workspace, { recursive: true, force: true });
});

const exists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("R10 tools are opt-in", () => {
  it("sends no tool definitions by default", async () => {
    server.queue({ kind: "content", deltas: ["plain answer"] });

    await runCli({ args: ["hi"], env: env(), cwd: workspace });

    expect(server.chatRequests[0]?.body).not.toHaveProperty("tools");
  });

  it("sends them once --tools is passed", async () => {
    server.queue({ kind: "content", deltas: ["plain answer"] });

    await runCli({ args: ["--tools", "hi"], env: env(), cwd: workspace });

    const names = (server.chatRequests[0]?.body?.tools ?? []).map((tool) => tool.function.name);
    expect(names).toEqual(
      expect.arrayContaining(["read_file", "list_files", "run_shell", "fetch_url"]),
    );
  });
});

describe("a read-only tool call end to end", () => {
  it("runs the tool and answers from its result", async () => {
    server.queue(
      {
        kind: "toolCall",
        calls: [{ id: "call_1", name: "read_file", arguments: '{"path":"notes.txt"}' }],
      },
      { kind: "content", deltas: ["It says hello."] },
    );

    const result = await runCli({ args: ["--tools", "what is in notes.txt?"], env: env(), cwd: workspace });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("It says hello.");
    expect(server.chatRequests).toHaveLength(2);

    const second = server.chatRequests[1]?.body?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(second[3]?.tool_call_id).toBe("call_1");
    expect(second[3]?.content).toBe("the file says hello\n");
  });

  it("reassembles tool arguments that arrived one character per chunk", async () => {
    // The mock splits arguments across deltas exactly as a real server does.
    server.queue(
      {
        kind: "toolCall",
        calls: [{ id: "call_1", name: "read_file", arguments: '{"path":"notes.txt"}' }],
      },
      { kind: "content", deltas: ["done"] },
    );

    await runCli({ args: ["--tools", "read it"], env: env(), cwd: workspace });

    const toolResult = (server.chatRequests[1]?.body?.messages ?? []).find(
      (m) => m.role === "tool",
    );
    expect(toolResult?.content, "the split arguments were not reassembled").toBe(
      "the file says hello\n",
    );
  });

  it("R13: refuses a path outside the working directory and tells the model so", async () => {
    server.queue(
      {
        kind: "toolCall",
        calls: [{ id: "call_1", name: "read_file", arguments: '{"path":"../../etc/passwd"}' }],
      },
      { kind: "content", deltas: ["I cannot read that."] },
    );

    const result = await runCli({ args: ["--tools", "read passwd"], env: env(), cwd: workspace });

    const toolResult = (server.chatRequests[1]?.body?.messages ?? []).find(
      (m) => m.role === "tool",
    );
    expect(toolResult?.content).toMatch(/outside the working directory/);
    expect(result.stdout).toContain("I cannot read that.");
  });
});

describe("R15 every call gets a distinct id, even when the server omits them", () => {
  const twiceSameTool = {
    kind: "toolCall" as const,
    calls: [
      { name: "read_file", arguments: '{"path":"notes.txt"}' },
      { name: "read_file", arguments: '{"path":"other.txt"}' },
    ],
  };

  it("does not collide two calls to the same tool in one streamed response", async () => {
    await writeFile(join(workspace, "other.txt"), "the other file\n", "utf8");
    server.queue(twiceSameTool, { kind: "content", deltas: ["read both"] });

    await runCli({ args: ["--tools", "read both"], env: env(), cwd: workspace });

    const results = (server.chatRequests[1]?.body?.messages ?? []).filter((m) => m.role === "tool");
    expect(results).toHaveLength(2);
    expect(new Set(results.map((m) => m.tool_call_id)).size, "two calls share one id").toBe(2);
    expect(results.map((m) => m.content)).toEqual(["the file says hello\n", "the other file\n"]);
  });

  it("does not collide them in a non-streamed response either", async () => {
    await writeFile(join(workspace, "other.txt"), "the other file\n", "utf8");
    server.queue(twiceSameTool, { kind: "content", deltas: ["read both"] });

    await runCli({
      args: ["--tools", "--no-stream", "read both"],
      env: env(),
      cwd: workspace,
    });

    const results = (server.chatRequests[1]?.body?.messages ?? []).filter((m) => m.role === "tool");
    expect(results).toHaveLength(2);
    expect(new Set(results.map((m) => m.tool_call_id)).size, "two calls share one id").toBe(2);
  });
});

describe("R11 a side-effecting tool needs authorisation", () => {
  const touchPwned = {
    kind: "toolCall" as const,
    calls: [{ id: "call_1", name: "run_shell", arguments: '{"command":"touch pwned.txt"}' }],
  };

  it("refuses in single-shot mode, where there is nobody to ask", async () => {
    server.queue(touchPwned, { kind: "content", deltas: ["I was not allowed to."] });

    await runCli({ args: ["--tools", "make a file"], env: env(), cwd: workspace });

    expect(await exists(join(workspace, "pwned.txt")), "the command ran unasked").toBe(false);

    const toolResult = (server.chatRequests[1]?.body?.messages ?? []).find(
      (m) => m.role === "tool",
    );
    expect(toolResult?.content).toMatch(/no terminal to ask|--allow-tool/);
  });

  it("runs it when the tool was named with --allow-tool", async () => {
    server.queue(touchPwned, { kind: "content", deltas: ["Created it."] });

    await runCli({
      args: ["--allow-tool", "run_shell", "make a file"],
      env: env(),
      cwd: workspace,
    });

    expect(await exists(join(workspace, "pwned.txt"))).toBe(true);
  });

  it("does not run it when a different tool was allowed", async () => {
    server.queue(touchPwned, { kind: "content", deltas: ["I was not allowed to."] });

    await runCli({
      args: ["--allow-tool", "fetch_url", "make a file"],
      env: env(),
      cwd: workspace,
    });

    expect(await exists(join(workspace, "pwned.txt"))).toBe(false);
  });

  it("runs it when the user answers yes in a session", async () => {
    server.queue(touchPwned, { kind: "content", deltas: ["Created it."] });

    const result = await runCli({
      args: ["-i", "--tools"],
      stdin: "make a file\ny\n/exit\n",
      env: env(),
      cwd: workspace,
    });

    expect(result.stderr).toContain("run_shell wants to");
    expect(await exists(join(workspace, "pwned.txt"))).toBe(true);
  });

  it("does not run it when the user answers no", async () => {
    server.queue(touchPwned, { kind: "content", deltas: ["Understood."] });

    const result = await runCli({
      args: ["-i", "--tools"],
      stdin: "make a file\nn\n/exit\n",
      env: env(),
      cwd: workspace,
    });

    expect(await exists(join(workspace, "pwned.txt")), "a refused command ran").toBe(false);

    const toolResult = (server.chatRequests[1]?.body?.messages ?? []).find(
      (m) => m.role === "tool",
    );
    expect(toolResult?.content).toMatch(/Refused by the user/);
    expect(result.stdout).toContain("Understood.");
  });

  it("treats anything other than yes as no", async () => {
    server.queue(touchPwned, { kind: "content", deltas: ["Understood."] });

    await runCli({
      args: ["-i", "--tools"],
      stdin: "make a file\nmaybe later\n/exit\n",
      env: env(),
      cwd: workspace,
    });

    expect(await exists(join(workspace, "pwned.txt"))).toBe(false);
  });

  it("says which line it read as the answer, so a piped turn is not silently eaten", async () => {
    server.queue(touchPwned, { kind: "content", deltas: ["Understood."] });

    const result = await runCli({
      args: ["-i", "--tools"],
      stdin: "make a file\nmy actual next question\n/exit\n",
      env: env(),
      cwd: workspace,
    });

    // The line was consumed as the y/N answer rather than sent to the model.
    // That is unavoidable on a pipe, but it must not happen invisibly.
    expect(result.stdout).toContain("Answered: my actual next question");
    expect(result.stderr).toContain('Read "my actual next question" as no');
  });
});

describe("fetch_url is bounded", () => {
  it("stops reading a response that never ends, instead of hanging or filling memory", async () => {
    // A server that streams for as long as anyone will listen.
    const firehose = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const pump = (): void => {
        if (res.writableEnded) return;
        if (res.write("x".repeat(64 * 1024))) setImmediate(pump);
        else res.once("drain", pump);
      };
      pump();
    });
    firehose.listen(0, "127.0.0.1");
    await once(firehose, "listening");
    const { port } = firehose.address() as AddressInfo;

    try {
      server.queue(
        {
          kind: "toolCall",
          calls: [
            {
              id: "call_1",
              name: "fetch_url",
              arguments: JSON.stringify({ url: `http://127.0.0.1:${port}/` }),
            },
          ],
        },
        { kind: "content", deltas: ["that was a lot"] },
      );

      const startedAt = Date.now();
      const result = await runCli({
        args: ["--allow-tool", "fetch_url", "fetch it"],
        env: env(),
        cwd: workspace,
        timeoutMs: 60_000,
      });
      const elapsed = Date.now() - startedAt;

      expect(result.code).toBe(0);

      // The byte cap is what has to stop this. Without it the read runs until
      // the request timeout, buffering the whole time, so the giveaway is how
      // long the turn took rather than how much text came back.
      expect(elapsed, "the read was not stopped by the byte cap").toBeLessThan(10_000);

      const toolResult = (server.chatRequests[1]?.body?.messages ?? []).find(
        (m) => m.role === "tool",
      );
      expect(toolResult?.content).toBeDefined();
      expect((toolResult?.content as string).length).toBeLessThan(20_000);
    } finally {
      firehose.closeAllConnections();
      firehose.close();
      await once(firehose, "close");
    }
  });
});

describe("R12 the tool loop is bounded", () => {
  it("stops after the configured rounds instead of looping on the API", async () => {
    server.setFallback({
      kind: "toolCall",
      calls: [{ id: "call_x", name: "list_files", arguments: "{}" }],
    });

    const result = await runCli({
      args: ["--tools", "keep going"],
      env: env({ HETZCHAT_MAX_TOOL_ROUNDS: "2" }),
      cwd: workspace,
    });

    expect(result.code).toBe(1);
    // Two rounds of tool use plus the request that exhausted the budget.
    expect(server.chatRequests).toHaveLength(3);
    expect(result.stderr).toMatch(/Stopped after 2 tool rounds/);
  });
});
