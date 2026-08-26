# hetzchat

Terminal chat client for the [Hetzner Experiments Inference API](https://docs.hetzner.com/general/company-and-policy/experiments/inference/).

The API is OpenAI-compatible, free while it stays experimental, and capped at
**10 requests per 60 seconds per token**. That cap is the thing that shapes this
client: requests are queued against a sliding window rather than fired and
retried, so a session degrades into waiting instead of into 429s.

## Quick start

```sh
npm install
npm run build

export HETZNER_INFERENCE_TOKEN=...   # from the Hetzner Experiments dashboard
node dist/index.js "What changed in the EU AI Act in 2026?"
```

Or interactively:

```sh
node dist/index.js
```

## With Docker

```sh
cp .env.example .env        # fill in HETZNER_INFERENCE_TOKEN
docker compose run --rm hetzchat
```

One-shot inside the container:

```sh
docker compose run --rm hetzchat "summarise the CAP theorem in three lines"
```

Transcripts written with `/save` land in `./transcripts`.

## Usage

```
hetzchat                     Start an interactive session
hetzchat "your question"     Ask once, print the answer, exit
echo "question" | hetzchat   Same, reading the prompt from stdin
```

| Flag | Meaning |
| --- | --- |
| `-m, --model <name>` | Model to use |
| `-s, --system <prompt>` | System prompt |
| `-t, --temperature <n>` | Sampling temperature |
| `--max-output-tokens <n>` | Cap on response length |
| `--base-url <url>` | Override the API base URL |
| `--config <path>` | Config file to read |
| `-i, --interactive` | Run the session loop even on piped stdin |
| `--stream` / `--no-stream` | Stream the response as it arrives |
| `--markdown` / `--no-markdown` | Style the model's Markdown in the terminal |
| `--think` / `--no-think` | Show the model's reasoning, which it always produces |
| `--tools` / `--no-tools` | Let the model call local tools |
| `--allow-tool <name>` | Pre-authorise a tool; repeatable. Implies `--tools` |
| `-v, --verbose` | Report retries, throttling and token usage |

### Session commands

| Command | Meaning |
| --- | --- |
| `/help` | List the commands |
| `/model [name]` | Show or switch the model |
| `/models` | List what the API is serving |
| `/system [prompt]` | Show or replace the system prompt |
| `/clear` | Forget the conversation so far |
| `/temp [n]` | Show or set the sampling temperature |
| `/stream on\|off` | Toggle streaming |
| `/think on\|off` | Show the model's reasoning |
| `/tools on\|off` | Show or toggle the model's access to local tools |
| `/image <path>` | Attach an image to the next message |
| `/save [path]` | Write the transcript to Markdown |
| `/usage` | Token usage and remaining rate-limit budget |
| `/exit`, `/quit` | Leave |

A line starting with `//` is sent as a message beginning with a single `/`,
so `//usr/bin is on my PATH` reaches the model intact.

## Configuration

Precedence: CLI flags, then environment, then config file, then defaults.

| Variable | Meaning |
| --- | --- |
| `HETZNER_INFERENCE_TOKEN` | API token (required) |
| `HETZNER_INFERENCE_BASE_URL` | Base URL, default `https://inference.hetzner.com/api/v1` |
| `HETZCHAT_MODEL` | Default model |
| `HETZCHAT_SYSTEM` | Default system prompt |
| `HETZCHAT_TEMPERATURE` | Default temperature |
| `HETZCHAT_MAX_OUTPUT_TOKENS` | Default response cap |
| `HETZCHAT_CONTEXT_BUDGET` | History budget in estimated tokens |
| `HETZCHAT_MAX_ATTEMPTS` | Attempts per request before giving up |
| `HETZCHAT_STREAM` | `on` / `off` |
| `HETZCHAT_MARKDOWN` | `on` / `off` |
| `HETZCHAT_TOOLS` | `on` / `off` |
| `HETZCHAT_MAX_TOOL_ROUNDS` | Tool rounds allowed per turn |
| `HETZCHAT_ALLOW_TOOLS` | Comma-separated tools to pre-authorise |
| `HETZCHAT_VERBOSE` | `on` / `off` |

A `.env` file in the working directory is loaded automatically. The config file
lives at `$XDG_CONFIG_HOME/hetzchat/config.json` (default
`~/.config/hetzchat/config.json`) and holds everything except the token:

```json
{
  "model": "Qwen3.8-27B",
  "systemPrompt": "Answer in Finnish unless asked otherwise.",
  "temperature": 0.3
}
```

## Tools

With `--tools`, the model can call local tools and use the results to answer.
Tools are off by default.

| Tool | What it does | Authorisation |
| --- | --- | --- |
| `read_file` | Read a text file | Runs directly |
| `list_files` | List a directory | Runs directly |
| `run_shell` | Run a shell command | Asks first |
| `fetch_url` | Fetch an http/https URL | Asks first |

`read_file` and `list_files` are confined to the directory you started in.
A path that escapes it — by `..`, by being absolute, or through a symlink — is
refused, and the refusal is reported back to the model rather than dropped.
`read_file` also refuses `.env` and `.env.*`, since that is where this CLI
reads its own token from, and every tool result is passed through the redactor
before it enters the conversation.

Anything that writes, executes or reaches the network asks before it acts:

```
> summarise the test failures
run_shell wants to run: npm test  (in /home/you/project)
Allow? [y/N] y
```

Answering anything but `y` refuses the call and tells the model so, which is
usually enough for it to carry on without that tool. Single-shot runs have
nobody to ask, so they refuse; pre-authorise a specific tool for scripting:

```sh
hetzchat --allow-tool run_shell "which tests are failing and why?"
```

Each turn is capped at `HETZCHAT_MAX_TOOL_ROUNDS` (default 6) rounds of tool
use, so a model that keeps asking for tools stops rather than spending the
rate-limit budget in a loop.

## Models and reasoning

Query the live list with `/models`. The API serves `Qwen/Qwen3.6-35B-A3B-FP8`
(MoE, 35B total / 3B active) and `Qwen3.8-27B` (dense), both with a
262144-token context and both accepting images.

**Both models always reason before answering.** The chain of thought comes back
in a separate `reasoning` field, and it is charged against `max_tokens`. A
one-sentence answer routinely costs 150 completion tokens, of which 500-odd
characters are reasoning you never asked for.

`--think` shows it. It does not turn it on or off — nothing does. In particular
`enable_thinking: false`, which some write-ups suggest, is silently ignored by
the served models, so this client does not send it.

The practical consequence is that a small `--max-output-tokens` can be spent
entirely on thinking, leaving no answer at all. Asked to explain the CAP theorem
with a 400-token cap, the model produced 1838 characters of reasoning, stopped
on `length`, and returned no content. When that happens the client says so
rather than showing you an empty reply.

## What this client guarantees

The behaviours worth relying on are written down in [REQUIREMENTS.md](REQUIREMENTS.md)
and each has a test derived from it:

- requests never exceed 10 per 60 seconds, including retries;
- 429s are retried with `Retry-After` honoured, bounded in attempts and in
  wall-clock time, and cancellable mid-backoff;
- trimming history never drops the system prompt or orphans an assistant reply;
- the API token never reaches stdout or stderr;
- slash commands never become chat messages;
- a failed turn leaves no dangling user message in history;
- a stream that already printed output is never retried, so no text is doubled;
- no tool definitions are sent unless tools are on;
- a tool that writes, executes or fetches never runs without an explicit yes;
- file tools cannot reach outside the directory you started in;
- the tool loop is bounded, and every tool call keeps its result attached;
- tool results never carry the token back to the API or into a transcript;
- `run_shell` and `fetch_url` are bounded in time and output size, and a
  cancelled or truncated run is reported as such rather than as a normal result;
- Markdown styling is identical however the response was split into deltas;
- reasoning is never stored in history or sent back to the model;
- a response that spent its whole budget thinking explains itself.

## Development

```sh
npm run dev          # run from source
npm run typecheck
npm run test         # typecheck, build, then unit + e2e
npm run test:unit
npm run test:e2e     # drives the built CLI against a mock inference server
```

The e2e suite spawns the real binary against a local OpenAI-compatible mock, so
streaming, retries, exit codes and token redaction are exercised as a user would
hit them.

## Caveats

The Inference API is an experiment: no SLA, no billing, no production guarantee,
and the model list can change under you. Hetzner states it does not store
request or response content, only usage metrics.

Verified against the live API: both documented models are served, tool calling
works, the streaming format uses `data:{...}` with no space after the colon,
and reasoning arrives in a `reasoning` field rather than the `reasoning_content`
that vLLM usually emits. None of that is contractual.
