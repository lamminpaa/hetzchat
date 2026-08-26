import { describe, expect, it } from "vitest";
import { createRedactor } from "../../src/redact.js";
import { captureOutput } from "../helpers/captureOutput.js";

const TOKEN = "hetzner-inference-token-abcdef1234567890";

describe("R4 the API token never reaches the terminal", () => {
  it("blinds the token wherever it appears in a line", () => {
    const redact = createRedactor([TOKEN]);

    expect(redact(`Authorization: Bearer ${TOKEN}`)).toBe("Authorization: Bearer [redacted]");
    expect(redact(`${TOKEN} at the start`)).toBe("[redacted] at the start");
    expect(redact(`twice: ${TOKEN} and ${TOKEN}`)).toBe("twice: [redacted] and [redacted]");
  });

  it("blinds the token in every stream the CLI writes to", () => {
    const captured = captureOutput([TOKEN]);

    captured.output.line(`request used ${TOKEN}`);
    captured.output.meta(`meta ${TOKEN}`);
    captured.output.write(`body ${TOKEN}`);
    captured.output.warn(`warning about ${TOKEN}`);
    captured.output.error(`401 rejected ${TOKEN}`);

    expect(captured.stdout()).not.toContain(TOKEN);
    expect(captured.stderr()).not.toContain(TOKEN);
    expect(captured.stdout()).toContain("[redacted]");
    expect(captured.stderr()).toContain("[redacted]");
  });

  it("catches a token that leaked into an error message from deep in the stack", () => {
    const captured = captureOutput([TOKEN]);
    const leaky = new Error(`connect ECONNREFUSED while sending key=${TOKEN}`);

    captured.output.error(leaky.message);

    expect(captured.stderr()).not.toContain(TOKEN);
  });

  it("replaces the longer secret whole when one contains another", () => {
    const short = "abcdef123456";
    const long = `${short}-extended-suffix`;
    const redact = createRedactor([short, long]);

    expect(redact(long)).toBe("[redacted]");
  });

  it("leaves text alone when there is nothing worth blinding", () => {
    expect(createRedactor([])("plain text")).toBe("plain text");
    expect(createRedactor([undefined])("plain text")).toBe("plain text");
    // Too short to blind safely: it would corrupt ordinary output.
    expect(createRedactor(["abc"])("abc def")).toBe("abc def");
  });
});
