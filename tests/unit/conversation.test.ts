import { describe, expect, it } from "vitest";
import { Conversation, estimateTokens, type ChatMessage } from "../../src/conversation.js";

const paragraph = (marker: string, length = 400): string => marker.repeat(length);

function seedExchanges(conversation: Conversation, count: number, length = 400): void {
  for (let i = 0; i < count; i++) {
    conversation.addUser(paragraph(String(i % 10), length));
    conversation.addAssistant(paragraph("a", length));
  }
}

describe("R3 trimming preserves conversation structure", () => {
  it("keeps the system message no matter how much is dropped", () => {
    const conversation = new Conversation("SYSTEM RULES");
    seedExchanges(conversation, 40);

    const { messages, droppedExchanges } = conversation.toRequest(500);

    expect(droppedExchanges).toBeGreaterThan(0);
    expect(messages[0]).toEqual({ role: "system", content: "SYSTEM RULES" });
    expect(messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("never leaves the history starting on an assistant turn", () => {
    const conversation = new Conversation("s");
    seedExchanges(conversation, 40);

    for (const budget of [200, 500, 1000, 2000, 5000]) {
      const { messages } = conversation.toRequest(budget);
      const afterSystem = messages.slice(1);

      expect(afterSystem.length, `budget ${budget} kept nothing`).toBeGreaterThan(0);
      expect(afterSystem[0]?.role, `budget ${budget} started on an assistant turn`).toBe("user");
    }
  });

  it("drops exchanges whole, so no assistant reply is orphaned from its question", () => {
    const conversation = new Conversation("s");
    seedExchanges(conversation, 10);

    const { messages } = conversation.toRequest(3000);
    const turns = messages.slice(1);

    // Alternating user/assistant is what "whole exchanges" means for this seed.
    turns.forEach((message, index) => {
      expect(message.role).toBe(index % 2 === 0 ? "user" : "assistant");
    });
  });

  it("keeps the newest user message even when it alone busts the budget", () => {
    const conversation = new Conversation("s");
    seedExchanges(conversation, 5);
    conversation.addUser(paragraph("z", 5000));

    const { messages, overBudget } = conversation.toRequest(100);

    expect(overBudget).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toBe(paragraph("z", 5000));
  });

  it("drops nothing when everything fits", () => {
    const conversation = new Conversation("s");
    seedExchanges(conversation, 3, 10);

    const { messages, droppedExchanges, overBudget } = conversation.toRequest(100_000);

    expect(droppedExchanges).toBe(0);
    expect(overBudget).toBe(false);
    expect(messages).toHaveLength(7);
  });

  it("counts an attached image against the budget", () => {
    const withImage: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    };
    const withoutImage: ChatMessage = { role: "user", content: "what is this" };

    expect(estimateTokens(withImage)).toBeGreaterThan(estimateTokens(withoutImage) + 500);
  });
});

describe("R7 a failed turn leaves history clean", () => {
  it("removes the trailing user message and nothing else", () => {
    const conversation = new Conversation("s");
    conversation.addUser("first");
    conversation.addAssistant("reply");
    conversation.addUser("second");

    const removed = conversation.rollbackLastUser();

    expect(removed).toEqual({ role: "user", content: "second" });
    expect(conversation.history()).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
    ]);
  });

  it("refuses to roll back an answered turn", () => {
    const conversation = new Conversation("s");
    conversation.addUser("q");
    conversation.addAssistant("a");

    expect(conversation.rollbackLastUser()).toBeUndefined();
    expect(conversation.history()).toHaveLength(2);
  });
});

describe("transcript export", () => {
  it("renders roles and content as Markdown", () => {
    const conversation = new Conversation("be brief");
    conversation.addUser("hello");
    conversation.addAssistant("hi");

    const markdown = conversation.toMarkdown();

    expect(markdown).toContain("## System");
    expect(markdown).toContain("be brief");
    expect(markdown).toContain("## User");
    expect(markdown).toContain("hello");
    expect(markdown).toContain("## Assistant");
    expect(markdown).toContain("hi");
  });

  it("does not inline image payloads into the transcript", () => {
    const conversation = new Conversation("s");
    conversation.addUser([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,SECRETPAYLOAD" } },
    ]);

    expect(conversation.toMarkdown()).not.toContain("SECRETPAYLOAD");
  });
});
