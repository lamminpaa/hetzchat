/**
 * R8: CLI flags override environment, environment overrides the config file,
 * the config file overrides defaults. A missing token fails fast.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  contextBudgetTokens: number;
  requestsPerWindow: number;
  rateWindowMs: number;
  maxAttempts: number;
  stream: boolean;
  /** Undefined leaves the vendor default alone rather than forcing a value. */
  thinking: boolean | undefined;
  verbose: boolean;
}

export const TOKEN_ENV_VAR = "HETZNER_INFERENCE_TOKEN";

export const DEFAULTS = {
  baseUrl: "https://inference.hetzner.com/api/v1",
  model: "Qwen/Qwen3.6-35B-A3B-FP8",
  systemPrompt: "You are a concise, accurate assistant. Answer directly.",
  temperature: 0.7,
  maxOutputTokens: 4096,
  /**
   * The served models advertise 262144 tokens. History is sized well under
   * that because tokens are estimated, not counted, and the response needs
   * room inside the same window.
   */
  contextBudgetTokens: 120_000,
  /** Hetzner's documented ceiling: 10 requests per 60 s per key. */
  requestsPerWindow: 10,
  rateWindowMs: 60_000,
  maxAttempts: 4,
  stream: true,
  verbose: false,
} as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Values a config file may set. The token is deliberately not among them. */
export interface FileConfig {
  baseUrl?: string;
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  contextBudgetTokens?: number;
  maxAttempts?: number;
  stream?: boolean;
  thinking?: boolean;
}

export interface CliFlags {
  baseUrl?: string;
  model?: string;
  system?: string;
  temperature?: number;
  maxOutputTokens?: number;
  stream?: boolean;
  thinking?: boolean;
  verbose?: boolean;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "hetzchat", "config.json");
}

export function loadConfigFile(path: string): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `Config file ${path} is not valid JSON: ${(error as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`Config file ${path} must contain a JSON object`);
  }
  return parsed as FileConfig;
}

export interface ResolveInput {
  flags?: CliFlags;
  env?: NodeJS.ProcessEnv;
  file?: FileConfig;
}

export function resolveConfig({ flags = {}, env = {}, file = {} }: ResolveInput): Config {
  const apiKey = firstNonEmpty(env[TOKEN_ENV_VAR], env["HETZNER_INFERENCE_API_KEY"]);

  if (apiKey === undefined) {
    throw new ConfigError(
      `No API token. Create one in the Hetzner Experiments dashboard and set ${TOKEN_ENV_VAR}, ` +
        `either in the environment or in a .env file next to where you run hetzchat.`,
    );
  }

  return {
    apiKey,
    baseUrl:
      flags.baseUrl ??
      firstNonEmpty(env["HETZNER_INFERENCE_BASE_URL"]) ??
      file.baseUrl ??
      DEFAULTS.baseUrl,
    model: flags.model ?? firstNonEmpty(env["HETZCHAT_MODEL"]) ?? file.model ?? DEFAULTS.model,
    systemPrompt:
      flags.system ??
      firstNonEmpty(env["HETZCHAT_SYSTEM"]) ??
      file.systemPrompt ??
      DEFAULTS.systemPrompt,
    temperature:
      flags.temperature ??
      numberFromEnv(env["HETZCHAT_TEMPERATURE"], "HETZCHAT_TEMPERATURE") ??
      file.temperature ??
      DEFAULTS.temperature,
    maxOutputTokens:
      flags.maxOutputTokens ??
      numberFromEnv(env["HETZCHAT_MAX_OUTPUT_TOKENS"], "HETZCHAT_MAX_OUTPUT_TOKENS") ??
      file.maxOutputTokens ??
      DEFAULTS.maxOutputTokens,
    contextBudgetTokens:
      numberFromEnv(env["HETZCHAT_CONTEXT_BUDGET"], "HETZCHAT_CONTEXT_BUDGET") ??
      file.contextBudgetTokens ??
      DEFAULTS.contextBudgetTokens,
    requestsPerWindow:
      numberFromEnv(env["HETZCHAT_REQUESTS_PER_WINDOW"], "HETZCHAT_REQUESTS_PER_WINDOW") ??
      DEFAULTS.requestsPerWindow,
    rateWindowMs:
      numberFromEnv(env["HETZCHAT_RATE_WINDOW_MS"], "HETZCHAT_RATE_WINDOW_MS") ??
      DEFAULTS.rateWindowMs,
    maxAttempts:
      numberFromEnv(env["HETZCHAT_MAX_ATTEMPTS"], "HETZCHAT_MAX_ATTEMPTS") ??
      file.maxAttempts ??
      DEFAULTS.maxAttempts,
    stream:
      flags.stream ?? boolFromEnv(env["HETZCHAT_STREAM"]) ?? file.stream ?? DEFAULTS.stream,
    thinking: flags.thinking ?? boolFromEnv(env["HETZCHAT_THINKING"]) ?? file.thinking,
    verbose: flags.verbose ?? boolFromEnv(env["HETZCHAT_VERBOSE"]) ?? DEFAULTS.verbose,
  };
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function numberFromEnv(value: string | undefined, name: string): number | undefined {
  const text = firstNonEmpty(value);
  if (text === undefined) return undefined;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new ConfigError(`${name} must be a number, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function boolFromEnv(value: string | undefined): boolean | undefined {
  const text = firstNonEmpty(value)?.toLowerCase();
  if (text === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return undefined;
}
