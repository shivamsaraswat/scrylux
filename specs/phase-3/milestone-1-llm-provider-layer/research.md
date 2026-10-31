# Research: LLM Provider Layer

Phase 0 decisions for [plan.md](./plan.md). Each entry gives the decision, why, and what was
rejected. Spec references are to [spec.md](./spec.md). Facts about provider APIs were checked on
2026-10-19 and 2026-10-20 against the providers' documentation and the SDKs' published type
definitions. Where a source is a third party's, the entry says so.

## 1. Where the layer lives and how it is loaded

**Decision**:

- **The package**: a new workspace package, `packages/llm` (`@scrylux/llm`), the place `plan.md`'s
  repository layout and Principle III reserve for it. It has the same shape as `packages/threat-library`:
  `src/`, `test/`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, and the `@scrylux/source`
  export condition.
- **Data files**: they live in `packages/llm/data/` and `packages/llm/prompts/`. They are listed in the
  package's `files` and read once from a path resolved against the module's own URL, as threat-library
  reads `rules/` and `packages/db` reads `migrations/`.
- **Provider SDKs**: each is loaded with a dynamic `import()` only when its provider is configured,
  as `apps/api/src/config.ts` already does for `@aws-sdk/client-secrets-manager`.
- **The API**: `@scrylux/api` depends on the package. It validates the configuration at startup and
  hosts the check command (#14), because the image ships only `/prod/api` (`pnpm deploy`).
- **The Dockerfile**: its install layer gains `COPY packages/llm/package.json ./packages/llm/package.json`.
  Without it, `pnpm install --frozen-lockfile` fails in the builder stage.

**Rationale**:

- An install with no provider never loads a provider SDK (FR-005), so v0.1's startup cost and its
  attack surface are unchanged.
- Data files resolved from the module are versioned data, not runtime configuration (Principle IV),
  and no install can change them.
- The worker of Milestone 2 imports the same package, with nothing to move.

**Alternatives considered**: putting the layer in `apps/api/src/llm/`. Rejected: Milestone 2's worker
would need to import from an app, and Principle III names `packages/llm`.

## 2. Provider SDKs, and turning off their own retries and timeouts

**Decision**: use the official SDK for each provider, as `plan.md`'s tech stack says.

| Provider | Package | Range | License | Retries off | Per-attempt time limit and cancellation |
|---|---|---|---|---|---|
| Anthropic | `@anthropic-ai/sdk` | `^0.135.0` | MIT | `maxRetries: 0` | `{ timeout: ms, signal }` per request |
| OpenAI-compatible | `openai` | `^7.39.0` | Apache-2.0 | `maxRetries: 0` | `{ timeout: ms, signal }` per request |
| AWS Bedrock | `@aws-sdk/client-bedrock-runtime` | `^3.1152.0` | Apache-2.0 | `maxAttempts: 1` | `requestHandler: { requestTimeout }`; `send(cmd, { abortSignal })` |
| Google Gemini | `@google/genai` | `^2.30.0` | Apache-2.0 | `httpOptions.retryOptions.attempts: 1` | `httpOptions.timeout` (ms); `config.abortSignal` |

Every version was published more than 24 hours before planning, so all pass pnpm's `minimumReleaseAge`.
The AWS range matches the `@aws-sdk/client-secrets-manager` already in `apps/api`, so the two share
`@aws-sdk/core` and the credential chain.

**Added during implementation: `undici` 7 (MIT).** Node's built-in `fetch` gives up after about five
minutes without response headers, whatever timeout an SDK is given. Measured with the OpenAI SDK and a
900-second timeout against a server that answers after 330 seconds: it failed at 301 seconds. A slow
local model answers a non-streaming request only when it is finished, so a `LLM_TIMEOUT` above five
minutes (FR-010) would silently do nothing. The Anthropic, OpenAI and Gemini adapters are therefore
given a `fetch` from `adapters/http.ts`, backed by an `undici` pool whose header and body timeouts are
`LLM_TIMEOUT` plus five seconds. The same probe against the real adapter then succeeded at 330 seconds.
Bedrock's HTTP client has no such limit. `undici` 7 rather than 8, because 8 needs Node 22.19 and the
package says Node 22.

**Rationale**:

- The SDKs retry on their own by default:
  - Anthropic and openai: 2 retries.
  - AWS: the standard retry mode, 3 attempts.
  - Gemini: 5 attempts, per `HttpRetryOptions` in `genai.d.ts`.
- Left on, they would multiply the layer's attempts past FR-022's limit of 3. Usage from attempts the
  layer never sees could not be counted (FR-031), and the per-attempt time limit would be stretched.
- The layer owns every retry (#9). A test counts the requests the stub server receives (#15).
- The Gemini field names come from the installed package's types (`responseJsonSchema`,
  `responseMimeType`, `abortSignal`, `httpOptions.baseUrl`, `httpOptions.timeout`,
  `httpOptions.retryOptions`, `usageMetadata.thoughtsTokenCount`), not from the web docs. The web docs
  now describe a different "Interactions API".

**Alternatives considered**:

- **Plain `fetch` against each REST API.** It would add no dependencies, but every request shape,
  error type, AWS SigV4 signing and the AWS credential chain would be written and maintained by hand.
  Rejected; `plan.md` chose official SDKs.
- **A multi-provider library (an "AI SDK").** That puts a third party's abstraction under Scrylux's
  own interface, which Principle VI asks Scrylux to own, and it adds a layer to every provider bug.
  Rejected.

## 3. Gemini: a native adapter, Developer API only

**Decision**:

- **A fourth adapter**, `gemini`, on `@google/genai`. It is used for generation and for embeddings.
- **The Gemini Developer API** (`generativelanguage.googleapis.com`) with an API key. Its address is
  fixed, so the operator sets no base address.
- **Always hosted**: no local declaration and no `http` (FR-044, FR-044a).
- **Vertex AI is out of scope** (FR-002a).

**Rationale**:

- Google's OpenAI-compatible endpoint is labelled beta ("Support for the OpenAI libraries is still in
  beta while we extend feature support", ai.google.dev/gemini-api/docs/openai, read 2026-10-19). Its
  page shows usage only in a streaming example, and Gemini-specific features need `extra_body`.
- Routing Gemini through the OpenAI-compatible adapter would also let an operator declare it local,
  which it never is. It would also leave its prices keyed to an `openai-compatible` provider.
- Vertex AI needs Google Cloud project and location settings and Application Default Credentials,
  which is the same kind of work as Bedrock. It is left out until an install asks for it.

**Alternatives considered**: Gemini through the OpenAI-compatible adapter with a documented base
address. Rejected for the reasons above. It stays possible: an operator can still point the
OpenAI-compatible adapter at that address, but then Scrylux treats it as an unknown model, hosted, with
no price.

## 4. Structured output, per adapter

**Decision**: every adapter asks its provider to constrain the output to the schema where the
provider supports it. Otherwise it asks for JSON in the instructions (FR-015). In both cases the
layer's own zod validation alone decides whether the answer is valid (FR-013, #5).

| Adapter | Native mechanism | Fallback |
|---|---|---|
| Anthropic | `output_config: { format: { type: 'json_schema', schema } }` on `messages.create`, GA with no beta header. The older `output_format` is deprecated. Supported on every current Claude model, Haiku 4.5 and later | none needed for current models; a model the capability file marks `instructions` uses the fallback |
| OpenAI-compatible | Chat Completions `response_format: { type: 'json_schema', json_schema: { name, schema, strict } }`. `strict: true` only when every object lists all its properties as required (#5) | `response_format: { type: 'json_object' }`, then instructions only |
| Bedrock | Converse `outputConfig.textFormat` `{ type: 'json_schema', structure: { jsonSchema: { schema: <string>, name } } }`, for models whose Bedrock model card lists structured outputs | instructions only, for models the capability file marks `instructions` |
| Gemini | `config.responseMimeType: 'application/json'` with `config.responseJsonSchema` | instructions only |

- **Chat Completions, not OpenAI's Responses API.** Ollama, vLLM and Azure's v1 API all speak Chat
  Completions and `/embeddings`. Azure's v1 API takes the standard client with
  `baseURL: https://<resource>.openai.azure.com/openai/v1/` and the key, with no `api-version`
  (learn.microsoft.com, Azure OpenAI v1 API, updated 2026-06-05).
- **Rejected native formats.** When a provider refuses the native format with a 400 that names it, the
  adapter retries once in the fallback mode and remembers that model for the life of the process (#6).
  This affects older vLLM, servers without `json_schema`, and Bedrock models without structured outputs.
  The 400 comes before any generation, so no output tokens are spent. The resend is not an attempt
  (FR-015b's rule, applied to the format too).
- **No forced tool call is used to get JSON.** Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 return 400
  on a forced `tool_choice`, and every provider now has a JSON-schema output mode. FR-042 allows the
  forced-tool technique, but nothing needs it.
- **Ollama.** Self-hosted Ollama from 0.5 enforces `response_format` `json_schema` with
  grammar-constrained decoding. Ollama Cloud accepts it without enforcing it (a third-party source,
  Pydantic AI's Ollama docs). Either way the answer is checked.

## 5. From a zod schema to each provider's JSON Schema

**Decision**:

- **The caller's schema**: callers pass a zod 4 schema. The layer converts it once per request with
  zod's built-in `z.toJSONSchema(schema, { target: 'draft-2020-12' })`.
- **Strictness check**: the layer requires every object in the caller's schema to refuse unknown keys,
  which is what `z.strictObject` does. A schema that fails this throws a programming error
  (`LlmSchemaError`). It is not a request failure, because it is a bug in the caller. This holds
  FR-013's "no extra fields" whatever the caller wrote.
  **Corrected during implementation**: the check reads the zod definition (an object's catch-all must
  be `never`), not the converted JSON Schema. Measured: `z.toJSONSchema` writes `additionalProperties:
  false` for a plain `z.object` too, while zod still strips unknown keys when it parses, so a check on
  the JSON would have let an answer with extra fields become a success.
- **Per-adapter sanitizing**: each adapter copies the JSON Schema and removes what its provider
  rejects, then sends the copy:
  - **Anthropic and Bedrock** reject numeric limits, length limits, `minItems` above 1, `maxItems` and
    recursive schemas, and require `additionalProperties: false` (platform.claude.com, structured
    outputs; AWS Bedrock user guide, structured output). The removed constraints are written into the
    field's `description` so the model still sees them.
  - **OpenAI's strict mode** requires every property to be listed as required. When a schema has an
    optional property, the adapter sends `strict: false`.
  - **Gemini** accepts its documented subset. Unsupported keywords are removed the same way.
- **What decides validity**: the layer parses the answer with `JSON.parse` and validates it with the
  caller's zod schema. Neither the provider's constraint nor the sanitized copy decides. In fallback
  mode, a single surrounding Markdown code fence is removed before parsing, and nothing else is
  repaired.

**Rationale**:

- Zod is the project's schema language (`packages/core`), and Principle VI requires LLM output to be
  validated against its zod schema.
- One conversion plus one sanitizing step per adapter keeps each provider's quirks in that adapter.
- Validating locally against the original zod schema means a constraint the provider was never told
  about, such as a length limit, is still enforced. A violation becomes an "invalid output" retry with
  the problem described (FR-014).
- **Case of enum values.** Claude's documentation notes that enum and const values may differ only in
  capitalization. Strict validation treats that as invalid, and the retry message names the allowed
  values. The answer is never normalized silently.

## 6. Which models get a temperature: the capability file and the runtime fallback

**Decision**:

- **The capability file**: a versioned data file, `packages/llm/data/models.yaml`. For each provider,
  it maps model-name patterns to:
  - `temperature`: `send` or `omit`, with a `reason` and a `source` for every `omit`.
  - `structured_output`: `native` or `instructions`.
  - For OpenAI-compatible models, `max_tokens_param`: `max_tokens` or `max_completion_tokens`.
  - For embedding models, `embedding_batch`: how many texts one call takes.
- **Lookup**: the first pattern that matches wins. Each provider has a final `*` entry with that
  provider's defaults, so every model resolves to something.
- **Runtime fallback for models the file cannot identify** (Azure deployment names, Ollama and vLLM
  tags, new model ids): when a provider answers 400 and the error names the temperature parameter, the
  adapter resends once without it. That model is then remembered as `omit` for the life of the process,
  and the usage record says the temperature was not applied (FR-015b). The resend is not an attempt.

**Seed entries** (the reason and source for each `omit` go in the file):

- **Anthropic**:
  - `omit` for Claude Fable 5 and 5.1, Opus 4.7, 4.8, 5 and 5.5, and Sonnet 5. These models removed
    the sampling parameters, and a request with any temperature is a 400.
  - `omit` for Sonnet 5.5 and Haiku 5.5. These models refuse any value but the default with a 400.
  - `send` for Opus 4.6, Sonnet 4.6 and Haiku 4.5.
  - Source: the per-model thinking table of the Claude API documentation, as of 2026-10-06.
- **Gemini**:
  - `send` only for `gemini-2.5*`. The `*` default is `omit`.
  - Google's Gemini 3 prompting guide strongly recommends keeping temperature at 1.0 and warns that
    lower values may cause looping or degraded performance. The spec's 2026-10-20 clarification makes
    this count as "does not accept" (FR-015a).
  - The default points this way because the runtime fallback cannot help here: Gemini accepts 0 and
    quietly gets worse. Google's own docs already use newer names (`gemini-3.8-flash`,
    `gemini-4-argon`), so a `gemini-3*` pattern would miss the next generation.
- **OpenAI-compatible**:
  - `omit` for OpenAI's reasoning models (`o1*`, `o3*`, `o4*`, `gpt-5*`), which refuse a non-default temperature.
    (Planned as `o*`; implemented narrower, because `o*` would also match local models such as `orca-mini`, `olmo2`
    and `openhermes` and wrongly send them `max_completion_tokens`.)
  - `max_completion_tokens` for OpenAI's models, which deprecated `max_tokens`.
  - `*`: `send`, with `max_tokens`, the parameter Ollama and vLLM accept.
- **Bedrock**:
  - Claude on Bedrock mirrors the Anthropic entries: each Anthropic pattern appears again as
    `*anthropic.<pattern>`, with the same temperature, reason and source, in the same order and first in
    the Bedrock list ([contracts/data-files.md](./contracts/data-files.md)). A single
    `*anthropic.claude-*` pattern could not tell Opus 4.6 from Opus 5.5. The leading `*` also matches
    inference-profile ids with a geographic prefix (`us.`, `eu.`, `global.`, `in.` and others). A test
    checks that the mirror is complete.
  - `*`: `send`, with structured output `instructions` unless the model is listed as `native`.
  - Prices are matched by exact id, so a profile id is priced only if the list names it. Profiles can be
    priced differently from the base model, so the prefix is never stripped. Otherwise the cost is
    unknown until the operator sets it.
- **A second free resend, for the output parameter's name**: an OpenAI-compatible model that answers
  400 naming `max_tokens` is resent once with `max_completion_tokens`, and remembered. An Azure
  deployment of a reasoning model has a name the file cannot know, so without this it would fail as
  "rejected".

**Rationale**:

- **A fixed list alone** cannot know an Azure deployment name or a local model's tag.
- **The runtime fallback alone** cannot know vendor advice: Gemini 3 accepts 0 and quietly gets worse.
- **Both are needed**, and the file keeps the advice reviewable (Principle IV).
- **Why match on error messages**: the OpenAI SDK's error carries the parameter that failed. Ollama
  and vLLM give only a message, so the check against the word `temperature` is the one place the layer
  matches an error's text. It is limited to 400 answers.

## 7. The output limit, and recognising a cut-off answer

**Decision**:

- **The default output limit is 16,000 tokens**, up from the first draft's 4,096 (spec Assumptions).
  Each adapter sends it under its provider's name for the setting: `max_tokens` (Anthropic),
  `max_tokens` or `max_completion_tokens` (#6), `inferenceConfig.maxTokens` (Bedrock) and
  `maxOutputTokens` (Gemini).
- **A cut-off answer** is recognised by each provider's own signal:
  - Anthropic: `stop_reason === 'max_tokens'`.
  - OpenAI-compatible: `finish_reason === 'length'`.
  - Bedrock: `stopReason === 'max_tokens'`.
  - Gemini: `finishReason === 'MAX_TOKENS'`.
- It then fails as "output limit reached", and the layer does not ask again (spec edge case).

**Rationale**:

- On Claude Opus 5.5, thinking cannot be turned off. Its default effort is medium, and its thinking
  tokens count against `max_tokens`. Gemini 3's thinking tokens are counted in `thoughtsTokenCount`,
  and OpenAI's reasoning tokens count against `max_completion_tokens`.
- At 4,096, an ordinary extraction answer would often be cut off before it began. 16,000 is the
  non-streaming default the Claude API guidance gives, and it stays inside each SDK's non-streaming
  timeout.
- **The caller's ceiling is 32,000 tokens.** Requests are not streamed, and a slow model writing much
  more than that cannot finish inside the 300-second attempt limit. Larger outputs would need streaming,
  which a later milestone can add if extraction needs it. The live run (quickstart §4) times one long
  answer to check the default against the limit.
- **Thinking and effort settings are not configured** (YAGNI). Each model's default applies. If the
  eval harness shows a need, a later milestone can add them through the capability file.

## 8. Mapping provider errors to the spec's categories

**Decision**: each adapter maps its errors to FR-020's categories with one table, and no other code
sees a provider error.

| Category | Anthropic | OpenAI-compatible | Bedrock | Gemini |
|---|---|---|---|---|
| not authorized | `AuthenticationError`, `PermissionDeniedError` | 401, 403 | `AccessDeniedException`, `UnrecognizedClientException`, a missing credential | 401, 403 |
| not available | `NotFoundError` | 404 | `ResourceNotFoundException`, `ValidationException` naming the model or its access | 404 |
| rate limited | `RateLimitError` (honouring `retry-after`) | 429 | `ThrottlingException`, `ServiceQuotaExceededException` | 429 `RESOURCE_EXHAUSTED` |
| provider unavailable | ≥500, 529, connection error, attempt time limit | ≥500, connection, time limit | `InternalServerException`, `ServiceUnavailableException`, `ModelNotReadyException`, time limit | ≥500, network, time limit |
| input too large | 400 or 413 naming the context or request size | 400 `context_length_exceeded` | `ValidationException` naming input length | 400 naming the token count |
| output limit reached | #7 | #7 | #7 | #7 |
| refused | `stop_reason === 'refusal'` | `message.refusal` present, or `finish_reason === 'content_filter'` | `stopReason` `content_filtered` or `guardrail_intervened` | `finishReason` `SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST` or `SPII`, or `promptFeedback.blockReason` |
| rejected | any other 400 the adapter could not work around (#4, #6) | same | same | same |
| cancelled | the caller's signal fired | same | same | same |
| invalid output | #5, after the attempt limit | same | same | same |

**Rationale**:

- A typed failure is all callers need, and FR-020 requires its message to be fixed text. The original
  error is never attached to the failure or logged, because provider errors can echo request content.
- "Rejected" was added to FR-020 during planning: a 400 that is not about size and not about a
  parameter the layer can drop needs a category, and none of the others fits.
- **Usage on failure**: refusals and cut-off answers are billed, so the attempt's reported usage is
  counted (FR-031).

## 9. The attempt loop

**Decision**: one loop per request, in the layer (not in an adapter):

- **Schema attempts**: at most `attemptLimit`, default 3, which the caller may lower to 1 (FR-014).
  After an invalid answer, the next attempt resends the original messages plus one user message from
  `prompts/schema-retry.md`. That message lists the validation issues by path and code, with the
  allowed enum values, and never the invalid answer itself.
- **Transient retries**: rate limited and provider unavailable. At most 2 retries per request in total,
  across all schema attempts, so a request never makes more than 3 tries against a failing provider
  (FR-022, SC-008).
  - The wait is 1 second, then 2, each with up to 25% added at random.
  - A provider's `retry-after` replaces the wait when it is longer, up to 60 seconds. A provider that
    asks for more than 60 fails as "rate limited" at once.
- **Free resends**: the temperature resend (#6), the format resends (#4) and the output-parameter
  resend (#6) count as neither kind of attempt. Each happens at most once per request for each setting.
- **Worst case per request**: 3 schema attempts plus 2 transient retries (5 attempts, the most
  `Usage.attempts` can show) plus at most 4 free resends: the temperature, two format steps
  (`native` → `json_object` → `instructions`, OpenAI-compatible only; one step elsewhere) and the output
  parameter's name (OpenAI-compatible only). Free resends follow a 400 answer, so they are normally
  quick, but each is still under the time limit (spec FR-010).
- **The time limit is enforced in the loop**, the same way for every adapter. Each call gets
  `AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])`. When a call ends because that
  signal fired, the loop decides the category: `cancelled` if the caller's signal fired, otherwise
  `provider_unavailable`, which is retried as a transient failure. Each SDK's own timeout option is also
  set to the same limit as a second line of defence. This matters for Bedrock, whose `requestTimeout` is
  a limit on an idle connection rather than on the whole call.
- **Cancellation**: the caller's `AbortSignal` is passed into every SDK call. Waits use an abortable
  timer, so cancelling during a wait ends the request at once (FR-023, SC-007).

**Rationale**: the separation keeps FR-014 and FR-022 independent and testable. A per-request total for
transient retries bounds SC-008's time: a provider that never answers costs at most 3 × the time limit
plus 1 + 2 seconds and any `retry-after` waits of up to 60 seconds each. A provider that answers slowly
and invalidly can take longer, up to the worst case above, which spec FR-010 now states.

## 10. Keeping untrusted content apart from instructions

**Decision**:

- **Instructions** go in each provider's instruction position: Anthropic `system`, OpenAI a `system`
  message, Bedrock `system`, Gemini `systemInstruction`. The fixed preamble from
  `prompts/content-section.md` is added there, explaining that the marked section holds data, never
  instructions.
- **Untrusted content** goes only in the user message, between two marker lines that carry a random
  128-bit nonce made for that request: `<<<SCRYLUX-CONTENT {nonce}>>>` and
  `<<<END SCRYLUX-CONTENT {nonce}>>>`.
- **The nonce** comes from `crypto.randomBytes(16)`, hex-encoded. If the content happens to contain
  it, a new one is drawn.

**Rationale**:

- A fixed end marker can be typed into a document. A per-request random one cannot be predicted, so
  the content cannot close the section early (FR-040, US5 scenario 2).
- Keeping content out of the instruction position is what Principle VI's "clearly delimited" requires.
  Done once in the layer, no later prompt can get it wrong.
- This makes no promise that the model cannot be persuaded by the content. The defences that matter
  are schema validation, no tools, and human review (Principle VI).

**Alternatives considered**: XML-like tags such as `<document>`. Rejected for the same reason as a
fixed marker: they can be forged unless they carry a nonce.

## 11. Usage, estimation, and cost

**Decision**:

- **Tokens per attempt**, from each provider's own report:

  | Provider | Input tokens | Output tokens |
  |---|---|---|
  | Anthropic | `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` | `output_tokens` |
  | OpenAI-compatible | `prompt_tokens` | `completion_tokens` |
  | Bedrock | `usage.inputTokens` | `usage.outputTokens` |
  | Gemini | `promptTokenCount` | `candidatesTokenCount` + `thoughtsTokenCount`, since thinking is billed as output |
  | Embeddings | OpenAI `usage.prompt_tokens`; Bedrock Titan `inputTextTokenCount` | none |

  Gemini's embed responses carry no usage, so they are estimated.
- **Estimation** when usage is missing: `ceil(characters / 4)`, marked estimated (FR-032). It is never 0.
- **Cost per attempt**: input tokens × input price plus output tokens × output price, per million
  tokens.
  - Prices come from the operator's setting, or else from `data/prices.yaml` (FR-033).
  - A price entry may have one higher tier above an input-token threshold, for Claude Haiku 5.5 above
    100K prompt tokens and Gemini Pro above 200K. The tier is chosen per attempt by that attempt's input
    tokens.
  - The request's cost is the sum over its attempts, rounded to 6 decimal places (micro-dollars).
  - If any attempt's tokens were estimated, the cost is marked estimated.
  - With no price, the cost is `null` ("unknown") and the source `none` (FR-033c).
- **The shipped price list**:
  - It holds well-known models of Anthropic, OpenAI, Bedrock and Gemini, with the price per million
    input and output tokens, `checked` (a date) and `source` (the pricing page's address).
  - The Anthropic entries come from the Claude API's model table, cached 2026-10-06. Examples:
    `claude-opus-5-5` $4 / $20, `claude-sonnet-5-5` $2 / $10, `claude-haiku-5-5` $0.10 / $0.50 up to
    100K prompt tokens and $0.50 / $2.50 above.
  - The OpenAI, Bedrock and Gemini entries are copied from each provider's pricing page on the day of
    implementation and dated then. They are not guessed here.
  - Claude on Bedrock is priced separately (Bedrock's pricing page), so `bedrock` entries never reuse
    the Anthropic ones.

**Rationale**:

- Counting every attempt's tokens, including failed ones, is what a provider bills (FR-031).
- Characters ÷ 4 is the common rough estimate for English text. It only has to be non-zero and
  roughly right for Milestone 2's caps, and it is marked estimated.
- Dated, sourced prices let a reviewer check them, and an operator price fixes a stale one at once
  (spec edge case).

## 12. Configuration

**Decision**: environment variables, validated by one pure function, `parseLlmConfig(env)` in
`@scrylux/llm`. Its errors name the variable and never its value, as `parseSessionConfig` already does.
The variables are listed in [contracts/configuration.md](./contracts/configuration.md).

- **Two sets of variables**: `LLM_*` for generation and `EMBEDDING_*` for embeddings, each with
  `PROVIDER`, `MODEL`, `BASE_URL` (OpenAI-compatible only), `API_KEY`, `LOCAL` (OpenAI-compatible only)
  and `REGION` (Bedrock only).
- **Shared and per-operation settings**: one shared `LLM_TIMEOUT`, in the duration format of
  `SESSION_MAX_LIFETIME`, default `300s`. Operator prices: `LLM_PRICE_INPUT`, `LLM_PRICE_OUTPUT` and
  `EMBEDDING_PRICE_INPUT`, in US dollars per million tokens.
- **Key reuse**: when `EMBEDDING_API_KEY` is unset and the embedding provider and base address equal the
  generation provider's, the generation key is used, so OpenAI for both needs one key. In every other
  case each operation has its own key.
- **Secrets manager**: the existing secret (`DB_SECRET_ID`) may hold `LLM_API_KEY` and
  `EMBEDDING_API_KEY`, which override the environment as its other keys do (FR-008).
  `apps/api/src/config.ts` reads them into the configuration it hands to `parseLlmConfig`.
- **Startup**: `apps/api/src/server.ts` calls `parseLlmConfig` after `config.load()`.
  - On error it logs `Startup failed: invalid AI provider configuration: <message>` and exits 1. The
    message is built only from fixed text and variable names, so it is safe to log. This differs from
    the session check, which logs one fixed line, because FR-006 requires naming the setting.
  - It never contacts a provider (FR-007).

**Rationale**:

- Prefixes per operation make the "generation and embeddings are chosen separately" rule (FR-001)
  visible in the variable names.
- Vendor-named variables such as `ANTHROPIC_API_KEY` were rejected. Every adapter passes the key, the
  address and the region explicitly.
- **The SDKs read far more than keys.** Grepping the installed packages for `readEnv` and `getEnv`
  (2026-10-20) found:
  - **Anthropic**: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`,
    `ANTHROPIC_LOG`, its OpenTelemetry switches including a traces-content mode, and its federation
    and profile variables.
  - **openai**: `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_CUSTOM_HEADERS`,
    `OPENAI_LOG`, `AZURE_OPENAI_API_KEY`, and `AWS_BEDROCK_BASE_URL` for its own Bedrock helper.
  - **genai**: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL`,
    `GOOGLE_GENAI_USE_VERTEXAI` and others.

  Some of these have no constructor option that overrides them, notably the custom-headers and log
  variables, so passing options explicitly is not enough on its own. A stray `OPENAI_API_KEY` could
  ride along to a keyless Ollama over plain `http`. A stray `ANTHROPIC_BASE_URL` could send
  `LLM_API_KEY` to another host. A logging variable could print a prompt.
- **Decision (FR-043a)**: the layer refuses to start while any of these variables is set and a provider
  is configured. Adapters also set every overridable option explicitly. A test scans the installed SDKs
  for the variables they read, so an SDK update cannot add one unnoticed
  ([contracts/configuration.md](./contracts/configuration.md), rule 11). AWS's standard credential,
  profile and region variables are exempt by design, and are listed by name, not by prefix.
- **AWS endpoint variables** (`AWS_ENDPOINT_URL`, `AWS_ENDPOINT_URL_<SERVICE>`): the AWS SDK for
  JavaScript v3 documents them as a way to send a client's requests to another address. They are
  therefore refused while Bedrock is configured. **Verified during implementation (2026-10-21)**: the
  installed Bedrock client's dependency tree (`@smithy/core`) does read `AWS_ENDPOINT_URL` and
  `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS`. (An earlier search of the secrets-manager client alone had found
  nothing, which is why this was marked unverified.) The scan of rule 11 looks for string literals as
  well as `readEnv` and `getEnv` calls, because the AWS SDK reads its variables through configuration
  selectors that a call-name search would miss, and it follows the whole dependency tree. It found about
  ninety vendor-looking names, not a dozen: the Anthropic SDK alone reads over twenty. The final lists
  (`SDK_ENV_PREFIXES`, `SDK_ENV_VARIABLES`, `AWS_EXEMPT_VARIABLES`) are in `packages/llm/src/config.ts`,
  and the names found that are not read are in the test with their reasons. `GOOGLE_SDK_NODE_LOGGING`, a
  logging switch, was added to the refused names.

## 13. The log line

**Decision**: one JSON line per request on stdout, the shape of the write log in
`apps/api/src/v1/write-log.ts`:

```json
{"event":"llm_request","operation":"generate","provider":"anthropic","model":"claude-sonnet-5-5","outcome":"ok","attempts":1,"input_tokens":812,"output_tokens":214,"tokens_estimated":false,"cost_usd":0.003764,"price_source":"list","temperature_applied":false,"cost_estimated":false,"duration_ms":2310}
```

It carries the usage record's fields and nothing else: no prompt, content, answer, key or base address
(FR-034). The server writes it to stdout. The check command writes it to stderr
([contracts/check-command.md](./contracts/check-command.md)).

## 14. The operator check command

**Decision**:

- **Where it lives**: `apps/api/src/llm-check.ts`. It is built to `dist/llm-check.js` and run as
  `node dist/llm-check.js` in the image (or `docker compose exec app node dist/llm-check.js`), or as
  `pnpm --filter @scrylux/api llm:check` from source.
- **What it does**:
  - It loads configuration the way the server does, secrets manager included.
  - It sends the fixed request of `packages/llm/prompts/check.yaml` to each configured operation: a
    short instruction and a one-field schema for generation, and one fixed sentence for embeddings.
  - It prints one block per operation, as described in
    [contracts/check-command.md](./contracts/check-command.md).
  - It exits 0 when every configured operation succeeds, or when none is configured; 1 when a configured
    operation fails; and 2 when the configuration is invalid.
- **What it never touches**: the database. It uses no user data.

## 15. Testing without a real provider

**Decision**:

- **Stub servers**: each adapter is tested against a small `node:http` stub server started by the test.
  The stub plays its provider's REST API with scripted answers: success, schema-invalid, cut-off,
  refusal, 400 naming temperature, 429 with `retry-after`, 500, a dropped connection, a hang.
- **Pointing the SDKs at the stub**: the SDK is aimed at it through its documented base-address option
  (`baseURL` for Anthropic and OpenAI, `httpOptions.baseUrl` for Gemini, `endpoint` for Bedrock with
  static fake credentials). Adapters take the address and credentials as constructor arguments, so
  tests bypass the operator configuration. The configuration has no base-address setting for
  Anthropic, Bedrock or Gemini.
- **What the stub records**: every request it receives, so tests assert the attempt counts (SDK retries
  off), where the instructions and content went, the temperature sent, and the output parameter name.
- **Pure unit tests**: the attempt loop, cost, estimation, configuration parsing, the data-file checks
  and the content markers are tested with no network.
- **The canary test** (SC-005): one fake key and one fake document string run through every outcome.
  Captured stdout and stderr, every failure, every usage record and the check output are searched for
  both.
- **CI**: everything runs in the existing required `test` check through `pnpm -r run test`, with no
  secret and no network to a provider (FR-051, SC-009).
- **Live runs** against a real hosted provider and a real Ollama are manual
  ([quickstart §4](./quickstart.md)), for SC-003.

**Rationale**: a stub server exercises the real SDK, its request shape and its error types, which a
mock of the SDK would not. The constitution forbids repository secrets in CI.

## 16. Licenses

**Decision**: `scripts/license-policy.json` gains one exception, for `fast-sha256` (Unlicense). It
reaches the image through `@anthropic-ai/sdk` → `standardwebhooks`, and the reason will say so. The
allow-list itself is not widened.

**Rationale**:

- Every other new dependency is MIT, ISC, BSD-3-Clause or Apache-2.0. That includes `google-auth-library`
  and its chain (`gaxios`, `gcp-metadata`, `gtoken`, `jws`), `protobufjs`, `ws`, `p-retry`,
  `json-schema-to-ts` and `@opentelemetry/api`.
- The Unlicense is a public-domain dedication, so the risk is negligible. The policy is default-deny,
  and its `exceptions` field exists for exactly this case: naming one package and the reason.
- This is a change to project policy, so the pull request calls it out (Governance).
- The check runs in the required `lint` check, so any other surprise fails there.

## 17. Embeddings, per provider

**Decision**:

| Provider | Call | Texts per call | Notes |
|---|---|---|---|
| OpenAI-compatible | `embeddings.create({ model, input: [...] })` | 256 | Covers OpenAI, Azure, Ollama and vLLM |
| Bedrock | `InvokeModel` with Amazon Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`), body `{ inputText }` | 1 | The only Bedrock embedding family listed in `models.yaml`. Any other fails as "not available" |
| Gemini | `models.embedContent({ model, contents })` | 100 | Each text is passed as its own `Content`, because several texts in one `Content` produce a single combined vector |

- **Calls** are made one after another.
- **Vector dimension**: the provider's default is kept. No dimension setting is added. The result
  reports the dimension, and a vector of a different dimension within one request fails it as
  "rejected".
- **Pieces of a split request** are reassembled in input order (FR-018).

**Rationale**:

- Choosing a dimension, for example to fit a pgvector index, is Milestone 3's decision. It is noted
  there because Gemini's default is 3,072 dimensions.
- Concurrent calls would make large lists faster, but nothing sends large lists until Milestone 3.

## 18. Threat model and documentation updates

**Decision**:

- **Constitution, Threat Model section**: `MINOR` 1.13.1 → 1.14.0, with a Sync Impact Report.
  - Provider API keys (and the AWS role used for Bedrock) move from planned to current assets.
  - The outbound connection to a hosted model provider becomes a current boundary, reached in this
    milestone only by the operator's check.
  - FR-050's four risks are added under Spoofing, Tampering, Information Disclosure and Denial of
    Service.
  - Google joins the list of hosted vendors.
- **`docs/threat-model/`** is updated by the README's own procedure (import, edit, generate, decide,
  download both files), checked by `apps/api/test/dogfood`. The model gains an external entity
  "LLM provider (hosted)" and a data flow from "Scrylux API" to it across a trust boundary, plus their
  generated threats, each decided. The README's sentence that Phase 3's last milestone adds LLM
  providers is corrected.
- **`docs/install.md`**: new rows in the environment variable table.
- **`docs/ai-providers.md`** (new): a working configuration for each provider; hosted and local, and
  the local declaration; the data-use note for the Gemini API's unpaid tier (FR-011); the check command.
- **`plan.md` and `docs/roadmap.md`**: the Milestone 1 adapter list gains Gemini, and `plan.md`'s
  competitive table's LLM row names Gemini.
- **`CHANGELOG.md`**: an Unreleased entry.
- **`README.md`**: the documentation table links the new page.
