import OpenAI from "openai";
import type { ChatMessage, ToolCallMessage } from "../conversation.js";
import { parseRetryAfter, RetryableError } from "../retry.js";
import { InferenceError, statusOf } from "./errors.js";

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxOutputTokens: number;
  /** R10: absent unless tools are switched on. */
  tools?: Record<string, unknown>[] | undefined;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  text: string;
  /**
   * The models always return a separate reasoning stream alongside the answer.
   * It is not part of the assistant's message and is never stored in history.
   */
  reasoning?: string | undefined;
  usage?: Usage | undefined;
  finishReason?: string | undefined;
  toolCalls?: ToolCallMessage[] | undefined;
}

export type DeltaHandler = (delta: string) => void;

export interface StreamHandlers {
  onContent: DeltaHandler;
  onReasoning?: DeltaHandler | undefined;
}

export interface Transport {
  stream(
    request: ChatRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<ChatResult>;
  complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
  listModels(signal?: AbortSignal): Promise<string[]>;
}

export interface OpenAITransportOptions {
  baseUrl: string;
  apiKey: string;
}

export class OpenAITransport implements Transport {
  private readonly client: OpenAI;

  constructor({ baseUrl, apiKey }: OpenAITransportOptions) {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      // Retries and rate limiting live in InferenceClient, where they can see
      // the sliding window and whether a stream already printed output.
      maxRetries: 0,
    });
  }

  async stream(
    request: ChatRequest,
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const body = {
      ...buildBody(request),
      stream: true as const,
      stream_options: { include_usage: true },
    };

    let text = "";
    let reasoning = "";
    let usage: Usage | undefined;
    let finishReason: string | undefined;
    const toolCalls = new ToolCallAccumulator();

    try {
      const stream = await this.client.chat.completions.create(
        body as Parameters<typeof this.client.chat.completions.create>[0],
        signal ? { signal } : {},
      );

      for await (const chunk of stream as AsyncIterable<ChatChunk>) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;

        if (typeof delta === "string" && delta.length > 0) {
          text += delta;
          handlers.onContent(delta);
        }

        const thought = choice?.delta?.reasoning;
        if (typeof thought === "string" && thought.length > 0) {
          reasoning += thought;
          handlers.onReasoning?.(thought);
        }
        for (const partial of choice?.delta?.tool_calls ?? []) toolCalls.add(partial);

        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = toUsage(chunk.usage);
      }
    } catch (error) {
      throw toClientError(error);
    }

    return {
      text,
      reasoning: reasoning === "" ? undefined : reasoning,
      usage,
      finishReason,
      toolCalls: toolCalls.result(),
    };
  }

  async complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    try {
      const response = await this.client.chat.completions.create(
        { ...buildBody(request), stream: false } as Parameters<
          typeof this.client.chat.completions.create
        >[0],
        signal ? { signal } : {},
      );

      const completion = response as ChatCompletionLike;
      const choice = completion.choices?.[0];
      const calls = (choice?.message?.tool_calls ?? [])
        .map((call, index) =>
          toToolCall(call.id ?? `call_${index}`, call.function?.name, call.function?.arguments),
        )
        .filter((call): call is ToolCallMessage => call !== undefined);

      return {
        text: choice?.message?.content ?? "",
        reasoning: choice?.message?.reasoning ?? undefined,
        usage: completion.usage ? toUsage(completion.usage) : undefined,
        finishReason: choice?.finish_reason ?? undefined,
        toolCalls: calls.length > 0 ? calls : undefined,
      };
    } catch (error) {
      throw toClientError(error);
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    try {
      const response = await this.client.models.list(signal ? { signal } : {});
      return response.data.map((model) => model.id).sort();
    } catch (error) {
      throw toClientError(error);
    }
  }
}

interface RawToolCallDelta {
  index?: number;
  id?: string | null;
  function?: { name?: string | null; arguments?: string | null } | null;
}

interface ChatChunk {
  choices?: {
    delta?: {
      content?: string | null;
      /** Hetzner's models stream their chain of thought here. */
      reasoning?: string | null;
      tool_calls?: RawToolCallDelta[] | null;
    };
    finish_reason?: string | null;
  }[];
  usage?: RawUsage | null;
}

interface ChatCompletionLike {
  choices?: {
    message?: {
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: { id?: string | null; function?: { name?: string | null; arguments?: string | null } | null }[] | null;
    };
    finish_reason?: string | null;
  }[];
  usage?: RawUsage | null;
}

/**
 * Tool calls arrive spread across chunks: the id and name come once, the
 * arguments in pieces, all keyed by position in the call list.
 */
class ToolCallAccumulator {
  private readonly parts = new Map<number, { id: string; name: string; args: string }>();

  add(delta: RawToolCallDelta): void {
    const index = delta.index ?? 0;
    const current = this.parts.get(index) ?? { id: "", name: "", args: "" };

    if (delta.id) current.id = delta.id;
    if (delta.function?.name) current.name += delta.function.name;
    if (delta.function?.arguments) current.args += delta.function.arguments;

    this.parts.set(index, current);
  }

  result(): ToolCallMessage[] | undefined {
    if (this.parts.size === 0) return undefined;

    const calls = [...this.parts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, part]) => toToolCall(part.id || `call_${index}`, part.name, part.args))
      .filter((call): call is ToolCallMessage => call !== undefined);

    return calls.length > 0 ? calls : undefined;
  }
}

/**
 * `id` must already be unique. Callers supply a positional fallback, never one
 * keyed on the tool name: a response calling the same tool twice would then
 * produce two results sharing a tool_call_id, breaking R15.
 */
function toToolCall(
  id: string,
  name: string | null | undefined,
  args: string | null | undefined,
): ToolCallMessage | undefined {
  if (!name) return undefined;
  return {
    id,
    type: "function",
    function: { name, arguments: args ?? "" },
  };
}

interface RawUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
}

function buildBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    max_tokens: request.maxOutputTokens,
  };
  // Deliberately no enable_thinking: the served models ignore it and stream
  // their reasoning regardless, so sending it would only imply it does something.
  // R10: the key is absent, not empty, when tools are off.
  if (request.tools !== undefined && request.tools.length > 0) body["tools"] = request.tools;
  return body;
}

function toUsage(raw: RawUsage): Usage {
  return {
    promptTokens: raw.prompt_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
  };
}

/**
 * Normalises SDK errors so the retry layer sees a Retry-After it can honour
 * (R2) without knowing anything about the OpenAI SDK's error shape.
 */
function toClientError(error: unknown): unknown {
  const status = statusOf(error);
  if (status === undefined) return error;

  const message = error instanceof Error ? error.message : String(error);

  if (status === 429 || status >= 500 || status === 408 || status === 409) {
    const retryAfterMs = parseRetryAfter(headerOf(error, "retry-after"), Date.now());
    return new RetryableError(message, status, retryAfterMs, error);
  }
  return new InferenceError(message, status, error);
}

function headerOf(error: unknown, name: string): string | undefined {
  if (typeof error !== "object" || error === null || !("headers" in error)) return undefined;
  const headers = (error as { headers: unknown }).headers;
  if (headers == null) return undefined;

  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const record = headers as Record<string, unknown>;
  const value = record[name] ?? record[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}
