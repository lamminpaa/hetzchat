/**
 * Incremental Markdown styling for streamed output.
 *
 * R14: rendering is chunk-invariant. The bytes written for a given response are
 * the same however the network split it into deltas, because every decision
 * depends only on the character sequence and undecidable input is withheld
 * until enough of it has arrived.
 *
 * Only constructs that are unambiguous mid-stream are styled: fenced code
 * blocks, headings, list markers, blockquotes, `code spans` and **bold**.
 * Single `*` and `_` are left alone, because they appear in ordinary prose and
 * in identifiers far more often than they mean emphasis.
 */

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
} as const;

/** Longest marker `couldBecomeMarker` accepts, "123456789)". */
const MAX_MARKER_LENGTH = 10;

/**
 * Longest line prefix withheld before a block type is known: the marker plus
 * the character that settles it. Derived rather than written down, so it
 * cannot drift away from what `couldBecomeMarker` accepts.
 */
const MAX_PREFIX_LOOKAHEAD = MAX_MARKER_LENGTH + 1;

const NEED_MORE = Symbol("need-more-input");

export class MarkdownStream {
  private buffer = "";
  private atLineStart = true;
  private inFence = false;

  // Inline state, reset at every newline: neither construct spans lines.
  private bold = false;
  private codeSpan = false;
  private heading = false;

  constructor(private readonly color: boolean) {}

  /** Styled output for the text so far; may withhold an undecidable tail. */
  push(text: string): string {
    if (!this.color) return text;
    this.buffer += text;
    return this.drain(false);
  }

  /** Styled output for whatever is still held, plus any needed reset. */
  flush(): string {
    if (!this.color) return "";
    const out = this.drain(true);
    return out + this.closeAll();
  }

  private drain(final: boolean): string {
    let out = "";

    while (this.buffer.length > 0) {
      const produced = this.atLineStart ? this.consumeLineStart(final) : this.consumeInline(final);
      if (produced === NEED_MORE) break;
      out += produced;
    }
    return out;
  }

  /**
   * Decides what kind of line is starting, consuming its marker. Returns
   * NEED_MORE when the answer depends on characters that have not arrived.
   */
  private consumeLineStart(final: boolean): string | typeof NEED_MORE {
    const indentMatch = /^[ \t]*/.exec(this.buffer) as RegExpExecArray;
    const indent = indentMatch[0];
    const rest = this.buffer.slice(indent.length);

    if (rest === "" && !final) return NEED_MORE;

    // A fence opener or closer is the only thing that matters inside a fence.
    if (this.inFence) {
      if (rest.startsWith("```")) return this.consumeFenceLine(indent, final);
      if (isPrefixOf(rest, "```") && !final) return NEED_MORE;

      this.buffer = this.buffer.slice(indent.length);
      this.atLineStart = false;
      return `${ANSI.green}${indent}`;
    }

    if (rest.startsWith("```")) return this.consumeFenceLine(indent, final);
    if (isPrefixOf(rest, "```") && !final) return NEED_MORE;

    const heading = /^(#{1,6})[ \t]/.exec(rest);
    if (heading) {
      this.buffer = rest.slice((heading[1] as string).length + 1);
      this.atLineStart = false;
      this.heading = true;
      return `${indent}${ANSI.bold}${ANSI.cyan}`;
    }

    const bullet = /^([-*+])[ \t]/.exec(rest);
    if (bullet) {
      this.buffer = rest.slice(2);
      this.atLineStart = false;
      return `${indent}${ANSI.cyan}${bullet[1] as string}${ANSI.reset} `;
    }

    const ordered = /^(\d{1,9}[.)])[ \t]/.exec(rest);
    if (ordered) {
      this.buffer = rest.slice((ordered[1] as string).length + 1);
      this.atLineStart = false;
      return `${indent}${ANSI.cyan}${ordered[1] as string}${ANSI.reset} `;
    }

    if (rest === ">" && !final) return NEED_MORE;

    const quote = /^>[ \t]?/.exec(rest);
    if (quote) {
      this.buffer = rest.slice((quote[0] as string).length);
      this.atLineStart = false;
      return `${indent}${ANSI.dim}> ${ANSI.reset}`;
    }

    // Still ambiguous only while the line could still grow into a marker.
    if (!final && rest.length < MAX_PREFIX_LOOKAHEAD && couldBecomeMarker(rest)) {
      return NEED_MORE;
    }

    this.buffer = rest;
    this.atLineStart = false;
    return indent;
  }

