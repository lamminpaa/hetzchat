import type {
  ChatRequest,
  ChatResult,
  DeltaHandler,
  Transport,
} from "../../src/client/transport.js";

export interface StreamScript {
  /** Deltas emitted before `error` (if any) is thrown. */
  deltas?: string[];
  error?: unknown;
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * Transport stand-in that records every call and replays scripted responses.
 * A single script is reused for every call once the queue is empty, which is
 * what makes "always fails" scenarios easy to express.
 */
export class FakeTransport implements Transport {
  readonly streamCalls: ChatRequest[] = [];
  readonly completeCalls: ChatRequest[] = [];
  modelsCalls = 0;

  models: string[] = ["Qwen/Qwen3.6-35B-A3B-FP8"];

  private scripts: StreamScript[] = [];
  private fallback: StreamScript = { deltas: ["ok"] };

  constructor(fallback?: StreamScript) {
    if (fallback) this.fallback = fallback;
  }

  queue(...scripts: StreamScript[]): this {
    this.scripts.push(...scripts);
    return this;
  }

  async stream(request: ChatRequest, onDelta: DeltaHandler): Promise<ChatResult> {
    this.streamCalls.push(structuredClone(request));
    const script = this.scripts.shift() ?? this.fallback;

    let text = "";
    for (const delta of script.deltas ?? []) {
      text += delta;
      onDelta(delta);
    }
    if (script.error !== undefined) throw script.error;
    return { text, usage: script.usage };
  }

  async complete(request: ChatRequest): Promise<ChatResult> {
    this.completeCalls.push(structuredClone(request));
    const script = this.scripts.shift() ?? this.fallback;
    if (script.error !== undefined) throw script.error;
    return { text: (script.deltas ?? []).join(""), usage: script.usage };
  }

  async listModels(): Promise<string[]> {
    this.modelsCalls += 1;
    return this.models;
  }
}
