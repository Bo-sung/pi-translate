# pi-translate

A local-LLM translation layer for [pi](https://github.com/earendil-works/pi). Write prompts in your
language; the agent receives them in its own.

> 한국어 문서: [README.ko.md](README.ko.md)

Two things motivate it. A Korean prompt costs roughly two to three times the tokens of the same
prompt in English, because tokenizers are trained mostly on English — translating the prompt first is
a direct saving on every turn. And the answer is easier to read in your own language without giving
up the English the model actually produced.

The important asymmetry: **only the input direction changes what the agent sees.** The translated
answer is stored beside the message as a display-only session entry, so on the next turn the model
re-reads its own words rather than a round trip of its own translation.

It is off until you turn it on, and any single run can override that — which matters for workers.

## Install

```bash
pi install git:github.com/Bo-sung/pi-translate
```

A local checkout works too:

```bash
pi install /path/to/pi-translate
```

You also need a translation model. Anything small and multilingual will do:

```bash
ollama pull exaone3.5:7.8b
```

Then, inside pi:

```
/translate model exaone3.5:7.8b
/translate on
/translate test 이 파일의 main() 함수를 리팩터링해줘.
```

`/translate` on its own shows the configuration and whether the provider actually answers.

## Turning it on and off

Resolution order, first match wins:

| | |
|---|---|
| `--translate` / `--no-translate` | this run |
| `PI_TRANSLATE=on` / `off` | this process, for launchers that cannot pass flags |
| `<project>/.pi/translate.json` | this project (trusted projects only) |
| `~/.pi/agent/translate.json` | global, written by `/translate` |

A worker dispatched to do a job rarely needs translation, so `--no-translate` (or `PI_TRANSLATE=off`)
turns it off without touching your stored settings. When a run is pinned this way, `/translate` says
so instead of silently ignoring a toggle.

`disableWhenOrcaAgent` turns translation off automatically inside a pane [Orca](https://github.com/stablyai/orca)
launched as an agent, which is the worker case again. It is off by default, because you may well want
translation when you talk to that agent yourself.

## Commands

| Command | Effect |
|---|---|
| `/translate` | Status, provider reachability, and how `enabled` was decided |
| `/translate on` / `off` | Master switch, written to the global config |
| `/translate in off` / `out off` | Turn one direction off (`on` to restore) |
| `/translate provider <ollama\|openai\|model>` | Switch back-end |
| `/translate model <name>` | Set the model for the current back-end; with no name, lists Ollama tags |
| `/translate lang <Source> <Target>` | Change the language pair, e.g. `lang Japanese English` |
| `/translate test [text]` | Round trip a sample and show both hops with timings |
| `/translate config` | Print the resolved configuration and its file path |

## Back-ends

```json
{
  "provider": "ollama",
  "ollama": { "endpoint": "http://localhost:11434", "model": "exaone3.5:7.8b", "timeoutSeconds": 60 },
  "openai": { "endpoint": "http://localhost:1234/v1", "model": "qwen2.5-7b", "apiKey": "", "timeoutSeconds": 60 },
  "model":  { "provider": "ollama", "modelId": "qwen2.5:7b", "timeoutSeconds": 60 }
}
```

- `ollama` calls `/api/generate` directly and sets `keep_alive` so the model is not evicted between
  turns. It needs no pi model configuration.
- `openai` calls `/chat/completions` on any OpenAI-compatible server: LM Studio, llama.cpp, vLLM, or a
  cloud endpoint with `apiKey` set.
- `model` reuses a model pi already knows from `models.json`, addressed as `provider` + `modelId`.

## Settings

All fields live in `translate.json`.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch |
| `provider` | `"ollama"` | `ollama`, `openai`, or `model` |
| `sourceLanguage` | `"Korean"` | The language you write and read |
| `targetLanguage` | `"English"` | The language sent to the agent |
| `input` | `true` | Translate prompts — the direction that saves tokens |
| `output` | `true` | Translate answers for display only |
| `showOriginalInput` | `true` | Keep the untranslated prompt in the transcript |
| `pinAnswerLanguage` | `true` | Ask the agent to answer in `targetLanguage` (see below) |
| `translateRpcInput` | `false` | Also translate prompts arriving over RPC |
| `disableWhenOrcaAgent` | `false` | Turn off inside an Orca-launched agent pane |
| `allowRemoteEndpoint` | `false` | Permit a non-loopback endpoint |
| `skipShareThreshold` | `0.2` | Source-script share at which an answer counts as already yours |
| `minInputShare` | `0.05` | Source-script share below which a prompt is treated as machine-generated |
| `maskIdentifiers` | `true` | Hide identifier-shaped tokens from the translation model |
| `preserveTerms` | `[]` | Exact strings to keep verbatim, e.g. `"Claude Code"` |

### Why `pinAnswerLanguage` exists

Only the prompt is translated. Tool output, context files and file contents reach the model in their
original language — translating them would corrupt code and cost far more. So when the agent reads a
Korean document, it answers in Korean, and the output direction degenerates into a same-language round
trip that mangles names. Pinning the answer language keeps the invariant the design assumes.

### Why `minInputShare` exists

Not everything that reaches the input hook is a prompt you typed. Orca injects a 4.7 KB English
worker preamble with your task spec appended; at **1.4%** Korean the whole thing was translated,
which took 12 seconds, rewrote the exact `orca orchestration worker_done` command the preamble tells
the worker to run, and left the agent producing gibberish. Below `minInputShare` the text is passed
through untouched. Any real prompt of yours is far above it.

If a translation comes back with a masked span missing — a 7B model rewriting every `[[6]]` as
`**[6]**`, for instance — the result is discarded and the original text is used. A partially restored
prompt reaching the agent with its commands deleted is worse than no translation at all.

### Why `skipShareThreshold` is 0.2

An answer already in your language should be left alone, decided by what share of its letters belong
to your script. Korean technical writing sits far lower than intuition suggests: a real answer full of
`AgentManager`, `WPF`, `.NET` and `git worktree` measured **0.447**, and the Korean README it came from
measured **0.494**. A half-and-half threshold therefore re-translates plainly Korean text.

## What is and is not translated

- Prompts starting with `/` or `!` are commands, not prose, and pass through untouched.
- Fenced code, inline `` `code` ``, `@file` mentions, and identifier-shaped tokens (`code-rules-check`,
  `AgentManager`, `src/app.ts`) are masked before the text reaches the translation model and restored
  afterwards. Without this a 7B model renames them: `code-rules-check` came back as "코드 규칙 검사",
  which the reader cannot type back.
- Ordinary hyphenated English (`well-known`) is masked by the same rule and stays untranslated. Set
  `maskIdentifiers: false` if that bothers you more than mangled identifiers do.
- Text already in the wanted language is skipped without calling the model.
- Tool calls, tool results and thinking blocks are never translated.
- Latin-script pairs (English to Spanish) cannot be told apart by script, so everything goes to the
  model in that configuration.

Any failure — timeout, unreachable server, empty completion — falls back to the original text and says
so. Translation never blocks a turn.

## Timing

Prompt translation happens before the turn starts, so you wait for it. Answer translation does not
block the agent: it is queued and appended when it arrives, because an assistant message is usually
followed by tool calls and holding those up would stall every turn. Print and JSON runs are the
exception — they exit as soon as the prompt is answered, so there the translation is awaited.

Expect a few hundred milliseconds to a few seconds per message on a warm 7B model.

## Security

Translation sends raw prompt text — source code, file paths, sometimes secrets — to whatever endpoint
is configured, so a non-loopback endpoint requires an explicit opt-in:

```json
{ "allowRemoteEndpoint": true, "ollama": { "endpoint": "http://192.168.1.5:11434" } }
```

Without it, a remote endpoint is reported as not ready and nothing is sent. An endpoint that does not
parse as a URL is treated as remote, not as safe.

## Development

```bash
npm test
```

## License

MIT
