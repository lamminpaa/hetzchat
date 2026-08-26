import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { InferenceClient } from "./client/inference.js";
import { describeError } from "./client/errors.js";
import type { ChatRequest, ChatResult } from "./client/transport.js";
import type { Config } from "./config.js";
import { Conversation, type ContentPart } from "./conversation.js";
import type { ToolRunner } from "./tools/runner.js";
import { stripLeadingBlank, type Output } from "./cli/output.js";

export interface SessionOptions {
  config: Config;
  client: InferenceClient;
  output: Output;
  /** Absent when the build has no tools wired in; tools stay off either way. */
  tools?: ToolRunner | undefined;
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
  readonly tools: ToolRunner | undefined;

  model: string;
  temperature: number;
  maxOutputTokens: number;
  contextBudgetTokens: number;
  stream: boolean;
  /** Show the model's chain of thought, which it always produces. */
  showReasoning: boolean;
  verbose: boolean;
  toolsEnabled: boolean;
  maxToolRounds: number;

  /** Images attached with /image, consumed by the next message. */
  private pendingImages: ContentPart[] = [];

  constructor({ config, client, output, tools }: SessionOptions) {
    this.conversation = new Conversation(config.systemPrompt);
    this.client = client;
    this.output = output;
    this.tools = tools;
    this.model = config.model;
    this.temperature = config.temperature;
    this.maxOutputTokens = config.maxOutputTokens;
    this.contextBudgetTokens = config.contextBudgetTokens;
    this.stream = config.stream;
    this.showReasoning = config.showReasoning;
    this.verbose = config.verbose;
    this.toolsEnabled = config.tools && tools !== undefined;
    this.maxToolRounds = config.maxToolRounds;
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
   * One turn, which may span several requests when the model calls tools.
   *
   * On success the assistant reply is stored exactly as printed (R6); on
   * failure the whole turn is rolled back, so no assistant tool call is left
   * without its result (R7, R15).
   */
  async ask(text: string, signal?: AbortSignal): Promise<TurnResult> {
    this.conversation.addUser(this.buildContent(text));
    this.pendingImages = [];

    try {
      return await this.runTurn(signal);
    } catch (error) {
      // Whatever the renderer withheld is still the model's output; show it
      // rather than dropping it because the turn failed.
      if (this.stream) this.output.endStream();

      this.conversation.rollbackTurn();

      const message = describeError(error);
      this.output.error(message);
      if (this.verbose && error instanceof Error && error.stack) {
        this.output.error(error.stack);
      }
      return { ok: false, text: "", error: message };
    }
  }

  private async runTurn(signal?: AbortSignal): Promise<TurnResult> {
    for (let round = 0; ; round++) {
      const result = await this.requestOnce(signal);
      const calls = result.toolCalls ?? [];

      if (calls.length === 0 || !this.toolsEnabled || this.tools === undefined) {
        // R6: the same rule the display applied, so history matches the screen.
        const answer = stripLeadingBlank(result.text);
        this.conversation.addAssistant(answer);
        return { ok: true, text: answer };
      }

      this.conversation.addAssistantToolCalls(stripLeadingBlank(result.text), calls);

      // R12: the budget is spent. Every call still gets an answer, so history
      // stays valid (R15) and the model is told why it stopped.
      if (round >= this.maxToolRounds) {
        const reason = `Not run: this turn's budget of ${this.maxToolRounds} tool rounds is spent.`;
        for (const call of calls) this.conversation.addToolResult(call.id, reason);

        this.output.warn(
          `Stopped after ${this.maxToolRounds} tool rounds. Ask again to continue.`,
        );
        return { ok: false, text: result.text, error: "tool round budget exhausted" };
      }

      for (const call of calls) {
        const outcome = await this.tools.execute(
          { id: call.id, name: call.function.name, arguments: call.function.arguments },
          signal,
        );
        this.conversation.addToolResult(outcome.id, outcome.content);
      }
    }
  }

  private async requestOnce(signal?: AbortSignal): Promise<ChatResult> {
    const trimmed = this.conversation.toRequest(this.contextBudgetTokens);

    if (this.verbose && trimmed.droppedExchanges > 0) {
      this.output.warn(
        `Context budget reached: dropped the ${trimmed.droppedExchanges} oldest exchange(s).`,
      );
    }
    if (trimmed.overBudget) {
      this.output.warn("This message alone exceeds the context budget; the API may reject it.");
    }

    const request: ChatRequest = {
      model: this.model,
      messages: trimmed.messages,
      temperature: this.temperature,
      maxOutputTokens: this.maxOutputTokens,
      // R10: undefined, not an empty array, when tools are off.
      tools: this.toolsEnabled ? this.tools?.specifications() : undefined,
    };

    if (this.stream) this.output.beginStream();

    const result = this.stream
      ? await this.client.stream(
          request,
          {
            onContent: (delta) => this.output.writeDelta(delta),
            ...(this.showReasoning
              ? { onReasoning: (delta: string) => this.output.writeReasoning(delta) }
              : {}),
          },
          signal,
        )
      : await this.client.complete(request, signal);

    if (this.stream) {
      // Flushes anything the Markdown renderer withheld, then closes the line.
      this.output.endStream();
    } else if (stripLeadingBlank(result.text) !== "") {
      this.output.block(result.text);
    }

    if (!this.stream && this.showReasoning && result.reasoning !== undefined) {
      this.output.meta(`thinking\n${result.reasoning}`);
    }

    this.warnIfBudgetWentToReasoning(result);

    if (this.verbose && result.usage) {
      const reasoned = result.reasoning?.length ?? 0;
      this.output.meta(
        `${result.usage.promptTokens} prompt + ${result.usage.completionTokens} completion tokens` +
          (reasoned > 0 ? `, ${reasoned} characters of it reasoning` : ""),
      );
    }
    return result;
  }

  /**
   * The models reason before answering and that reasoning is charged against
   * max_tokens, so a low cap can consume the entire budget and return nothing.
   * Without this the user just sees an empty answer.
   */
  private warnIfBudgetWentToReasoning(result: ChatResult): void {
    if (result.finishReason !== "length" || result.text !== "") return;

    this.output.warn(
      `The model used all ${this.maxOutputTokens} output tokens thinking and never got to an answer. ` +
        `Raise the cap with --max-output-tokens${this.showReasoning ? "" : ", or see where they went with /think on"}.`,
    );
  }

  private buildContent(text: string): string | ContentPart[] {
    if (this.pendingImages.length === 0) return text;
    return [{ type: "text", text }, ...this.pendingImages];
  }
}
