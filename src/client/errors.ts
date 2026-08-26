import { RetryableError } from "../retry.js";

/**
 * R9: raised when a stream fails after it has already printed output. Never
 * retryable — retrying would print the opening of the answer twice.
 */
export class StreamInterruptedError extends Error {
  constructor(
    readonly printedChars: number,
    override readonly cause: unknown,
  ) {
    super(
      `The response was cut off after ${printedChars} characters. ` +
        `Partial output is kept above; ask again to get a full answer.`,
    );
    this.name = "StreamInterruptedError";
  }
}

export class InferenceError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "InferenceError";
  }
}

/**
 * R2: 429 and 5xx are transient and worth another attempt; so are transport
 * failures with no status at all. Everything else is the caller's fault and
 * retrying only burns rate-limit budget.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof StreamInterruptedError) return false;

  const status = statusOf(error);
  if (status === undefined) return isTransportFailure(error);
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function statusOf(error: unknown): number | undefined {
  if (error instanceof RetryableError) return error.status;
  if (error instanceof InferenceError) return error.status;

  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

const TRANSPORT_FAILURE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "APIConnectionError" || error.name === "APIConnectionTimeoutError") {
    return true;
  }

  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && TRANSPORT_FAILURE_CODES.has(code)) return true;
  }
  return false;
}

/** Turns any thrown value into a message safe to show, with no token in it. */
export function describeError(error: unknown): string {
  if (error instanceof StreamInterruptedError) return error.message;

  const status = statusOf(error);
  const base = error instanceof Error ? error.message : String(error);

  switch (status) {
    case 401:
    case 403:
      return `The API rejected the token (HTTP ${status}). Check the token in the Hetzner Experiments dashboard.`;
    case 404:
      return `The API has no such endpoint or model (HTTP 404). Run /models to see what is served.`;
    case 429:
      return `Rate limited (HTTP 429) and out of retries. Hetzner allows 10 requests per minute per token.`;
    default:
      return status === undefined ? base : `HTTP ${status}: ${base}`;
  }
}
