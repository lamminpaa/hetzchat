import { ToolError, type ToolDefinition } from "./types.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolOutcome {
  id: string;
  name: string;
  content: string;
  ok: boolean;
}

/** R11: the thing that can say yes. */
export interface Approver {
  /** True when there is a terminal that can actually be asked. */
  readonly interactive: boolean;
  confirm(summary: string): Promise<boolean>;
}

/** Used wherever there is no terminal: single-shot runs, pipes, tests. */
export const denyAll: Approver = {
  interactive: false,
  confirm: async () => false,
};

export interface ToolRunnerOptions {
  tools: ToolDefinition[];
  root: string;
  /** Tools pre-authorised by name with --allow-tool. */
  allowed?: ReadonlySet<string>;
  /** Progress reporting, so the user sees what the model is doing. */
  onActivity?: (message: string) => void;
}

export class ToolRunner {
  private readonly byName: Map<string, ToolDefinition>;
  private readonly allowed: Set<string>;

  /**
   * Who may say yes. Defaults to nobody, so a caller that forgets to wire up a
   * terminal refuses tool calls rather than running them unasked.
   */
  approver: Approver = denyAll;

  constructor(private readonly options: ToolRunnerOptions) {
    this.byName = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.allowed = new Set(options.allowed ?? []);
  }

  get names(): string[] {
    return [...this.byName.keys()].sort();
  }

  allow(name: string): void {
    this.allowed.add(name);
  }

  /** Tool specifications in the shape the API expects. */
  specifications(): Record<string, unknown>[] {
    return this.options.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * Runs one call. Every failure — unknown tool, bad arguments, refusal,
   * a throwing tool — comes back as a tool result rather than an exception,
   * so the model is told what happened and the turn can continue honestly.
   */
  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolOutcome> {
    const tool = this.byName.get(call.name);
    if (tool === undefined) {
      return this.failure(call, `No tool named "${call.name}". Available: ${this.names.join(", ")}`);
    }

    let args: Record<string, unknown>;
    try {
      args = parseArguments(call.arguments);
    } catch (error) {
      return this.failure(call, (error as Error).message);
    }

    let summary: string;
    try {
      summary = tool.describe(args);
    } catch {
      summary = call.name;
    }

    const authorised = await this.authorise(tool, summary);
    if (!authorised.ok) return this.failure(call, authorised.reason);

    this.options.onActivity?.(`${call.name}: ${summary}`);

    try {
      const content = await tool.run(args, {
        root: this.options.root,
        signal,
      });
      return { id: call.id, name: call.name, content, ok: true };
    } catch (error) {
      if (error instanceof ToolError) return this.failure(call, error.message);
      return this.failure(call, `${call.name} failed: ${(error as Error).message}`);
    }
  }

  /** R11: read-only tools go through; everything else needs a yes. */
  private async authorise(
    tool: ToolDefinition,
    summary: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (tool.readOnly) return { ok: true };
    if (this.allowed.has(tool.name)) return { ok: true };

    if (!this.approver.interactive) {
      return {
        ok: false,
        reason:
          `Refused: ${tool.name} needs confirmation and there is no terminal to ask. ` +
          `Run interactively, or pass --allow-tool ${tool.name}.`,
      };
    }

    const confirmed = await this.approver.confirm(
      `${tool.name} wants to ${summary}  (in ${this.options.root})`,
    );
    return confirmed ? { ok: true } : { ok: false, reason: `Refused by the user: ${summary}` };
  }

  private failure(call: ToolCall, reason: string): ToolOutcome {
    this.options.onActivity?.(`${call.name}: ${reason}`);
    return { id: call.id, name: call.name, content: reason, ok: false };
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (text === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ToolError(`Arguments were not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ToolError("Arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
