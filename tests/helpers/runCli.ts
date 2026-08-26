import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = resolve(ROOT, "dist", "index.js");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  args?: string[];
  stdin?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * Runs the built CLI as a real subprocess. Everything the tests assert on is
 * what a user would see on their terminal.
 */
export async function runCli({
  args = [],
  stdin = "",
  env = {},
  timeoutMs = 20_000,
}: CliOptions = {}): Promise<CliResult> {
  const child = spawn(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      NO_COLOR: "1",
      // Keep the real ~/.config/hetzchat/config.json out of the test.
      XDG_CONFIG_HOME: resolve(ROOT, "tests", "fixtures", "empty-config"),
      ...env,
    } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => void (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => void (stderr += chunk));

  child.stdin.end(stdin);

  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

  const code = await new Promise<number>((resolvePromise) => {
    child.on("close", (exitCode) => resolvePromise(exitCode ?? -1));
  });
  clearTimeout(timer);

  return { code, stdout, stderr };
}
