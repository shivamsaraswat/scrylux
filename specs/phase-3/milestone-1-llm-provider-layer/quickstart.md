# Quickstart: validating the LLM provider layer

How to show that the milestone works: the automated suites first, then the two manual runs that
SC-003 needs. Contracts: [library-api](./contracts/library-api.md),
[configuration](./contracts/configuration.md), [data-files](./contracts/data-files.md),
[check-command](./contracts/check-command.md).

## 1. Automated suites

```sh
pnpm install
pnpm --filter @scrylux/llm test      # the layer: adapters against stub servers, loop, cost, config, data files
pnpm --filter @scrylux/api test      # startup validation, the check command, the canary test, threat model checks
pnpm run typecheck && pnpm run lint  # lint includes the license check (fast-sha256 exception)
pnpm run test                        # the whole workspace, as CI's required `test` check runs it
```

None of these needs a provider key or network access to a provider (SC-009). The API suite needs the
Postgres of `CONTRIBUTING.md`'s setup, as today.

| Spec item | Shown by |
|---|---|
| US1, FR-013–FR-016, SC-002 | `packages/llm/test/adapters/*.test.ts`: one file per adapter against its stub server, covering success, a schema retry, never-valid, extra fields, a cut-off answer, a refusal, cancellation, and the temperature sent or omitted |
| FR-022, SC-008, SDK retries off | `test/attempts.test.ts`: the stub counts requests; 3 at most against a provider that always answers 500; `retry-after` above 60 seconds fails at once |
| FR-023, SC-007 | `test/attempts.test.ts`: cancel during a hung request and during a wait, and the request ends within 1 second |
| US2, FR-001–FR-011, SC-006 | `test/config.test.ts`: every rule of [configuration.md](./contracts/configuration.md), one case each; messages contain the variable's name and never its value |
| US3, FR-030–FR-034, SC-004, SC-004a | `test/usage.test.ts` and `test/pricing.test.ts`: tokens summed over attempts, estimated when missing, cost from the list and from operator prices, tiers, unknown never 0, one log line per request |
| US4, FR-017–FR-019 | `test/adapters/*-embed.test.ts`: order, splitting into batches, dimension, too-long text with its index, Gemini's one `Content` per text |
| US5, FR-040–FR-043, SC-005 | `test/content-section.test.ts` (forged end marker) and `apps/api/test/llm/canary.test.ts` (fake key, fake content and a fake password in an `http` base address declared local, searched for in all output; adapters built through `@scrylux/llm/testing`; the stub server never sees a value from a vendor variable) |
| FR-043a | `test/config.test.ts` (each SDK variable refuses startup; AWS's endpoint variables refuse it while Bedrock is configured; AWS's credential variables do not) and `test/sdk-env.test.ts` (every vendor variable name in the installed SDKs and their dependencies is refused or exempt) |
| FR-005, SC-001 | `apps/api/test/llm/startup.test.ts` with no AI variables, plus the unchanged v0.1 suite and Playwright tests |
| US6, FR-046–FR-047 | `apps/api/test/llm/check.test.ts`: the command against stub servers; output blocks and exit statuses 0, 1 and 2 |
| FR-033a, FR-015a, FR-041 | `test/data-files.test.ts`: every shipped data file loads; no duplicate model; every `omit` has a reason and a source; Claude on Bedrock mirrors the Anthropic list; each prompt has exactly its placeholders |
| US7, FR-050, SC-010 | `pnpm --filter @scrylux/api exec vitest run test/dogfood`: the updated threat model passes its checks |

## 2. AI off, as v0.1

```sh
docker compose up --build
```

Expected:

- The log shows `AI providers: generation off, embeddings off`.
- `/health` answers 200, and the app behaves as v0.1.
- `docker compose exec app node dist/llm-check.js` prints that no provider is configured and exits 0.

## 3. A misconfiguration stops startup

Start the app with `LLM_PROVIDER=anthropic`, `LLM_MODEL=claude-haiku-5-5` and no `LLM_API_KEY`.
Expected: it exits 1 with
`Startup failed: invalid AI provider configuration: LLM_API_KEY must be set when LLM_PROVIDER is anthropic`.

Repeat with `LLM_PROVIDER=openai-compatible`, `LLM_MODEL=llama3.2`,
`LLM_BASE_URL=http://ollama:11434/v1` and no `LLM_LOCAL`. Expected: it refuses, and the message names
`https` and `LLM_LOCAL`. The check command, run with the same settings, exits 2 with the same message.

With `LLM_PROVIDER=bedrock`, `LLM_MODEL=amazon.nova-lite-v1:0` and `LLM_REGION=us-east-1` passed to the
app, run the check with an AWS endpoint variable. Compose passes only Scrylux's own variables, so set it
on the command itself:

```sh
docker compose exec -e AWS_ENDPOINT_URL=https://example.invalid app node dist/llm-check.js
```

Expected: exit status 2, with a message that names `AWS_ENDPOINT_URL`.

## 4. Live runs (manual, once before the milestone closes; SC-003)

These spend real tokens: a fraction of a cent per run on most models, and up to a few cents on a
hosted reasoning model, which may use much of the 16,000-token output limit for its reasoning. Don't paste a key into a file you might commit:
export it in the shell, or use the compose override in `docs/ai-providers.md`.

**Local, with Ollama:**

```sh
ollama pull llama3.2 && ollama pull nomic-embed-text
export LLM_PROVIDER=openai-compatible LLM_BASE_URL=http://host.docker.internal:11434/v1 LLM_MODEL=llama3.2 LLM_LOCAL=true
export EMBEDDING_PROVIDER=openai-compatible EMBEDDING_BASE_URL=http://host.docker.internal:11434/v1 EMBEDDING_MODEL=nomic-embed-text EMBEDDING_LOCAL=true
docker compose up --build -d && docker compose exec app node dist/llm-check.js
```

Expected:

- Both operations report `OK`.
- Both are marked `local (declared with …_LOCAL=true)`.
- The cost is `unknown`. Setting `LLM_PRICE_INPUT=0` and `LLM_PRICE_OUTPUT=0` makes it `$0.000000` from
  the operator's price.
- The exit status is 0.

**Hosted** (any one provider; Anthropic shown):

```sh
export LLM_PROVIDER=anthropic LLM_MODEL=claude-haiku-5-5 LLM_API_KEY=…   # unset the Ollama variables first
docker compose up -d && docker compose exec app node dist/llm-check.js
```

Expected:

- Generation reports `OK`, marked `hosted (data sent to it leaves this install)`, with a cost from the
  price list.
- The app log shows one `llm_request` line, with no prompt and no key.

Run once with a wrong key. Expected: `FAILED: not authorized`, exit status 1, and the key does not
appear in the output.

Record the date, provider and model of each run in the pull request.
