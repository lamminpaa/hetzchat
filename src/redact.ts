/**
 * R4: the API token must never reach the terminal. Redaction runs at the single
 * output chokepoint, so a token that leaks into an error message anywhere
 * upstream is still caught on the way out.
 */

const PLACEHOLDER = "[redacted]";

/** Secrets shorter than this are too generic to blind-replace in output. */
const MIN_SECRET_LENGTH = 8;

export type Redactor = (text: string) => string;

export function createRedactor(secrets: readonly (string | undefined)[]): Redactor {
  const usable = secrets
    .filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH)
    // Longest first, so a token that contains another secret as a substring is
    // replaced whole rather than left as a recognisable fragment.
    .sort((a, b) => b.length - a.length);

  if (usable.length === 0) return (text) => text;

  return (text) => {
    let out = text;
    for (const secret of usable) out = out.split(secret).join(PLACEHOLDER);
    return out;
  };
}
