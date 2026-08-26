import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULTS,
  resolveConfig,
  TOKEN_ENV_VAR,
  type CliFlags,
  type FileConfig,
} from "../../src/config.js";

const withToken = (extra: Record<string, string> = {}) => ({
  [TOKEN_ENV_VAR]: "token-value-1234567890",
  ...extra,
});

describe("R8 configuration precedence", () => {
  it("prefers a CLI flag over the environment and the file", () => {
    const flags: CliFlags = { model: "from-flag" };
    const file: FileConfig = { model: "from-file" };
    const env = withToken({ HETZCHAT_MODEL: "from-env" });

    expect(resolveConfig({ flags, env, file }).model).toBe("from-flag");
  });

  it("prefers the environment over the file", () => {
    const file: FileConfig = { model: "from-file" };
    const env = withToken({ HETZCHAT_MODEL: "from-env" });

    expect(resolveConfig({ env, file }).model).toBe("from-env");
  });

  it("prefers the file over the built-in default", () => {
    expect(resolveConfig({ env: withToken(), file: { model: "from-file" } }).model).toBe(
      "from-file",
    );
  });

  it("falls back to the built-in default when nothing else says", () => {
    const config = resolveConfig({ env: withToken() });

    expect(config.model).toBe(DEFAULTS.model);
    expect(config.baseUrl).toBe(DEFAULTS.baseUrl);
    expect(config.requestsPerWindow).toBe(10);
    expect(config.rateWindowMs).toBe(60_000);
  });

  it("defaults the rate limit to Hetzner's documented ceiling", () => {
    const config = resolveConfig({ env: withToken() });

    // 10 requests per 60 s per token, per the Inference API docs.
    expect(config.requestsPerWindow).toBe(10);
    expect(config.rateWindowMs).toBe(60_000);
  });

  it("treats an empty environment variable as unset rather than as an override", () => {
    const env = withToken({ HETZCHAT_MODEL: "   " });

    expect(resolveConfig({ env, file: { model: "from-file" } }).model).toBe("from-file");
  });

  it("lets --no-stream override a config file that enables streaming", () => {
    const config = resolveConfig({
      flags: { stream: false },
      env: withToken(),
      file: { stream: true },
    });

    expect(config.stream).toBe(false);
  });

  it("leaves thinking unset when nobody asked for it", () => {
    expect(resolveConfig({ env: withToken() }).thinking).toBeUndefined();
  });
});

describe("R8 fail-fast on a missing token", () => {
  it("refuses to start and names the variable to set", () => {
    expect(() => resolveConfig({ env: {} })).toThrow(ConfigError);
    expect(() => resolveConfig({ env: {} })).toThrow(/HETZNER_INFERENCE_TOKEN/);
  });

  it("treats a blank token as missing", () => {
    expect(() => resolveConfig({ env: { [TOKEN_ENV_VAR]: "   " } })).toThrow(ConfigError);
  });

  it("rejects a non-numeric numeric setting instead of silently using NaN", () => {
    expect(() => resolveConfig({ env: withToken({ HETZCHAT_TEMPERATURE: "warm" }) })).toThrow(
      /HETZCHAT_TEMPERATURE must be a number/,
    );
  });

  it("does not read the token from the config file", () => {
    const file = { apiKey: "token-from-file-should-be-ignored" } as FileConfig;

    expect(() => resolveConfig({ env: {}, file })).toThrow(ConfigError);
  });
});
