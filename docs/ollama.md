# Ollama provider adapter

SponsorRail v0.7 adds a local-first adapter for Ollama's chat API.

## Requirements

- Node.js 20 or newer
- Ollama running locally
- an installed Ollama model

## Example

```bash
OLLAMA_MODEL=<installed-model> npm run demo:ollama
```

Optional environment variables:

```text
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=<installed-model>
SPONSORRAIL_PROMPT=Write a tiny health-check function.
SPONSORRAIL_OUTPUT_BUDGET=256
```

## Request shape

The adapter sends a non-streaming `POST /api/chat` request.

Private task and repository context are placed in the chat message because the compute provider needs them to perform the task.

Sponsor identity and sponsor instructions are not included.

## Metering

Ollama returns prompt-token and generated-token counters.

SponsorRail v0.7 bills only generated output tokens:

```text
computeUnitsUsed = eval_count
usageMetric = ollama-output-tokens
```

The adapter also returns non-billing telemetry:

- prompt tokens
- cached prompt tokens
- total tokens
- total duration
- model load duration
- prompt evaluation duration
- generation duration

Why not bill prompt tokens yet? Because the generated-token ceiling can be enforced before execution with `num_predict`. The exact prompt-token count is only known from Ollama after tokenization/execution. SponsorRail prefers an enforceable contract over pretending an after-the-fact number was pre-authorized.

## Endpoint policy

Default:

```text
http://127.0.0.1:11434
```

Loopback endpoints work without additional flags.

A non-loopback endpoint requires:

```js
allowRemote: true
```

A non-loopback plaintext HTTP endpoint additionally requires:

```js
allowInsecureRemote: true
```

This is deliberately annoying. Accidentally sending private repository context across a network should be harder than keeping it local.

## Model allowlist

By default the allowlist contains only the configured model.

A wider explicit allowlist can be supplied when an application supports multiple pre-approved models.

## Failure handling

The adapter fails closed on:

- model not in allowlist
- disallowed remote endpoint
- request timeout
- HTTP error
- incomplete Ollama response
- usage above grant authority
- invalid provider signature or grant binding

Provider failure causes SponsorRail to release the sponsor reservation.

## CI strategy

CI does not require Ollama or model weights.

Tests inject a mock `fetchImpl` and verify the exact HTTP request, privacy boundary, metering, model policy, timeout behavior, and accounting rollback. A live Ollama run remains an operator qualification step.
