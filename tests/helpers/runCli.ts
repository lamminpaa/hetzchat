import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = resolve(ROOT, "dist", "index.js");

/**
 * The CLI loads a .env from its working directory. Running from the repo root
 * would pick up a developer's real token and quietly defeat any test about a
 * missing or overridden one, so the default cwd is an empty directory.
 */
const CLEAN_CWD = mkdtempSync(join(tmpdir(), "hetzchat-clean-cwd-"));

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  args?: string[];
  stdin?: string;
  env?: Record<string, string | undefined>;
  /** Working directory, which is also the root the file tools are confined to. */
  cwd?: string;
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
  cwd = CLEAN_CWD,
  timeoutMs = 20_000,
}: CliOptions = {}): Promise<CliResult> {
  const child = spawn(process.execPath, [ENTRY, ...args], {
    cwd,
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
