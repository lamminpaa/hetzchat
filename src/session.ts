import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { InferenceClient } from "./client/inference.js";
import { describeError } from "./client/errors.js";
import type { ChatRequest } from "./client/transport.js";
import type { Config } from "./config.js";
import { Conversation, type ContentPart } from "./conversation.js";
import type { Output } from "./cli/output.js";

export interface SessionOptions {
  config: Config;
  client: InferenceClient;
  output: Output;
}

export interface TurnResult {
  ok: boolean;
  text: string;
  error?: string;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Refuse anything the request body would choke on before we send it. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export class Session {
  readonly conversation: Conversation;
  readonly client: InferenceClient;
  readonly output: Output;

  model: string;
  temperature: number;
  maxOutputTokens: number;
  contextBudgetTokens: number;
  stream: boolean;
  thinking: boolean | undefined;
  verbose: boolean;

  /** Images attached with /image, consumed by the next message. */
  private pendingImages: ContentPart[] = [];

  constructor({ config, client, output }: SessionOptions) {
    this.conversation = new Conversation(config.systemPrompt);
    this.client = client;
    this.output = output;
    this.model = config.model;
    this.temperature = config.temperature;
    this.maxOutputTokens = config.maxOutputTokens;
    this.contextBudgetTokens = config.contextBudgetTokens;
    this.stream = config.stream;
    this.thinking = config.thinking;
    this.verbose = config.verbose;
  }

  get attachedImages(): number {
    return this.pendingImages.length;
  }

  async attachImage(path: string): Promise<void> {
    const mime = IMAGE_MIME_TYPES[extname(path).toLowerCase()];
    if (mime === undefined) {
      throw new Error(
        `Unsupported image type ${extname(path) || "(none)"}. Supported: ${Object.keys(IMAGE_MIME_TYPES).join(", ")}`,
      );
    }

    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `${path} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`,
      );
    }

    this.pendingImages.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` },
    });
  }

  clearAttachments(): void {
    this.pendingImages = [];
  }

  /**
   * One turn. On success the assistant reply is appended exactly as printed
   * (R6); on failure the user message is rolled back so the next request does
   * not carry an unanswered turn (R7).
   */
  async ask(text: string, signal?: AbortSignal): Promise<TurnResult> {
    this.conversation.addUser(this.buildContent(text));
    this.pendingImages = [];

    const trimmed = this.conversation.toRequest(this.contextBudgetTokens);

    if (this.verbose && trimmed.droppedExchanges > 0) {
      this.output.warn(
        `Context budget reached: dropped the ${trimmed.droppedExchanges} oldest exchange(s).`,
      );
    }
    if (trimmed.overBudget) {
      this.output.warn(
        "This message alone exceeds the context budget; the API may reject it.",
      );
    }

    const request: ChatRequest = {
      model: this.model,
      messages: trimmed.messages,
      temperature: this.temperature,
      maxOutputTokens: this.maxOutputTokens,
      thinking: this.thinking,
    };

    try {
      const result = this.stream
        ? await this.client.stream(request, (delta) => this.output.write(delta), signal)
        : await this.client.complete(request, signal);

      if (this.stream) {
        // Close the streamed line; the deltas carried no trailing newline.
        this.output.line();
      } else {
        this.output.line(result.text);
      }

      // R6: history stores exactly the text that was printed.
      this.conversation.addAssistant(result.text);

      if (this.verbose && result.usage) {
        this.output.meta(
          `${result.usage.promptTokens} prompt + ${result.usage.completionTokens} completion tokens`,
        );
      }
      return { ok: true, text: result.text };
    } catch (error) {
      // R7: the turn failed, so it leaves no trace in history.
      this.conversation.rollbackLastUser();

      const message = describeError(error);
      this.output.error(message);
      if (this.verbose && error instanceof Error && error.stack) {
        this.output.error(error.stack);
      }
      return { ok: false, text: "", error: message };
    }
  }

  private buildContent(text: string): string | ContentPart[] {
    if (this.pendingImages.length === 0) return text;
    return [{ type: "text", text }, ...this.pendingImages];
  }
}
