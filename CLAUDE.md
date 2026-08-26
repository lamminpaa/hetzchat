# hetzchat

Terminal chat client for the Hetzner Experiments Inference API.

## Stack

TypeScript (ESM, NodeNext), Node 24, vitest, Docker. The only runtime
dependency is `openai` — the Hetzner API is OpenAI-compatible.

Note: TypeScript 7 needs `"types": ["node"]` set explicitly in `tsconfig.json`;
without it `node:*` imports fail to resolve.

## API facts

- Base URL `https://inference.hetzner.com/api/v1`, `Authorization: Bearer <token>`
- Endpoints: `/models`, `/chat/completions`, `/completions`
- Rate limit per token per 60 s: 10 requests, 4M input tokens, 100k output tokens
- Free while experimental; no SLA; request/response content is not stored
- `enable_thinking` is an undocumented request field, sent only when `/think` is on

## Layout

```
src/
  rateLimiter.ts     sliding window, serialised so concurrent callers cannot slip past
  retry.ts           bounded retry, Retry-After parsing, exponential backoff
  redact.ts          secret blinding
  conversation.ts    history, exchange-wise trimming, transcript export
  config.ts          flag > env > file > default resolution
  session.ts         one turn: ask, print, store, roll back on failure
  client/            transport (OpenAI SDK) and the client that composes limit + retry
  cli/               args, output chokepoint, slash commands, REPL, Markdown renderer
  tools/             tool definitions, the root-confined path resolver, the runner
```

## Working on this

`REQUIREMENTS.md` is the contract. Every test names the requirement it guards
in its `describe` block. When changing behaviour, change the requirement first,
then the test, then the code.

Tests are verified by mutation: break the behaviour a test guards and confirm
the test fails. A test that survives its mutation is not guarding anything.

Two things that are easy to get wrong here:

- `readline`'s async iterator drops lines already buffered when the input
  stream ends, which loses every REPL turn after the first on a pipe. `LineQueue`
  in `cli/repl.ts` exists for that; do not replace it with `for await (const line of rl)`.
- Retries must go through the rate limiter. A retry that skips it is exactly the
  request the server is already refusing.
- Tool call ids in test fixtures must be unique across responses. Reusing one
  lets an unanswered call match an answered one and hides an R15 violation;
  that is why the R15 assertion is positional rather than set-based.
- The Markdown renderer must withhold input whenever a decision depends on
  characters that have not arrived. Anything else makes output depend on how
  the network chunked the response.