  /** Consumes a whole ``` line, toggling fence state. */
  private consumeFenceLine(indent: string, final: boolean): string | typeof NEED_MORE {
    const newline = this.buffer.indexOf("\n");
    if (newline === -1) {
      if (!final) return NEED_MORE;
      this.buffer = "";
      this.inFence = !this.inFence;
      return this.inFence ? "" : ANSI.reset;
    }

    this.buffer = this.buffer.slice(newline + 1);
    this.inFence = !this.inFence;
    this.atLineStart = true;
    void indent;
    // The fence markers themselves are dropped; the colour carries the meaning.
    // The last code line already emitted its own newline, so closing adds none.
    return this.inFence ? "" : ANSI.reset;
  }

  private consumeInline(final: boolean): string | typeof NEED_MORE {
    const char = this.buffer[0] as string;

    if (char === "\n") {
      this.buffer = this.buffer.slice(1);
      this.atLineStart = true;
      const closing = this.closeInline();
      return `${closing}\n${this.inFence ? ANSI.green : ""}`;
    }

    if (char === "\r") {
      this.buffer = this.buffer.slice(1);
      return "";
    }

    if (this.inFence) {
      this.buffer = this.buffer.slice(1);
      return char;
    }

    if (char === "`") {
      this.buffer = this.buffer.slice(1);
      this.codeSpan = !this.codeSpan;
      return this.codeSpan ? ANSI.yellow : `${ANSI.reset}${this.reopenInline()}`;
    }

    if (char === "*" && !this.codeSpan) {
      if (this.buffer.length < 2) {
        if (!final) return NEED_MORE;
        this.buffer = "";
        return "*";
      }
      if (this.buffer[1] === "*") {
        this.buffer = this.buffer.slice(2);
        this.bold = !this.bold;
        return this.bold ? ANSI.bold : `${ANSI.reset}${this.reopenInline()}`;
      }
      this.buffer = this.buffer.slice(1);
      return "*";
    }

    this.buffer = this.buffer.slice(1);
    return char;
  }

  /** Resets whatever inline styling is open, and forgets it. */
  private closeInline(): string {
    const open = this.bold || this.codeSpan || this.heading;
    this.bold = false;
    this.codeSpan = false;
    this.heading = false;
    return open ? ANSI.reset : "";
  }

  /**
   * Resets everything, fence colouring included. A response truncated inside a
   * code block is ordinary — max_tokens does it — and must not leave the
   * user's shell green.
   */
  private closeAll(): string {
    const inline = this.closeInline();
    if (!this.inFence) return inline;

    this.inFence = false;
    return inline === "" ? ANSI.reset : inline;
  }

  /** Re-applies styles that outlive a reset emitted for a different reason. */
  private reopenInline(): string {
    let out = "";
    if (this.heading) out += `${ANSI.bold}${ANSI.cyan}`;
    if (this.bold) out += ANSI.bold;
    if (this.codeSpan) out += ANSI.yellow;
    return out;
  }
}

function isPrefixOf(candidate: string, full: string): boolean {
  return candidate.length < full.length && full.startsWith(candidate);
}

/** True while `rest` could still turn into a block marker with more input. */
function couldBecomeMarker(rest: string): boolean {
  return (
    /^#{1,6}$/.test(rest) ||
    /^[-*+]$/.test(rest) ||
    /^\d{1,9}$/.test(rest) ||
    /^\d{1,9}[.)]$/.test(rest)
  );
}
