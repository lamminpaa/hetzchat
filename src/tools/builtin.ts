import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";

import { promisify } from "node:util";
import { basename } from "node:path";
import { resolveWithinRoot } from "./paths.js";
import { requireString, ToolError, truncateResult, type ToolDefinition } from "./types.js";

const execFileAsync = promisify(execFile);

const SHELL_TIMEOUT_MS = 30_000;
const MAX_SHELL_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Bytes read from a response before giving up on it. Well above what survives
 * truncateResult, so the model still sees everything it would have seen.
 */
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 500;

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the working directory. Paths are relative to it and cannot escape it.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the working directory" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  describe: (args) => `read ${String(args["path"])}`,
  async run(args, context) {
    const requested = requireString(args, "path");
    const path = await resolveWithinRoot(context.root, requested);
    assertNotCredentialFile(path, requested);

    const info = await stat(path).catch(() => {
      throw new ToolError(`No such file: ${requireString(args, "path")}`);
    });
    if (info.isDirectory()) {
      throw new ToolError(`${requireString(args, "path")} is a directory; use list_files.`);
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new ToolError(
        `${requireString(args, "path")} is ${Math.round(info.size / 1024)} KB, over the ${MAX_FILE_BYTES / 1024} KB limit.`,
      );
    }

    return truncateResult(await readFile(path, "utf8"));
  },
};

export const listFilesTool: ToolDefinition = {
  name: "list_files",
  description:
    "List the entries of a directory in the working directory. Paths cannot escape it.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory relative to the working directory; defaults to it",
      },
    },
    additionalProperties: false,
  },
  describe: (args) => `list ${String(args["path"] ?? ".")}`,
  async run(args, context) {
    const requested = requireString(args, "path", { optional: true }) || ".";
    const path = await resolveWithinRoot(context.root, requested);

    const entries = await readdir(path, { withFileTypes: true }).catch(() => {
      throw new ToolError(`No such directory: ${requested}`);
    });

    return formatEntries(entries);
  },
};

/**
 * Renders a directory listing.
 *
 * Sorting happens before capping: capping first would show an arbitrary
 * MAX_ENTRIES of the directory in whatever order the filesystem returned, so
 * two runs on the same directory could list different files. Exported because
 * that ordering cannot be tested through readdir, which on many filesystems
 * returns sorted entries anyway and hides the bug.
 */
export function formatEntries(entries: readonly { name: string; isDirectory(): boolean }[]): string {
  const lines = entries
    .map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`)
    .sort()
    .slice(0, MAX_ENTRIES);

  if (entries.length > MAX_ENTRIES) {
    lines.push(`[${entries.length - MAX_ENTRIES} more entries not listed]`);
  }
  return lines.join("\n") || "(empty directory)";
}

export const runShellTool: ToolDefinition = {
  name: "run_shell",
  description:
    "Run a shell command in the working directory and return its output. Requires the user's confirmation.",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command line to run" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  describe: (args) => `run: ${String(args["command"])}`,
  async run(args, context) {
    const command = requireString(args, "command");

    try {
      const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], {
        cwd: context.root,
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: MAX_SHELL_OUTPUT_BYTES,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return truncateResult(formatShell(0, stdout, stderr));
    } catch (error) {
      const failure = error as {
        // Node sets a numeric exit status for a command that ran and failed,
        // and a string error code when the command never completed normally.
        code?: number | string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };

      if (failure.code === "ABORT_ERR" || context.signal?.aborted === true) {
        throw new ToolError(`Cancelled before it finished: ${command}`);
      }
      if (failure.killed === true || failure.code === "ETIMEDOUT") {
        throw new ToolError(`Command timed out after ${SHELL_TIMEOUT_MS / 1000}s: ${command}`);
      }
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new ToolError(
          `Output of "${command}" exceeded ${MAX_SHELL_OUTPUT_BYTES / 1024 / 1024} MB and was discarded. ` +
            `Re-run it with the output narrowed, for example through head or grep.`,
        );
      }
      if (typeof failure.code !== "number") {
        throw new ToolError(`Could not run "${command}": ${failure.code ?? String(error)}`);
      }

      return truncateResult(
        formatShell(failure.code, failure.stdout ?? "", failure.stderr ?? String(error)),
      );
    }
  },
};

export const fetchUrlTool: ToolDefinition = {
  name: "fetch_url",
  description:
    "Fetch an http or https URL and return the response body as text. Requires the user's confirmation.",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http or https URL" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  describe: (args) => `fetch ${String(args["url"])}`,
  async run(args, context) {
    const raw = requireString(args, "url");

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ToolError(`Not a valid URL: ${raw}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ToolError(`Refusing to fetch ${url.protocol} URLs; only http and https.`);
    }

    // Unlike run_shell, fetch has no built-in ceiling: without these a URL
    // that never ends, or serves gigabytes, hangs or exhausts the CLI.
    const signal = context.signal
      ? AbortSignal.any([context.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
      : AbortSignal.timeout(FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "follow",
        headers: { accept: "text/*, application/json;q=0.9, */*;q=0.1" },
        signal,
      });
    } catch (error) {
      if ((error as Error).name === "TimeoutError") {
        throw new ToolError(`${url.href} did not respond within ${FETCH_TIMEOUT_MS / 1000}s.`);
      }
      throw new ToolError(`Could not fetch ${url.href}: ${(error as Error).message}`);
    }

    const body = await readCapped(response, signal);
    return truncateResult(`HTTP ${response.status} ${response.statusText}\n\n${body}`);
  },
};

export const BUILTIN_TOOLS: ToolDefinition[] = [
  readFileTool,
  listFilesTool,
  runShellTool,
  fetchUrlTool,
];

/** Reads at most MAX_FETCH_BYTES, so an endless response cannot exhaust us. */
async function readCapped(response: Response, signal: AbortSignal): Promise<string> {
  if (response.body === null) return "";

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let text = "";
  let bytes = 0;

  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });

      if (bytes >= MAX_FETCH_BYTES) {
        text += `\n\n[stopped after ${MAX_FETCH_BYTES / 1024 / 1024} MB]`;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/**
 * The CLI loads its own token from a .env in the working directory, which is
 * also the tool root. read_file is authorised without asking, so this is the
 * one file it must not hand over.
 */
function assertNotCredentialFile(path: string, requested: string): void {
  const name = basename(path);
  if (name === ".env" || name.startsWith(".env.")) {
    throw new ToolError(
      `Refusing to read ${requested}: it holds credentials. Ask the user for what you need from it.`,
    );
  }
}

function formatShell(code: number, stdout: string, stderr: string): string {
  const parts = [`exit code ${code}`];
  if (stdout.trim() !== "") parts.push(`stdout:\n${stdout.trimEnd()}`);
  if (stderr.trim() !== "") parts.push(`stderr:\n${stderr.trimEnd()}`);
  return parts.join("\n\n");
}

