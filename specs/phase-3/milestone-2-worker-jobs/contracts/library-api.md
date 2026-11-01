# Contract: Changes to `@scrylux/llm`

Two exports are added to `packages/llm/src/index.ts`. Nothing existing changes. Milestone 1's
`specs/phase-3/milestone-1-llm-provider-layer/contracts/library-api.md` stays the reference for the rest.

## `parseLlmStatus(env): LlmStatus`

Applies every rule of `parseLlmConfig` (M1 contracts/configuration.md) in the same order, except that a missing
`LLM_API_KEY` or `EMBEDDING_API_KEY` is allowed. A key that is set is still checked like any other setting. Throws
`LlmConfigError` with the same messages. Returns provider, model and hosted per operation, never a key or an address.
The API's start-up check and `GET /jobs/status` use it (FR-071).

Implemented by giving the existing parser an internal `requireKeys` flag, so the two cannot diverge. A test runs every
case of Milestone 1's configuration table through both and checks that they agree, apart from missing keys.

## `worstCase(config, request): { tokens: number; costUsd: number | null }`

```ts
type WorstCaseRequest =
  | { operation: 'generate'; inputChars: number; maxOutputTokens?: number; attemptLimit?: 1 | 2 | 3 }
  | { operation: 'embed'; inputChars: number };

function worstCase(config: LlmConfig, request: WorstCaseRequest): { tokens: number; costUsd: number | null };
```

The most a request could use (research #7), for FR-042:

- **generate**: `(attemptLimit + 2) × (estimateTokens(inputChars) + maxOutputTokens)` tokens, with the layer's own
  defaults (3 attempts, 16,000 tokens) and its own transient-retry bound. `inputChars` is what `requestSize` gives. Free resends are
  not counted: they follow a 400 that comes before any generation (M1 research #4, #9).
- **embed**: `3 × estimateTokens(inputChars)` tokens: the request and its two transient retries, each over the whole
  input. That over-counts, because the retries belong to one batch and not to all of them, which is the safe side.
- **costUsd**: the tokens priced with the operation's price (operator, then list), using a tiered entry's higher tier;
  null when the price is unknown (M1 FR-033).
- Throws `LlmConfigError` if the operation is not configured.

A helper, `requestSize(request)`, gives `inputChars` for a `StructuredRequest` or an `EmbeddingRequest`, so callers
never measure it themselves: for a structured request, the instructions, the content section with its preamble and
markers, the schema, and `RETRY_ALLOWANCE_CHARS` (8,000), which covers what a retry adds to an attempt (the JSON
instructions of a provider without a native schema, and the note naming what was wrong); for an embedding request, the
total length of the texts. A test fails if the prompts outgrow the allowance.
