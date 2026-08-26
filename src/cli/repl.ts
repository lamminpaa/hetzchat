import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";
import { isCommand, runCommand, unescapeMessage } from "./commands.js";
import type { Output, Writable } from "./output.js";
import type { Session } from "../session.js";

export interface ReplOptions {
  session: Session;
  output: Output;
  input: Readable;
  /** Where readline echoes the prompt; separate from Output, which redacts. */
  promptStream: Writable & NodeJS.WritableStream;
  terminal: boolean;
}

const PROMPT = "> ";

/**
 * Lines buffered between readline and the loop.
 *
 * readline's own async iterator drops lines that were already buffered when
 * the input stream ends, which loses every turn after the first on a pipe.
 * Queueing the `line` events keeps piped and interactive input equivalent.
 */
class LineQueue {
  private readonly pending: string[] = [];
  private waiting: ((line: string | undefined) => void) | undefined;
  private closed = false;

  push(line: string): void {
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(line);
      return;
    }
    this.pending.push(line);
  }

  close(): void {
    this.closed = true;
    if (this.waiting !== undefined) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(undefined);
    }
  }

  /** Resolves to the next line, or undefined once input is exhausted. */
  next(): Promise<string | undefined> {
    const buffered = this.pending.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(undefined);

    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

export async function runRepl({
  session,
  output,
  input,
  promptStream,
  terminal,
}: ReplOptions): Promise<number> {
  const rl: Interface = createInterface({
    input,
    output: promptStream,
    prompt: PROMPT,
    terminal,
  });

  const queue = new LineQueue();
  let exiting = false;
  let closed = false;
  let inFlight: AbortController | undefined;

  rl.on("line", (line) => queue.push(line));
  rl.on("close", () => {
    closed = true;
    queue.close();
  });

  rl.on("SIGINT", () => {
    if (inFlight !== undefined) {
      // A request is running: cancel the answer, keep the session.
      inFlight.abort(new Error("Cancelled."));
      return;
    }
    exiting = true;
    rl.close();
  });

  const prompt = (): void => {
    if (!closed && !exiting) rl.prompt();
  };

  if (terminal) {
    output.heading(`hetzchat  ${session.model}`);
    output.meta("Type /help for commands, Ctrl+C to cancel a reply, Ctrl+D to leave.");
    output.line();
  }

  prompt();

  for (;;) {
    const raw = await queue.next();
    if (raw === undefined) break;

    const line = raw.trim();
    if (line === "") {
      prompt();
      continue;
    }

    if (isCommand(line)) {
      await runCommand(line, {
        session,
        output,
        requestExit: () => {
          exiting = true;
        },
      });
      if (exiting) break;
      prompt();
      continue;
    }

    inFlight = new AbortController();
    try {
      await session.ask(unescapeMessage(line), inFlight.signal);
    } finally {
      inFlight = undefined;
    }

    prompt();
  }

  rl.close();
  if (terminal) output.line();
  return 0;
}
