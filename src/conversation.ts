/**
 * R3: trimming preserves conversation structure.
 * R6: what the user saw is what gets stored.
 * R7: a failed turn is rolled back out of history.
 */

export type Role = "system" | "user" | "assistant";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextPart | ImagePart;

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
}

/**
 * Character-per-token ratio used to size history against the context window.
 * The served models are Qwen; no tokenizer ships with this client, so history
 * is sized by a deliberately conservative heuristic rather than an exact count.
 */
const CHARS_PER_TOKEN = 3.5;

/** Per-message framing overhead (role, delimiters) in the chat template. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Cost of an image, which the heuristic cannot see. Qwen3-VL tiles images, so
 * this is a floor, not a measurement; it exists so an image-heavy history
 * still trims instead of silently overflowing.
 */
const IMAGE_TOKENS = 1024;

export function estimateTokens(message: ChatMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;

  if (typeof message.content === "string") {
    tokens += Math.ceil(message.content.length / CHARS_PER_TOKEN);
    return tokens;
  }

  for (const part of message.content) {
    if (part.type === "text") {
      tokens += Math.ceil(part.text.length / CHARS_PER_TOKEN);
    } else {
      tokens += IMAGE_TOKENS;
    }
  }
  return tokens;
}

export function estimateConversationTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

export interface TrimResult {
  messages: ChatMessage[];
  droppedExchanges: number;
  /** True when the newest exchange alone exceeds the budget. */
  overBudget: boolean;
}

export class Conversation {
  private systemPrompt: string;
  private turns: ChatMessage[] = [];

  constructor(systemPrompt: string) {
    this.systemPrompt = systemPrompt;
  }

  get system(): string {
    return this.systemPrompt;
  }

  setSystem(prompt: string): void {
    this.systemPrompt = prompt;
  }

  addUser(content: string | ContentPart[]): void {
    this.turns.push({ role: "user", content });
  }

  addAssistant(text: string): void {
    this.turns.push({ role: "assistant", content: text });
  }

  /**
   * R7: undoes the trailing user message when its turn failed, so the next
   * request does not carry a user message that was never answered.
   * Returns the removed message, or undefined if the tail was not a user turn.
   */
  rollbackLastUser(): ChatMessage | undefined {
    const last = this.turns.at(-1);
    if (last?.role !== "user") return undefined;
    return this.turns.pop();
  }

  clear(): void {
    this.turns = [];
  }

  /** History excluding the system message, oldest first. */
  history(): readonly ChatMessage[] {
    return this.turns;
  }

  get length(): number {
    return this.turns.length;
  }

  /**
   * Full message list for a request, trimmed to `budgetTokens`.
   *
   * R3: the system message always survives; entries are dropped as whole
   * exchanges from the oldest end so the history never begins with an
   * assistant turn; the newest exchange is never dropped.
   */
  toRequest(budgetTokens: number): TrimResult {
    const system: ChatMessage = { role: "system", content: this.systemPrompt };
    const exchanges = groupIntoExchanges(this.turns);

    let start = 0;
    let cost = estimateTokens(system) + estimateConversationTokens(this.turns);

    while (cost > budgetTokens && start < exchanges.length - 1) {
      const dropped = exchanges[start] as ChatMessage[];
      cost -= estimateConversationTokens(dropped);
      start += 1;
    }

    const kept = exchanges.slice(start).flat();
    return {
      messages: [system, ...kept],
      droppedExchanges: start,
      overBudget: cost > budgetTokens,
    };
  }

  /** Transcript as Markdown, for /save. */
  toMarkdown(): string {
    const lines = [`# Transcript`, ``, `## System`, ``, this.systemPrompt, ``];
    for (const message of this.turns) {
      lines.push(`## ${message.role === "user" ? "User" : "Assistant"}`, ``);
      lines.push(renderContent(message.content), ``);
    }
    return lines.join("\n");
  }
}

/**
 * An exchange is a user message plus every message that follows it up to the
 * next user message. Dropping whole exchanges is what keeps the trimmed
 * history from starting on an assistant turn.
 */
function groupIntoExchanges(turns: readonly ChatMessage[]): ChatMessage[][] {
  const exchanges: ChatMessage[][] = [];

  for (const message of turns) {
    if (message.role === "user" || exchanges.length === 0) {
      exchanges.push([message]);
    } else {
      (exchanges.at(-1) as ChatMessage[]).push(message);
    }
  }
  return exchanges;
}

function renderContent(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `![image](${describeImage(part)})`))
    .join("\n\n");
}

function describeImage(part: ImagePart): string {
  const url = part.image_url.url;
  return url.startsWith("data:") ? `${url.slice(0, url.indexOf(";"))} (inline)` : url;
}
