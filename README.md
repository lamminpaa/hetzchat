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
| `--think` / `--no-think` | Toggle thinking mode (undocumented API extension) |
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
| `/think on\|off` | Toggle thinking mode |
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

## Models

Query the live list with `/models`. At the time of writing the API serves
`Qwen/Qwen3.6-35B-A3B-FP8` (MoE, 35B total / 3B active) and `Qwen3.8-27B`
(dense), both with a 262144-token context and both accepting images.

## What this client guarantees

The behaviours worth relying on are written down in [REQUIREMENTS.md](REQUIREMENTS.md)
and each has a test derived from it:

- requests never exceed 10 per 60 seconds, including retries;
- 429s are retried with `Retry-After` honoured, and the retrying stops;
- trimming history never drops the system prompt or orphans an assistant reply;
- the API token never reaches stdout or stderr;
- slash commands never become chat messages;
- a failed turn leaves no dangling user message in history;
- a stream that already printed output is never retried, so no text is doubled.

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
and the model list can change under you. Hetzner states it does not store request
or response content, only usage metrics. `--think` uses an undocumented request
field and may stop working without notice.
