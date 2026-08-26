import { MarkdownStream } from "./markdown.js";
import type { Redactor } from "../redact.js";

/**
 * R4: the single place anything reaches the terminal. Every string passes the
 * redactor here, so a token that leaked into an upstream error message is
 * still blinded on the way out.
 */

export interface Writable {
  write(chunk: string): unknown;
}

export interface OutputOptions {
  stdout: Writable;
  stderr: Writable;
  redact: Redactor;
  color: boolean;
  /** Style the model's Markdown as it streams. Off implies raw passthrough. */
  markdown?: boolean;
}

/**
 * The chat template puts newlines between the reasoning block and the answer,
 * so every response arrives with leading whitespace. Display and history apply
 * this same rule, so R6 — what you saw is what the model is told it said —
 * still holds.
 */
export function stripLeadingBlank(text: string): string {
  return text.replace(/^\s+/, "");
}

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
} as const;

export class Output {
  private stream: MarkdownStream | undefined;
  private streamWrote = false;
  private reasoningOpen = false;
  private answerStarted = false;

  constructor(private readonly options: OutputOptions) {}

  /** Starts a model response. Styling state is per response, not per session. */
  beginStream(): void {
    this.stream = new MarkdownStream(this.options.color && this.options.markdown !== false);
    this.streamWrote = false;
    this.reasoningOpen = false;
    this.answerStarted = false;
  }

  /**
   * The model's chain of thought, which arrives before the answer. Written raw
   * and dimmed rather than through the Markdown renderer: it is a scratchpad,
   * not a document, and feeding it in would carry its half-finished fences
   * into the answer's rendering state.
   */
  writeReasoning(delta: string): void {
    if (!this.reasoningOpen) {
      this.reasoningOpen = true;
      this.streamWrote = true;
      this.options.stdout.write(this.paint("thinking", ANSI.dim + ANSI.cyan) + "\n");
    }
    this.options.stdout.write(this.options.redact(this.paint(delta, ANSI.dim)));
  }

  /** One delta from the model, styled if styling is on. */
  writeDelta(delta: string): void {
    let text = delta;

    if (!this.answerStarted) {
      text = stripLeadingBlank(text);
      // Still nothing but whitespace: the answer has not really begun.
      if (text === "") return;
      this.answerStarted = true;
    }

    // The answer has started; close the reasoning block first.
    if (this.reasoningOpen) {
      this.reasoningOpen = false;
      this.options.stdout.write("\n\n");
    }
    this.streamWrote = true;
    this.write(this.stream?.push(text) ?? text);
  }

  /**
   * Ends a model response: emits whatever the renderer withheld and closes the
   * line. Safe to call on the failure path, where held characters would
   * otherwise be lost.
   */
  endStream(): void {
    if (this.stream !== undefined) {
      this.write(this.stream.flush());
      this.stream = undefined;
    }
    // A turn that only called tools printed nothing; do not open a blank line.
    if (this.streamWrote) this.line();
    this.streamWrote = false;
    this.reasoningOpen = false;
    this.answerStarted = false;
  }

  /** A whole response that did not arrive as a stream. */
  block(text: string): void {
    this.beginStream();
    this.writeDelta(text);
    this.endStream();
  }

  /** Streaming body text, written without a trailing newline. */
  write(text: string): void {
    this.options.stdout.write(this.options.redact(text));
  }

  line(text = ""): void {
    this.options.stdout.write(`${this.options.redact(text)}\n`);
  }

  /** Framing around the model's answer: prompts, labels, hints. */
  meta(text: string): void {
    this.line(this.paint(text, ANSI.dim));
  }

  heading(text: string): void {
    this.line(this.paint(text, ANSI.bold + ANSI.cyan));
  }

  warn(text: string): void {
    this.options.stderr.write(`${this.options.redact(this.paint(text, ANSI.yellow))}\n`);
  }

  error(text: string): void {
    this.options.stderr.write(`${this.options.redact(this.paint(text, ANSI.red))}\n`);
  }

  private paint(text: string, code: string): string {
    return this.options.color ? `${code}${text}${ANSI.reset}` : text;
  }
}
