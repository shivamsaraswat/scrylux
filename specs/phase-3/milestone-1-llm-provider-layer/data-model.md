# Data Model: LLM Provider Layer

This milestone adds **no table, column or migration**. Every entity below lives in memory, inside one
process, for one request or for the life of the process. Persisting usage records is Milestone 2's
(jobs). The TypeScript shapes are in [contracts/library-api.md](./contracts/library-api.md); this file
gives the rules.

## Provider configuration (`LlmConfig`)

Parsed once at process start from the environment (and the secrets-manager secret) by
`parseLlmConfig`. It is immutable after that.

| Field | Type | Rule |
|---|---|---|
| `generation` | `OperationConfig \| null` | `null` when `LLM_PROVIDER` is unset (FR-005) |
| `embedding` | `OperationConfig \| null` | `null` when `EMBEDDING_PROVIDER` is unset (FR-009) |
| `timeoutMs` | integer | from `LLM_TIMEOUT`, default 300,000, range 10,000–3,600,000 (FR-010) |

**`OperationConfig`**:

| Field | Type | Rule |
|---|---|---|
| `provider` | `'anthropic' \| 'openai-compatible' \| 'bedrock' \| 'gemini'` | `anthropic` is not allowed for embeddings (FR-002) |
| `model` | string | 1–200 printable characters, no whitespace |
| `baseUrl` | URL \| null | required for, and only for, `openai-compatible`; `https`, or `http` when `local` (FR-003a) |
| `apiKey` | string \| null | required for `anthropic` and `gemini`, optional for `openai-compatible`, refused for `bedrock`. Never logged or exposed (FR-043) |
| `region` | string \| null | required for, and only for, `bedrock` |
| `local` | boolean | `true` only for `openai-compatible` (FR-044a) |
| `hosted` | boolean | derived: `!local` |
| `operatorPrice` | `{ input: number; output: number \| null } \| null` | from `*_PRICE_*`; `output` is `null` for embeddings (FR-033b) |

Invariants:

- A provider's settings that do not apply to it are refused, never ignored ([configuration.md](./contracts/configuration.md)).
- `llmStatus(config)` exposes only `provider`, `model` and `hosted` per operation (FR-045).

## Model capability (`ModelCapability`)

Resolved per `(provider, model)` from `data/models.yaml`, by the first matching entry plus the
provider's `*` defaults.

| Field | Values | Used by |
|---|---|---|
| `temperature` | `send` \| `omit` | FR-015a. `omit` carries `reason` and `source` |
| `structuredOutput` | `native` \| `instructions` | FR-015 |
| `maxTokensParam` | `max_tokens` \| `max_completion_tokens` | OpenAI-compatible only |
| `embeddingBatch` | 1–2048 | FR-018 |
| `embeddingBody` | `titan-v2` \| null | Bedrock embeddings only |

The **runtime override** is a per-process map from `(provider, model)` to
`{ temperature?: 'omit'; structuredOutput?: 'instructions'; maxTokensParam?: 'max_completion_tokens' }`.
It is written when a provider refuses the setting with a 400 (research #4, #6), and is read before the file's entry. It is never persisted.

## Price entry (`PriceEntry`)

From `data/prices.yaml`, or built from the operator's settings.

| Field | Type | Rule |
|---|---|---|
| `provider`, `model` | string | exact match. Unique per provider in the file. An `openai-compatible` entry is OpenAI's own price and applies only when the base address is `api.openai.com` and the provider is not declared local; an Azure deployment, a gateway or a local server is priced by the operator or not at all |
| `input` | number | US dollars per million tokens, ≥ 0 |
| `output` | number \| null | `null` for embedding models |
| `aboveInputTokens` | integer \| null | the optional higher tier's threshold |
| `above` | `{ input; output }` \| null | present exactly when `aboveInputTokens` is |
| `checked` | date | the list's entries only; not in the future |
| `source` | https URL | the list's entries only |
| `origin` | `'operator' \| 'list'` | the operator's price wins (FR-033) |

## Structured request

| Field | Rule |
|---|---|
| `schema` | zod; every object in its JSON Schema has `additionalProperties: false`, or `LlmSchemaError` |
| `schemaName` | `[a-zA-Z0-9_-]{1,64}` |
| `instructions` | non-empty; trusted text written by Scrylux |
| `content` | optional; untrusted (FR-040) |
| `maxOutputTokens` | 1–32,000, default 16,000 (research #7) |
| `attemptLimit` | 1–3, default 3 (FR-014) |
| `signal` | optional `AbortSignal` |

## Embedding request

| Field | Rule |
|---|---|
| `texts` | 1–1,000 non-empty strings |
| `signal` | optional `AbortSignal` |

## Attempt (internal)

One call to a provider, as the layer counts it.

| Field | Meaning |
|---|---|
| `kind` | `first`, `schema_retry` or `transient_retry`. Free resends (temperature, format, output parameter's name) are folded into the attempt they repeat, at most one per setting per request |
| `inputTokens`, `outputTokens`, `estimated` | from the provider, or estimated (research #11) |
| `stop` | `complete`, `length`, `refusal` or `error:<category>` |

## Usage record (`Usage`)

One per request, success or failure (FR-030). It is returned to the caller and written as one log line
(FR-034).

| Field | Rule |
|---|---|
| `attempts` | schema attempts plus transient retries, ≤ 5; `0` when not configured or cancelled before sending. Free resends (≤ 4) are not counted |
| `inputTokens`, `outputTokens` | sums over attempts (FR-031); never 0 for an attempt that reached the provider without reporting usage (FR-032) |
| `tokensEstimated` | true if any attempt's tokens were estimated |
| `costUsd` | the sum over attempts, rounded to 6 decimal places; `null` when no price is known (FR-033) |
| `costEstimated` | true when `costUsd` is computed from estimated tokens |
| `priceSource` | `operator`, `list` or `none` |
| `temperatureApplied` | true if every attempt was sent with temperature 0; `null` for embeddings (FR-015b) |
| `outcome` | `ok` or a `FailureCategory` |

## Request lifecycle

```text
          ┌───────────────── not configured ─────────────────► failed(not_configured), 0 attempts
request ──┤
          └─► attempt ──► answer valid ───────────────────────► ok
                  │  ├──► answer invalid, attempts left ──────► attempt (schema_retry, + retry message)
                  │  ├──► answer invalid, no attempts left ───► failed(invalid_output)
                  │  ├──► cut off / refused / rejected / … ───► failed(category)  (no retry)
                  │  ├──► 429 or 5xx/time limit, < 2 retries ─► wait (abortable) ──► attempt (transient_retry)
                  │  ├──► 429 or 5xx/time limit, 2 used ──────► failed(rate_limited | provider_unavailable)
                  │  └──► 400 naming temperature/format/max_tokens ► free resend adjusted (remembered)
                  └─ signal fired at any point ───────────────► failed(cancelled)
```

Every path ends in exactly one usage record and one log line (SC-004).
