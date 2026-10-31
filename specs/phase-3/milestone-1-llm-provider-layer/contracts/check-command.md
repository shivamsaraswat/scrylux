# Contract: the check command

US6, FR-046 and FR-047. It is the only thing in this milestone that sends a live request.

## Running it

| Where | Command |
|---|---|
| Published image | `docker compose exec app node dist/llm-check.js` (any container from the image: `node dist/llm-check.js`) |
| From source | `pnpm --filter @scrylux/api llm:check` |

It reads the same environment and secrets-manager secret as the server, never the database. It sends
nothing but the fixed request in `packages/llm/prompts/check.yaml`.

## Output

One block per operation, in plain text on stdout:

```text
Generation: anthropic, model claude-sonnet-5-5, hosted (data sent to it leaves this install)
  OK in 1.8 s, 1 attempt, 64 input + 9 output tokens, cost $0.000218 (price list)

Embeddings: openai-compatible, model nomic-embed-text, local (declared with EMBEDDING_LOCAL=true)
  OK in 0.2 s, dimension 768, 9 input tokens (estimated), cost unknown (no price set)
```

When an operation fails, the block names the failure:

```text
Generation: openai-compatible, model llama3.3, hosted (data sent to it leaves this install)
  FAILED: not available. The provider does not know this model, or it is not enabled for this account.
  Check LLM_MODEL. For Ollama, run `ollama pull <model>` first.
  Used: 1 attempt, 0 input + 0 output tokens, cost unknown (no price set)
```

When nothing is configured:

```text
No AI provider is configured. Scrylux runs without AI features. See docs/ai-providers.md.
```

### What each block holds

| Part | Contents |
|---|---|
| First line | The operation, provider, model and hosted or local, with the reason (FR-044) |
| Second line | `OK`, the duration, attempts, tokens (marked estimated where they were) and the cost or `unknown`, with its source (`price list`, `operator price` or `no price set`, from `Usage.priceSource`); or `FAILED:`, the category's fixed message (`FAILURE_MESSAGES`) and one fixed hint per category naming the variable to check. A failed operation then gets a third line, `Used:`, with its attempts, tokens (marked estimated where they were) and cost, because a failed request can have used tokens (FR-046); it is left out when nothing was sent |
| Never | A key, a base address, any part of a provider's error, or the model's answer (FR-043, US6 scenario 4) |

## The layer's log lines

The check runs real requests, so the layer writes its `llm_request` lines (research #13), one per
operation. The check sends them to **stderr**, so stdout holds only the report above and can be read
or piped on its own. The lines carry the same fields as the server's and never more (FR-034). A test
asserts that stdout holds no JSON line and that stderr holds exactly one line per configured
operation.

## Exit status

| Status | When |
|---|---|
| `0` | Every configured operation succeeded, or nothing is configured |
| `1` | At least one configured operation failed |
| `2` | The configuration is invalid. `Invalid AI provider configuration: <the LlmConfigError message>` is printed. For example, an `http` address without `LLM_LOCAL=true` |

## How long it can take

The check uses the configured `LLM_TIMEOUT`. An address that never answers is tried 3 times (FR-022),
so the check can wait up to 3 times the limit, about 15 minutes at the default. An operator who wants
a quicker answer runs it with a shorter limit, for example
`docker compose exec -e LLM_TIMEOUT=30s app node dist/llm-check.js`.

The generation request uses the default output limit of 16,000 tokens, because a reasoning model
counts its reasoning against that limit and a small one would cut the answer off. Its cost is
reported, and on a hosted reasoning model it can reach a few cents.

## Testing seam

`runCheck({ env, stdout, stderr, createLlm })` takes the `createLlm` function as an argument, defaulting
to the real one. Its test passes `createLlmWithEndpoints` from `@scrylux/llm/testing`
([library-api.md](./library-api.md)), so production code never imports the test entry point.
