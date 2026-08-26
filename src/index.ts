#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import { ArgsError, parseCliArgs, USAGE } from "./cli/args.js";
import { Output } from "./cli/output.js";
import { runRepl } from "./cli/repl.js";
import { InferenceClient } from "./client/inference.js";
import { OpenAITransport } from "./client/transport.js";
import {
  ConfigError,
  defaultConfigPath,
  loadConfigFile,
  resolveConfig,
  type Config,
} from "./config.js";
import { createRedactor } from "./redact.js";
import { Session } from "./session.js";
import { BUILTIN_TOOLS } from "./tools/builtin.js";
import { ToolRunner } from "./tools/runner.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof ArgsError) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }

  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  if (parsed.version) {
    process.stdout.write(`${version()}\n`);
    return EXIT_OK;
  }

  loadDotEnv();

  let config: Config;
  try {
    config = resolveConfig({
      flags: parsed.flags,
      env: process.env,
      file: loadConfigFile(parsed.configPath ?? defaultConfigPath()),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_ERROR;
    }
    throw error;
  }

  // R4: built before anything else can print, and used for every write.
  const redact = createRedactor([config.apiKey]);
  const output = new Output({
    stdout: process.stdout,
    stderr: process.stderr,
    redact,
    color: process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined,
    markdown: config.markdown,
  });

  const client = new InferenceClient({
    transport: new OpenAITransport({ baseUrl: config.baseUrl, apiKey: config.apiKey }),
    requestsPerWindow: config.requestsPerWindow,
    rateWindowMs: config.rateWindowMs,
    maxAttempts: config.maxAttempts,
    onThrottle: (waitMs) => {
      if (config.verbose) {
        output.warn(`Rate limit reached, waiting ${Math.ceil(waitMs / 1000)}s for a slot.`);
      }
    },
    onRetry: ({ attempt, delayMs }) => {
      if (config.verbose) {
        output.warn(`Attempt ${attempt} failed, retrying in ${Math.ceil(delayMs / 1000)}s.`);
      }
    },
  });

  const tools = new ToolRunner({
    tools: BUILTIN_TOOLS,
    root: process.cwd(),
    allowed: new Set(config.allowedTools),
    onActivity: (message) => output.meta(`  ${message}`),
  });

  const session = new Session({ config, client, output, tools });

  const oneShot = parsed.prompt ?? (await readPipedPrompt(parsed.interactive));
  if (oneShot !== undefined) {
    const result = await session.ask(oneShot);
    return result.ok ? EXIT_OK : EXIT_ERROR;
  }

  return runRepl({
    session,
    output,
    input: process.stdin,
    promptStream: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
}

/**
 * A prompt on stdin means single-shot mode, unless -i asked for the session
 * loop. Returns undefined when there is nothing piped in.
 */
async function readPipedPrompt(interactive: boolean): Promise<string | undefined> {
  if (interactive || process.stdin.isTTY === true) return undefined;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text === "" ? undefined : text;
}

function loadDotEnv(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file is the normal case, not an error.
  }
}

function version(): string {
  try {
    const path = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT_ERROR;
    });
}
