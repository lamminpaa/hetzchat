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

  constructor(private readonly options: OutputOptions) {}

  /** Starts a model response. Styling state is per response, not per session. */
  beginStream(): void {
    this.stream = new MarkdownStream(this.options.color && this.options.markdown !== false);
  }

  /** One delta from the model, styled if styling is on. */
  writeDelta(delta: string): void {
    this.write(this.stream?.push(delta) ?? delta);
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
    this.line();
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
