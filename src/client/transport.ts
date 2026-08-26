import OpenAI from "openai";
import type { ChatMessage } from "../conversation.js";
import { parseRetryAfter, RetryableError } from "../retry.js";
import { InferenceError, statusOf } from "./errors.js";

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxOutputTokens: number;
  /** Undocumented Hetzner extension; only sent when explicitly set. */
  thinking?: boolean | undefined;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  text: string;
  usage?: Usage | undefined;
  finishReason?: string | undefined;
}

export type DeltaHandler = (delta: string) => void;

export interface Transport {
  stream(request: ChatRequest, onDelta: DeltaHandler, signal?: AbortSignal): Promise<ChatResult>;
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
    onDelta: DeltaHandler,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const body = {
      ...buildBody(request),
      stream: true as const,
      stream_options: { include_usage: true },
    };

    let text = "";
    let usage: Usage | undefined;
    let finishReason: string | undefined;

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
          onDelta(delta);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = toUsage(chunk.usage);
      }
    } catch (error) {
      throw toClientError(error);
    }

    return { text, usage, finishReason };
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
      return {
        text: choice?.message?.content ?? "",
        usage: completion.usage ? toUsage(completion.usage) : undefined,
        finishReason: choice?.finish_reason ?? undefined,
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

interface ChatChunk {
  choices?: {
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: RawUsage | null;
}

interface ChatCompletionLike {
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: RawUsage | null;
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
  if (request.thinking !== undefined) body["enable_thinking"] = request.thinking;
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
