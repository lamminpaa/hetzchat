import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";
import { resolveWithinRoot } from "./paths.js";
import { requireString, ToolError, truncateResult, type ToolDefinition } from "./types.js";

const execFileAsync = promisify(execFile);

const SHELL_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 512 * 1024;
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
    const path = await resolveWithinRoot(context.root, requireString(args, "path"));

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

    const lines = entries
      .slice(0, MAX_ENTRIES)
      .map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`)
      .sort();

    if (entries.length > MAX_ENTRIES) {
      lines.push(`[${entries.length - MAX_ENTRIES} more entries not listed]`);
    }
    return lines.join("\n") || "(empty directory)";
  },
};

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
        maxBuffer: 4 * 1024 * 1024,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      return truncateResult(formatShell(0, stdout, stderr));
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
      if (failure.killed === true) {
        throw new ToolError(`Command timed out after ${SHELL_TIMEOUT_MS / 1000}s: ${command}`);
      }
      return truncateResult(
        formatShell(failure.code ?? 1, failure.stdout ?? "", failure.stderr ?? String(error)),
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

    const response = await fetch(url, {
      redirect: "follow",
      headers: { accept: "text/*, application/json;q=0.9, */*;q=0.1" },
      ...(context.signal ? { signal: context.signal } : {}),
    });

    const body = await response.text();
    return truncateResult(`HTTP ${response.status} ${response.statusText}\n\n${body}`);
  },
};

export const BUILTIN_TOOLS: ToolDefinition[] = [
  readFileTool,
  listFilesTool,
  runShellTool,
  fetchUrlTool,
];

function formatShell(code: number, stdout: string, stderr: string): string {
  const parts = [`exit code ${code}`];
  if (stdout.trim() !== "") parts.push(`stdout:\n${stdout.trimEnd()}`);
  if (stderr.trim() !== "") parts.push(`stderr:\n${stderr.trimEnd()}`);
  return parts.join("\n\n");
}

/** Path shown to the user, relative to the root when it is inside it. */
export function displayPath(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === "" ? "." : rel;
}
