import { Output } from "../../src/cli/output.js";
import { createRedactor } from "../../src/redact.js";

export interface CapturedOutput {
  output: Output;
  stdout(): string;
  stderr(): string;
}

export function captureOutput(secrets: string[] = []): CapturedOutput {
  let out = "";
  let err = "";

  const output = new Output({
    stdout: { write: (chunk: string) => void (out += chunk) },
    stderr: { write: (chunk: string) => void (err += chunk) },
    redact: createRedactor(secrets),
    color: false,
  });

  return { output, stdout: () => out, stderr: () => err };
}
