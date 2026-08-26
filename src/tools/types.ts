export interface ToolContext {
  /** Every file path is resolved against, and confined to, this directory. */
  root: string;
  signal?: AbortSignal | undefined;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments, sent to the API verbatim. */
  parameters: Record<string, unknown>;
  /**
   * R11: false only for tools that read local files and nothing else. Anything
   * that executes, writes, or reaches the network must be confirmed.
   */
  readOnly: boolean;
  /** One line shown in the confirmation prompt, so a user can judge the call. */
  describe(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, context: ToolContext): Promise<string>;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Longest tool result sent back to the model, in characters. */
export const MAX_TOOL_RESULT_CHARS = 8000;

export function truncateResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const kept = text.slice(0, MAX_TOOL_RESULT_CHARS);
  return `${kept}\n\n[truncated: ${text.length - MAX_TOOL_RESULT_CHARS} more characters]`;
}

export function requireString(
  args: Record<string, unknown>,
  name: string,
  { optional = false }: { optional?: boolean } = {},
): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (optional) return "";
    throw new ToolError(`Missing required argument "${name}"`);
  }
  if (typeof value !== "string") {
    throw new ToolError(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}
