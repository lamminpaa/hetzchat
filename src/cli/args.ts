import { parseArgs } from "node:util";
import type { CliFlags } from "../config.js";

export interface ParsedArgs {
  flags: CliFlags;
  prompt: string | undefined;
  configPath: string | undefined;
  /** Force the REPL even when stdin is a pipe rather than a terminal. */
  interactive: boolean;
  help: boolean;
  version: boolean;
}

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgsError";
  }
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        model: { type: "string", short: "m" },
        system: { type: "string", short: "s" },
        "base-url": { type: "string" },
        temperature: { type: "string", short: "t" },
        "max-output-tokens": { type: "string" },
        config: { type: "string" },
        stream: { type: "boolean" },
        "no-stream": { type: "boolean" },
        markdown: { type: "boolean" },
        "no-markdown": { type: "boolean" },
        tools: { type: "boolean" },
        "no-tools": { type: "boolean" },
        "allow-tool": { type: "string", multiple: true },
        think: { type: "boolean" },
        "no-think": { type: "boolean" },
        interactive: { type: "boolean", short: "i" },
        verbose: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new ArgsError((error as Error).message);
  }

  const values = parsed.values;

  if (values.stream === true && values["no-stream"] === true) {
    throw new ArgsError("--stream and --no-stream contradict each other");
  }
  if (values.markdown === true && values["no-markdown"] === true) {
    throw new ArgsError("--markdown and --no-markdown contradict each other");
  }
  if (values.think === true && values["no-think"] === true) {
    throw new ArgsError("--think and --no-think contradict each other");
  }
  if (values.tools === true && values["no-tools"] === true) {
    throw new ArgsError("--tools and --no-tools contradict each other");
  }

  const flags: CliFlags = {};
  if (values.model !== undefined) flags.model = values.model;
  if (values.system !== undefined) flags.system = values.system;
  if (values["base-url"] !== undefined) flags.baseUrl = values["base-url"];
  if (values.temperature !== undefined) {
    flags.temperature = requireNumber(values.temperature, "--temperature");
  }
  if (values["max-output-tokens"] !== undefined) {
    flags.maxOutputTokens = requireNumber(values["max-output-tokens"], "--max-output-tokens");
  }
  if (values.stream === true) flags.stream = true;
  if (values["no-stream"] === true) flags.stream = false;
  if (values.markdown === true) flags.markdown = true;
  if (values["no-markdown"] === true) flags.markdown = false;
  if (values.tools === true) flags.tools = true;
  if (values["no-tools"] === true) flags.tools = false;
  const allowed = values["allow-tool"];
  if (allowed !== undefined && allowed.length > 0) {
    flags.allowedTools = allowed;
    // Naming a tool to allow is only meaningful with tools on, so imply it.
    if (values["no-tools"] !== true) flags.tools = true;
  }
  if (values.think === true) flags.thinking = true;
  if (values["no-think"] === true) flags.thinking = false;
  if (values.verbose === true) flags.verbose = true;

  const prompt = parsed.positionals.length > 0 ? parsed.positionals.join(" ") : undefined;

  return {
    flags,
    prompt,
    configPath: values.config,
    interactive: values.interactive === true,
    help: values.help === true,
    version: values.version === true,
  };
}

function requireNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ArgsError(`${flag} must be a number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export const USAGE = `hetzchat - terminal chat against the Hetzner Experiments Inference API

Usage:
  hetzchat                     Start an interactive session
  hetzchat "your question"     Ask once, print the answer, exit
  echo "question" | hetzchat   Same, reading the prompt from stdin

Options:
  -m, --model <name>           Model to use
  -s, --system <prompt>        System prompt
  -t, --temperature <n>        Sampling temperature
      --max-output-tokens <n>  Cap on response length
      --base-url <url>         Override the API base URL
      --config <path>          Config file to read
  -i, --interactive            Run the session loop even on piped stdin
      --stream / --no-stream   Stream the response as it arrives
      --markdown / --no-markdown
                               Style the model's Markdown in the terminal
      --think / --no-think     Toggle the model's thinking mode (undocumented)
      --tools / --no-tools     Let the model call local tools
      --allow-tool <name>      Pre-authorise a tool; repeatable. Implies --tools
  -v, --verbose                Report retries, throttling and token usage
  -h, --help                   Show this help
      --version                Show the version

Environment:
  HETZNER_INFERENCE_TOKEN      API token from the Experiments dashboard (required)
  HETZNER_INFERENCE_BASE_URL   Override the API base URL
  HETZCHAT_MODEL               Default model

Type /help inside a session for the list of commands.`;
