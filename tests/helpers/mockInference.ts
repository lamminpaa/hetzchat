import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: ChatBody | undefined;
}

export interface ChatBody {
  model?: string;
  messages?: {
    role: string;
    content: unknown;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
  }[];
  tools?: { function: { name: string } }[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  enable_thinking?: boolean;
}

export interface ScriptedToolCall {
  /** Omitted to mimic a server that does not send ids. */
  id?: string;
  name: string;
  arguments: string;
}

export type Reply =
  | { kind: "content"; deltas: string[]; usage?: { prompt: number; completion: number } }
  /**
   * A tool-calling response. When streaming, the arguments are split one
   * character per chunk, as a real server spreads them across deltas.
   */
  | { kind: "toolCall"; deltas?: string[]; calls: ScriptedToolCall[] }
  /** Closes the socket after emitting `deltas`, as a dropped connection would. */
  | { kind: "truncate"; deltas: string[] }
  | { kind: "status"; status: number; retryAfter?: string; message?: string };

/**
 * Minimal OpenAI-compatible server, enough to exercise the CLI end to end:
 * /models, streaming and non-streaming /chat/completions, and the failure
 * modes the retry and rate-limit layers exist for.
 */
export class MockInferenceServer {
  private server: Server | undefined;
  private replies: Reply[] = [];
  private fallback: Reply = { kind: "content", deltas: ["mock reply"] };

  readonly requests: RecordedRequest[] = [];
  models = ["Qwen/Qwen3.6-35B-A3B-FP8", "Qwen3.8-27B"];

  /** Chat completions only; /models calls are recorded but not scripted. */
  queue(...replies: Reply[]): this {
    this.replies.push(...replies);
    return this;
  }

  setFallback(reply: Reply): this {
    this.fallback = reply;
    return this;
  }

  get chatRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.path.endsWith("/chat/completions"));
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");

    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/api/v1`;
  }

  async stop(): Promise<void> {
    if (this.server === undefined) return;
    this.server.closeAllConnections();
    this.server.close();
    await once(this.server, "close");
    this.server = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const path = req.url ?? "";

    this.requests.push({
      method: req.method ?? "GET",
      path,
      authorization: req.headers.authorization,
      body,
    });

    if (path.endsWith("/models")) {
      respondJson(res, 200, {
        object: "list",
        data: this.models.map((id) => ({ id, object: "model", owned_by: "hetzner" })),
      });
      return;
    }

    if (!path.endsWith("/chat/completions")) {
      respondJson(res, 404, { error: { message: "no such endpoint" } });
      return;
    }

    const reply = this.replies.shift() ?? this.fallback;

    if (reply.kind === "status") {
      const headers: Record<string, string> = {};
      if (reply.retryAfter !== undefined) headers["retry-after"] = reply.retryAfter;
      respondJson(
        res,
        reply.status,
        { error: { message: reply.message ?? `mock ${reply.status}` } },
        headers,
      );
      return;
    }

    if (reply.kind === "toolCall") {
      if (body?.stream === true) await streamToolCalls(res, reply);
      else respondToolCalls(res, reply, body);
      return;
    }

    if (body?.stream === true) {
      await streamReply(res, reply);
    } else {
      respondJson(res, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: body?.model ?? "mock",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: reply.deltas.join("") },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      });
    }
  }
}

async function streamReply(
  res: ServerResponse,
  reply: Reply & { deltas: string[] },
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  for (const delta of reply.deltas) {
    res.write(`data: ${JSON.stringify(chunk({ content: delta }))}\n\n`);
  }

  if (reply.kind === "truncate") {
    // Cut the connection mid-stream, without [DONE]. The deltas must reach the
    // client first, or this would test a failure with no output rather than a
    // failure after output.
    await flush(res);
    res.destroy();
    return;
  }

  res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);

  const usage = reply.kind === "content" ? reply.usage : undefined;
  res.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 0,
      model: "mock",
      choices: [],
      usage: {
        prompt_tokens: usage?.prompt ?? 11,
        completion_tokens: usage?.completion ?? 7,
        total_tokens: (usage?.prompt ?? 11) + (usage?.completion ?? 7),
      },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

async function streamToolCalls(
  res: ServerResponse,
  reply: Reply & { kind: "toolCall" },
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  for (const delta of reply.deltas ?? []) {
    res.write(`data: ${JSON.stringify(chunk({ content: delta }))}\n\n`);
  }

  reply.calls.forEach((call, index) => {
    // The id and name arrive once, up front.
    res.write(
      `data: ${JSON.stringify(
        toolChunk([
          {
            index,
            ...(call.id === undefined ? {} : { id: call.id }),
            type: "function",
            function: { name: call.name, arguments: "" },
          },
        ]),
      )}\n\n`,
    );
    // The arguments arrive a character at a time.
    for (const char of call.arguments) {
      res.write(
        `data: ${JSON.stringify(toolChunk([{ index, function: { arguments: char } }]))}\n\n`,
      );
    }
  });

  res.write(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function respondToolCalls(
  res: ServerResponse,
  reply: Reply & { kind: "toolCall" },
  body: ChatBody | undefined,
): void {
  respondJson(res, 200, {
    id: "chatcmpl-mock",
    object: "chat.completion",
    model: body?.model ?? "mock",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: (reply.deltas ?? []).join("") || null,
          tool_calls: reply.calls.map((call) => ({
            ...(call.id === undefined ? {} : { id: call.id }),
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
}

function toolChunk(toolCalls: unknown[]) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
  };
}

function chunk(delta: { content?: string }, finishReason: string | null = null) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 0,
    model: "mock",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function respondJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<ChatBody | undefined> {
  const chunks: Buffer[] = [];
  for await (const part of req) chunks.push(part as Buffer);
  if (chunks.length === 0) return undefined;

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ChatBody;
  } catch {
    return undefined;
  }
}

/** Waits until the buffered writes have actually left the socket. */
async function flush(res: ServerResponse): Promise<void> {
  await new Promise<void>((resolve) => {
    res.write("\n", () => resolve());
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}
