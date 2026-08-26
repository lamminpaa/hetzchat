import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Session } from "../session.js";
import { describeError } from "../client/errors.js";
import type { Output } from "./output.js";

/**
 * R5: everything here runs locally. Command text never becomes a chat message.
 */

export interface CommandContext {
  session: Session;
  output: Output;
  requestExit(): void;
}

export interface Command {
  name: string;
  args?: string;
  summary: string;
  run(args: string, context: CommandContext): Promise<void> | void;
}

/** True when the line should be handled locally rather than sent to the model. */
export function isCommand(line: string): boolean {
  const trimmed = line.trimStart();
  // `//` escapes a literal leading slash so a message can still start with one.
  return trimmed.startsWith("/") && !trimmed.startsWith("//");
}

/** Strips the `//` escape from a line that is being sent as a message. */
export function unescapeMessage(line: string): string {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") ? trimmed.slice(1) : line;
}

export const COMMANDS: Command[] = [
  {
    name: "help",
    summary: "List these commands",
    run(_args, { output }) {
      output.heading("Commands");
      const width = Math.max(...COMMANDS.map((c) => commandLabel(c).length));
      for (const command of COMMANDS) {
        output.line(`  ${commandLabel(command).padEnd(width)}  ${command.summary}`);
      }
      output.meta("  Start a line with // to send a message that begins with a slash.");
    },
  },
  {
    name: "model",
    args: "[name]",
    summary: "Show or switch the model",
    run(args, { session, output }) {
      if (args === "") {
        output.line(session.model);
        return;
      }
      session.model = args;
      output.meta(`Model set to ${args}`);
    },
  },
  {
    name: "models",
    summary: "List the models the API is serving",
    async run(_args, { session, output }) {
      try {
        const models = await session.client.listModels();
        if (models.length === 0) {
          output.warn("The API returned no models.");
          return;
        }
        output.heading("Models");
        for (const model of models) {
          output.line(`  ${model}${model === session.model ? "  (current)" : ""}`);
        }
      } catch (error) {
        output.error(describeError(error));
      }
    },
  },
  {
    name: "system",
    args: "[prompt]",
    summary: "Show or replace the system prompt",
    run(args, { session, output }) {
      if (args === "") {
        output.line(session.conversation.system);
        return;
      }
      session.conversation.setSystem(args);
      output.meta("System prompt replaced.");
    },
  },
  {
    name: "clear",
    summary: "Forget the conversation so far",
    run(_args, { session, output }) {
      session.conversation.clear();
      session.clearAttachments();
      output.meta("History cleared.");
    },
  },
  {
    name: "temp",
    args: "[n]",
    summary: "Show or set the sampling temperature",
    run(args, { session, output }) {
      if (args === "") {
        output.line(String(session.temperature));
        return;
      }
      const value = Number(args);
      if (!Number.isFinite(value) || value < 0 || value > 2) {
        output.warn(`Temperature must be a number between 0 and 2, got ${JSON.stringify(args)}`);
        return;
      }
      session.temperature = value;
      output.meta(`Temperature set to ${value}`);
    },
  },
  {
    name: "stream",
    args: "on|off",
    summary: "Toggle streaming of the response",
    run(args, { session, output }) {
      const value = parseToggle(args, session.stream);
      if (value === undefined) {
        output.warn("Use /stream on or /stream off");
        return;
      }
      session.stream = value;
      output.meta(`Streaming ${value ? "on" : "off"}`);
    },
  },
  {
    name: "think",
    args: "on|off",
    summary: "Toggle the model's thinking mode (undocumented API extension)",
    run(args, { session, output }) {
      const value = parseToggle(args, session.thinking ?? false);
      if (value === undefined) {
        output.warn("Use /think on or /think off");
        return;
      }
      session.thinking = value;
      output.meta(`Thinking mode ${value ? "on" : "off"}`);
    },
  },
  {
    name: "image",
    args: "<path>",
    summary: "Attach an image to the next message",
    async run(args, { session, output }) {
      if (args === "") {
        output.warn("Use /image <path>");
        return;
      }
      try {
        await session.attachImage(resolve(args));
        output.meta(`Attached ${args} (${session.attachedImages} image(s) queued)`);
      } catch (error) {
        output.error((error as Error).message);
      }
    },
  },
  {
    name: "save",
    args: "[path]",
    summary: "Write the transcript to a Markdown file",
    async run(args, { session, output }) {
      const path = resolve(args === "" ? "transcript.md" : args);
      try {
        await writeFile(path, session.conversation.toMarkdown(), "utf8");
        output.meta(`Transcript written to ${path}`);
      } catch (error) {
        output.error((error as Error).message);
      }
    },
  },
  {
    name: "usage",
    summary: "Show token usage and remaining rate-limit budget",
    run(_args, { session, output }) {
      const usage = session.client.sessionUsage();
      const used = session.client.rateLimitUsed();
      output.heading("Usage");
      output.line(`  requests          ${usage.requests}`);
      output.line(`  prompt tokens     ${usage.promptTokens}`);
      output.line(`  completion tokens ${usage.completionTokens}`);
      output.line(`  history messages  ${session.conversation.length}`);
      output.line(`  rate window used  ${used}`);
    },
  },
  {
    name: "exit",
    summary: "Leave the session",
    run(_args, { requestExit }) {
      requestExit();
    },
  },
  {
    name: "quit",
    summary: "Leave the session",
    run(_args, { requestExit }) {
      requestExit();
    },
  },
];

const BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));

export async function runCommand(line: string, context: CommandContext): Promise<void> {
  const trimmed = line.trimStart().slice(1);
  const separator = trimmed.search(/\s/);
  const name = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();
  const args = separator === -1 ? "" : trimmed.slice(separator).trim();

  const command = BY_NAME.get(name);
  if (command === undefined) {
    context.output.warn(`Unknown command /${name}. Type /help for the list.`);
    return;
  }
  await command.run(args, context);
}

function commandLabel(command: Command): string {
  return command.args ? `/${command.name} ${command.args}` : `/${command.name}`;
}

function parseToggle(args: string, current: boolean): boolean | undefined {
  const value = args.trim().toLowerCase();
  if (value === "") return !current;
  if (["on", "true", "1", "yes"].includes(value)) return true;
  if (["off", "false", "0", "no"].includes(value)) return false;
  return undefined;
}
