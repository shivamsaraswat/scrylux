# Contract: `@scrylux/llm` library API

What other Scrylux code may import from `@scrylux/llm` (`packages/llm/src/index.ts`). Everything else
in the package is internal. Spec references are to [../spec.md](../spec.md); entities are described in
[../data-model.md](../data-model.md).

## Configuration

```ts
export function parseLlmConfig(env: Readonly<Record<string, string | undefined>>): LlmConfig;
```

- **Pure**: reads only `env`, and never contacts a provider (FR-007).
- **Errors**: throws `LlmConfigError` on the first invalid setting. Its `message` names the variable
  and the problem, never a value, so it is safe to log (FR-006).
- **No provider**: with no `LLM_*` and no `EMBEDDING_*` variables set, it returns
  `{ generation: null, embedding: null, timeoutMs }` (FR-005).
- **Rules**: see [configuration.md](./configuration.md).

```ts
export function llmStatus(config: LlmConfig): LlmStatus;

interface LlmStatus {
  generation: { provider: ProviderName; model: string; hosted: boolean } | null;
  embedding: { provider: ProviderName; model: string; hosted: boolean } | null;
}
```

`llmStatus` returns what the rest of Scrylux may know about the configuration, and no key or address
(FR-045). From Milestone 8 the UI's notice reads `hosted` from it.

## The client

```ts
export function createLlm(config: LlmConfig, options?: { log?: (line: string) => void }): Llm;

interface Llm {
  generate<T>(request: StructuredRequest<T>): Promise<GenerateResult<T>>;
  embed(request: EmbeddingRequest): Promise<EmbedResult>;
}
```

- **`createLlm`** does no I/O and loads no SDK. An adapter's SDK is loaded the first time that operation
  is used.
- **Statelessness**: the client keeps no state between requests, apart from the per-process memory of
  models that refused a temperature or a native output format (research #6). That memory only
  removes the free resend.
- **`log`** defaults to writing one line to `console.log`. Tests pass their own to capture lines.

### `generate`

```ts
interface StructuredRequest<T> {
  schema: z.ZodType<T>;          // every object strict (z.strictObject), or LlmSchemaError is thrown
  schemaName: string;            // [a-zA-Z0-9_-]{1,64}; some providers require a name for the schema
  instructions: string;          // goes in the provider's instruction position
  content?: string;              // untrusted; goes only inside the marked content section (FR-040)
  maxOutputTokens?: number;      // integer 1..32000, default 16000 (non-streaming; research #7)
  attemptLimit?: 1 | 2 | 3;      // default 3 (FR-014)
  signal?: AbortSignal;          // cancellation (FR-023)
}

type GenerateResult<T> =
  | { ok: true; value: T; usage: Usage }
  | { ok: false; failure: Failure; usage: Usage };
```

- **Returns** `ok: true` only with a value that passed `schema.parse` (FR-013).
- **Never rejects** for a provider or network problem: every such problem is an `ok: false` result with
  a category (FR-020).
- **Throws** only for a programming error: `LlmSchemaError` (the schema is not strict, or `schemaName`
  is malformed) or `RangeError` (an argument out of range). Both are thrown before any request is sent.
- **No generation provider configured**: resolves at once to `ok: false` with
  `failure.category === 'not_configured'` and a zero-attempt usage record, without contacting a provider.

### `embed`

```ts
interface EmbeddingRequest {
  texts: readonly string[];      // 1..1000 non-empty strings
  signal?: AbortSignal;
}

type EmbedResult =
  | { ok: true; vectors: number[][]; model: string; dimension: number; usage: Usage }
  | { ok: false; failure: Failure; usage: Usage };
```

- **Success**: `vectors.length === texts.length`, in input order, and every vector has `dimension`
  entries (FR-017, FR-018).
- **A text too long for the model** gives `failure.category === 'input_too_large'`, and `failure.index`
  is its position (FR-019).
- **The 1,000-text limit** is a guard against accidental unbounded calls. Milestone 3 may change it when
  it knows its chunk counts.

### `Failure`

```ts
type FailureCategory =
  | 'not_configured' | 'not_authorized' | 'not_available' | 'rate_limited'
  | 'provider_unavailable' | 'input_too_large' | 'output_limit_reached'
  | 'refused' | 'rejected' | 'invalid_output' | 'cancelled';

interface Failure {
  category: FailureCategory;
  message: string;               // fixed text per category, from FAILURE_MESSAGES
  index?: number;                // embed only: the position of the text that was too long
}
```

- **The message**: `FAILURE_MESSAGES` is exported, so the check command and later the UI show the same
  text.
- **What a failure never carries** (FR-020): the provider's error, a key, an address, the prompt, the
  content or an answer.

### `Usage`

```ts
interface Usage {
  operation: 'generate' | 'embed';
  provider: ProviderName | null;     // null when not configured
  model: string | null;
  outcome: 'ok' | FailureCategory;
  attempts: number;                  // schema attempts + transient retries; free resends excluded
  inputTokens: number;
  outputTokens: number;              // 0 for embed
  tokensEstimated: boolean;
  costUsd: number | null;            // null = unknown, never 0 for unknown (FR-033)
  costEstimated: boolean;
  priceSource: 'operator' | 'list' | 'none';
  temperatureApplied: boolean | null; // null for embed
  durationMs: number;
}
```

## The test entry point: `@scrylux/llm/testing`

Tests in `packages/llm` and `apps/api` need adapters pointed at stub servers. The Anthropic, Gemini and
Bedrock addresses cannot be set through the environment (configuration rule 3), so the package has a
second entry point for tests only:

```ts
// packages/llm/testing/index.ts (outside src/, so it is never built or shipped)
export function createLlmWithEndpoints(
  config: LlmConfig,
  options: { log?: (line: string) => void; endpoints: TestEndpoints },
): Llm;

interface TestEndpoints {
  anthropic?: { baseURL: string };
  gemini?: { baseUrl: string };
  bedrock?: { endpoint: string; credentials: { accessKeyId: string; secretAccessKey: string } };
}

export function resetCapabilityOverrides(): void;
```

- **Never shipped**: `package.json` exports `"./testing"` with only the `@scrylux/source` condition, so
  it resolves in typechecks and tests, and nothing outside the source tree can import it. The file sits
  outside `src/`, so `tsc -p tsconfig.build.json` does not compile it, and `files` does not include it.
- **What it changes**: only where each adapter sends its requests, and for Bedrock the static
  credentials. Everything else runs as `createLlm` runs it. The OpenAI-compatible adapter needs no
  override, because its base address is configuration.
- **Also exported**: the stub servers and their scripted answers for each provider (`startStub`, `anthropicMessage`, `openaiCompletion`, `converseAnswer`, `geminiAnswer` and the error and embedding forms), so that `apps/api`'s tests use the same ones; and an optional `deps` that replaces the retry loop's waits, so a test of a transient failure does not sleep.
- **Built directly**: `createLlmWithEndpoints` does not run `parseLlmConfig`, so a test can set vendor
  variables in `process.env` and show that the adapters ignore them (the canary test).
- **Production code** never imports it. The check command takes a `createLlm` function as an argument,
  defaulting to the real one, and its test passes `createLlmWithEndpoints`.

## What the package does not export

- **No tools, and no way to pass tools** (FR-042).
- **No raw provider client**, and no streaming.
- **No prompt or response logging switch**: that is Milestone 8's.
- **No way to set temperature, thinking or effort** (FR-015a).
