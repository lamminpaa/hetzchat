# Requirements

Guarantees the code must uphold. Every test in `tests/` asserts one of these,
and is derived from the requirement rather than from the implementation.

## R1 — Rate limit compliance

Hetzner allows 10 requests per rolling 60 second window per API key. The client
must never issue an 11th request inside any such window; it waits instead.
Concurrent callers must not slip past the limit together.

Source: Hetzner Inference API docs, "Rate limits" (10 requests / 4M input tokens
/ 100k output tokens per 60 s, HTTP 429 over that).

## R2 — Bounded 429 handling

On HTTP 429, the client retries with exponential backoff, honouring the
`Retry-After` header when present (delta-seconds or HTTP-date). Retries are
bounded: after the configured attempt budget is spent the error is surfaced.
The client must never retry indefinitely.

## R3 — Trimming preserves conversation structure

When history is trimmed to fit the context budget:

- the system message survives every trim;
- the remaining history never begins with an assistant turn, so oldest entries
  are dropped as whole user/assistant exchanges;
- the newest user message is never dropped.

## R4 — The API token never reaches the terminal

The token must not appear in stdout, stderr, or any error text the CLI prints,
including in verbose mode. Redaction is enforced at the single output
chokepoint so a leak anywhere upstream is still caught.

## R5 — Slash commands stay local

Input beginning with `/` is dispatched to the local command handler and is
never sent to the model as a chat message. `//` at the start of a line escapes
a literal leading slash, so a message that genuinely starts with `/` can still
be sent.

Commands that exist to query the API (`/models`) do call it — what R5 forbids
is command text leaking into the conversation.

## R6 — Streaming fidelity

The text assembled from stream deltas is exactly the text appended to history:
what the user saw is what the model is later told it said.

## R7 — A failed turn leaves history clean

If a turn fails after its retry budget is spent, the user message entered for
that turn is rolled back out of history, so the next request does not carry a
dangling user message with no reply.

## R8 — Configuration precedence and fail-fast

CLI flags override environment, environment overrides config file, config file
overrides built-in defaults. A missing API token exits non-zero with a message
naming the environment variable to set.

## R9 — Mid-stream failures are not retried

Once any output for a turn has been shown to the user, a later failure in that
same turn is surfaced rather than retried, so text is never printed twice.
