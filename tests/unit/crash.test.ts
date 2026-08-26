import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOKEN_ENV_VAR } from "../../src/config.js";

const TOKEN = "hetzner-token-crash-abcdef1234567890";

/**
 * R4: the last-resort handler runs outside the scope where the redactor is
 * built for normal output, and an unanticipated error is exactly the case
 * redaction exists for. Loaded fresh so the module-scope redactor picks up
 * the environment this test sets.
 */
async function loadEntry() {
  vi.resetModules();
  return import("../../src/index.js");
}

const original = process.env[TOKEN_ENV_VAR];

beforeEach(() => {
  process.env[TOKEN_ENV_VAR] = TOKEN;
});

afterEach(() => {
  if (original === undefined) delete process.env[TOKEN_ENV_VAR];
  else process.env[TOKEN_ENV_VAR] = original;
});

describe("R4 the crash handler redacts too", () => {
  it("blinds the token in an error that reached the last-resort handler", async () => {
    const { describeFatal } = await loadEntry();

    const message = describeFatal(new Error(`socket hang up while sending ${TOKEN}`));

    expect(message).not.toContain(TOKEN);
    expect(message).toContain("[redacted]");
    expect(message).toContain("socket hang up");
  });

  it("blinds it in a thrown value that is not an Error", async () => {
    const { describeFatal } = await loadEntry();

    expect(describeFatal(`raw failure with ${TOKEN}`)).not.toContain(TOKEN);
  });

  it("leaves an ordinary message intact", async () => {
    const { describeFatal } = await loadEntry();

    expect(describeFatal(new Error("Invalid URL"))).toBe("Invalid URL");
  });
});
