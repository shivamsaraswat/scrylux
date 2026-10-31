# Pull request: LLM provider layer (Phase 3 / Milestone 1)

Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md) · Tasks: [tasks.md](./tasks.md) · Research: [research.md](./research.md)

## Summary

This adds the layer that every AI feature of Phase 3 will call to reach a language model, and **no AI feature yet**. Nothing in Scrylux
sends user content to a model. With no AI setting made, Scrylux starts, answers `/health` and behaves exactly as v0.1 does, and never
connects to a model provider.

- **`packages/llm` (`@scrylux/llm`)**, one interface for two operations: a structured result (a zod schema in, a validated object or
  a typed failure out) and embeddings (texts in, vectors out, in order).
- **Four adapters**, each on its provider's official SDK, loaded only when that provider is configured, with the SDK's own retries
  turned off: Anthropic; OpenAI-compatible (OpenAI, Azure OpenAI, Ollama, vLLM through a base address); Amazon Bedrock; and
  **Google Gemini** (Developer API with an API key), which the maintainer added at planning.
- **One attempt loop for all of them**: at most 3 schema attempts, at most 2 transient retries per request, an abortable wait, a
  per-attempt time limit (300 s, configurable) and cancellation. A model that refuses a temperature, an output format or the name of
  its output limit is sent the request again without it (not an attempt), and remembered for the life of the process.
- **Usage and cost for every request**: tokens over every attempt (estimated and marked when a server reports none), a cost from the
  operator's price or a dated, sourced price list, and **unknown, never zero**, when no price exists. One JSON log line per request.
- **Sixteen environment variables** (all optional), the compose files that pass them through, `docs/install.md`'s table, and a new
  [`docs/ai-providers.md`](../../../docs/ai-providers.md) with a working configuration for each provider.
- **An operator check**, `node dist/llm-check.js` (or `pnpm --filter @scrylux/api llm:check`), which sends one fixed request with no
  user data to each configured operation and reports the provider, whether data leaves the install, the usage, or what failed.
- **Constitution 1.13.1 → 1.14.0**: the provider keys are a current asset and the outbound connection a current trust boundary.

### Items that need the maintainer's eye

These are the decisions in this pull request that go beyond the plan, or touch a policy. Each is small; none is hidden.

1. **A license-policy exception**, `fast-sha256` (Unlicense). It comes in through `@anthropic-ai/sdk` → `standardwebhooks`. The policy
   is default-deny, so it is one named entry in `scripts/license-policy.json` with its reason, and the allow-list is not widened.
2. **A new runtime dependency, `undici` 7 (MIT)**, beyond the four SDKs. Measured: Node's built-in `fetch` gives up after about five
   minutes without response headers *whatever timeout an SDK is given* (a 900 s SDK timeout failed at 301 s). A slow local model
   answers a non-streaming request only when it is done, so a `LLM_TIMEOUT` above five minutes would silently do nothing, which is the
   very case the setting exists for. `adapters/http.ts` gives the Anthropic, OpenAI and Gemini SDKs a fetch whose connection pool waits
   as long as `LLM_TIMEOUT`; the same probe against the real adapter then succeeded at 330 s. A test pins the wiring.
3. **`pnpm-workspace.yaml`: `allowBuilds` for `@google/genai` and `protobufjs` set to `false`.** pnpm refused to install until each was
   decided. Neither script is needed (`@google/genai`'s is a publishing hook, `protobufjs`'s a version nag), so install scripts stay
   off for them.
4. **Constitution 1.14.0**, beyond the Threat Model section: Principle IV names `docs/install.md`'s table, not `README.md`'s;
   Principle VI says its notice that data leaves the install is required from the first milestone in which **user content can reach a
   provider** (Milestone 3), not now; and the Development Workflow's eval-harness sentence, which said "from Phase 3 onward"
   unconditionally, is aligned with Principle II (once an LLM-backed feature exists and the harness is in place).
5. **Gemini is in scope**, and `plan.md` and `docs/roadmap.md` name it. (`plan.md` is git-ignored in this repository, so its edit,
   which also moves the notice's deadline to Milestone 3, is local and not in the diff.)
6. **Spec changes made during planning and after the cross-artifact analysis**, all recorded under Clarifications (sessions 2026-10-20
   and 2026-10-21): the "rejected" failure category; the default output limit raised from 4,096 to 16,000 tokens (current models count
   their reasoning against it); the true bound on a request (5 attempts plus up to 4 resends); a provider name allowed in a start-up
   message; the check's log line on stderr; AWS's endpoint variables refused while Bedrock is configured.
7. **Prices.** The list is as complete as its sources allowed (see Findings F-7): no Claude-on-Bedrock price and no
   `gemini-embedding-001` price, because the sources do not state them. Please spot-check the OpenAI and Gemini entries.

## How this satisfies Principles I–VI

| Principle | How |
|---|---|
| **I. Secure coding** | Keys come only from the environment or the secrets-manager secret, are passed explicitly to each SDK, and are never in a log line, error, failure, usage record, check output, the database or a response. `canary.test.ts` runs a fake key, fake document text and a fake password in an address through every failure category on every adapter, with stub servers that echo all three back, and finds none. A variable the SDKs read on their own is refused at start-up. No SQL, no new endpoint. |
| **II. Test-first** | Every behaviour has a test written and seen failing first, except four named guard tests (`same-shape`, `placement`, `canary`, and the canary's check run) that check across adapters what earlier tests already built. All tests use stub servers through the real SDKs: no provider, key or network. **The eval gate does not apply yet** (see below). |
| **III. Simplicity** | Not added: a job queue, persisted usage, a vector store, prompts for extraction, the UI notice, Vertex AI, streaming, thinking or effort settings, tool calling. Dependencies: one official SDK per provider, each loaded only when used, plus `undici` (above). |
| **IV. Maintainability** | Sixteen variables, all in `docs/install.md`. Prices, model capabilities and every fixed piece of prompt text are versioned data files read from the package's own path. One JSON line per request, with counts only. Stateless apart from the per-process memory of refused parameters. |
| **V. Threat-aware design** | The constitution's section is updated in this change (below). No new inbound entry point: the check runs only for someone with shell access to the deployment. Bedrock needs only `bedrock:InvokeModel` on the chosen models, and the docs say so. |
| **VI. AI output is a draft** | One interface, no vendor API outside the package. Output is returned only after strict zod validation, and an answer with a field the schema does not name is invalid. Untrusted content goes in a section bounded by a random per-request nonce, never in the instruction position. No tool is offered or executed. A local model remains a supported path. The notice is Milestone 3's (above). |

### The eval gate

Principle II requires `pnpm eval` for a change to a provider adapter once an LLM-backed feature exists, and the harness is Milestone 7.
This pull request ships no feature that uses a model, so the gate does not yet apply. It was tested instead by the stub-server suites
and, once, by hand against real providers (see "Not done").

## Security implications

This pull request changes configuration and secrets handling and adds provider adapters, so (Development Workflow) its security
implications are called out here.

- **A new credential type.** `LLM_API_KEY` and `EMBEDDING_API_KEY`, in the environment or the secrets-manager secret (which overrides the
  environment, as its other keys do). Never stored, logged or sent to the browser. A base address may carry credentials
  (`https://user:pass@host`); they are taken out of the address and sent as basic authentication when there is no key, because `fetch`
  refuses such an address, and they are never shown.
- **A new outbound boundary.** From the Scrylux process to a hosted provider. Today only the operator's check uses it, with fixed text.
  Whether data leaves the install is reported for every provider, and never guessed from an address: a provider is hosted unless the
  operator declares an OpenAI-compatible one local, and a hosted provider must use `https`.
- **Stray variables cannot redirect a key.** The SDKs read many variables on their own (an address, headers, logging, telemetry). While
  a provider is configured, Scrylux refuses to start if one is set. `sdk-env.test.ts` reads every installed SDK and its whole dependency
  tree, so an update that starts reading a new one fails the build.
- **A hostile endpoint.** Its answer is checked against the schema before anything uses it; the model is offered no tools; nothing in
  an answer is executed.
- **Runaway spend or a hung request.** A time limit per attempt, bounded retries and cancellation are here. Per-job caps are Milestone 2's.
- **The check command** can be run only by someone who can run a command in the deployment. It reads the same secret and never the database.

## Threat Model

Updated in this change: the constitution's Threat Model section (assets: provider keys and the Bedrock role; trust boundary: the
outbound provider connection; four risks across Information Disclosure, Tampering and Denial of Service). Its Sync Impact Report
records the change as a MINOR.

`docs/threat-model/` is rebuilt in Scrylux by its README's procedure. The diagram gains an external entity `LLM provider (hosted)`
(authenticated, not internet-facing) and a data flow `Model requests` from Startup and configuration, which is authenticated, encrypted
and carries sensitive data. **Review the report's diff**, not the JSON's, because every id changes on import.

- **Generated threats:** six, after two that did not fit were removed by setting the entity's flags. Each was decided by the README's
  table, with the constitution's new bullets as row 1:

  | Threat | Status |
  |---|---|
  | Stolen credentials let an attacker act as the provider | accepted |
  | The provider can deny having done something | accepted |
  | A captured request can be sent again | not applicable |
  | Sensitive data goes to the provider | accepted until Milestone 3, with the Principle VI notice proposed |
  | Scrylux can flood the provider | open, partially mitigated; per-job caps are proposed for Milestone 2 |
  | Scrylux stops working when the provider is slow or down | open, partially mitigated |
- **FR-050 risks the rules did not derive:** a key disclosed is added to the existing threat "A secret ends up in a committed file, a
  log or the browser", with a verified mitigation. A hostile or misconfigured endpoint answering with crafted output is a new
  Tampering threat of the model as a whole, mitigated by three verified controls.
- **Totals:** 271 threats: 37 open, 68 mitigated, 97 accepted and 69 not applicable. The open threats still include 6 Critical, as before.
- **Approval:** the README says the model covers the system through Phase 3 Milestone 1, and that the maintainer approved these
  additions on 2026-10-31. The earlier approval dates are unchanged.

## Testing

| Suite | Result |
|---|---|
| `packages/llm` | 23 files, 580 tests (new) |
| `apps/api` | 66 files, 1,220 tests (was 63 files, 1,129): the start-up check, the secret's two keys, the check command, the canary |
| `packages/core`, `threat-library`, `db`, `apps/web`, `scripts` | unchanged: 374, 314, 232, 666, 251 |
| Playwright | 60 passed, unchanged |
| `typecheck`, `lint` (the license check included), `build` | pass |
| `docker build`, `docker compose up --build` | pass. AI off: the log says `AI providers: generation off, embeddings off`, `/health` is 200, and `node dist/llm-check.js` inside the container prints that nothing is configured and exits 0 |
| Quickstart §3, in the container | A missing key, an `http` address without the local declaration, a stray `OPENAI_API_KEY`, and `AWS_ENDPOINT_URL` with Bedrock each stop it with the message that names the variable (exit 1; the check exits 2) |

Checks that are not what they seem: the capability file's tests were shown to fail when a seed entry was broken; the five-minute fetch
limit was measured before and after the fix.

## Findings

| # | Finding | Disposition |
|---|---|---|
| F-1 | Node's `fetch` has its own five-minute response-header limit that no SDK timeout overrides (301 s measured with a 900 s timeout). | Fixed with `undici` (item 2 above); measured again at 330 s. |
| F-2 | zod writes `additionalProperties: false` for a plain `z.object` too, while still stripping unknown keys when it parses. The research's plan to check strictness on the JSON would have let an answer with extra fields through. | Strictness is read from the zod definition (`assertStrict`); research #5 is corrected. |
| F-3 | The installed AWS SDK **does** read `AWS_ENDPOINT_URL`, `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS` and more (a first search of the wrong version said it did not). | Refused while Bedrock is configured; the full list of AWS variables that are allowed is by name, and a test keeps both in step. |
| F-4 | The scan found about ninety vendor names, not the dozen the spec listed: the Anthropic SDK alone reads over twenty. | All covered by prefix or by name; each name that is not read has its reason in the test. |
| F-5 | `fetch` refuses an address with credentials, so the spec's "accepted" would have meant every call failing as unavailable. | Adapter fix and tests; found by the canary. |
| F-6 | The AWS client talks HTTP/2 by default, so its stub is a cleartext HTTP/2 server. | Test only. |
| F-7 | Price sources: Anthropic's table was read directly; OpenAI's and Gemini's pages through a summarizing fetch, so they want a spot-check; AWS's page is not readable, so Bedrock comes from AWS's public price-list JSON, which names models but not Bedrock model ids. Gemini states price rises on 2026-12-01 and 2027-01-01 for some models. | Bedrock lists only Titan Text Embeddings V2; Claude on Bedrock and `gemini-embedding-001` are left out rather than guessed; the dated rises are noted beside their entries. |
| F-8 | Research #6's pattern `o*` for OpenAI's reasoning models would also match `orca-mini`, `olmo2` and `openhermes`. | Seeded as `o1*`, `o3*`, `o4*`. |
| F-9 | `docs/ai-providers.md` can only say that Ollama *can* shorten an input longer than its context window: its documentation does not say. | Worded as a possibility, with `OLLAMA_CONTEXT_LENGTH`, which its documentation confirms. |

## Live runs (T072, SC-003)

Run by the maintainer by [quickstart §4](./quickstart.md), with the key only in the shell. A 16,000-token generation took 134.5 s,
well inside the 300-second default.

| Date | Provider | Model | Outcome | Duration |
|---|---|---|---|---|
| 2026-10-31 | Ollama (openai-compatible, declared local) | `llama3.2` | `OK`, local, 70 input + 7 output tokens, cost `unknown`; exit 0 | 2.3 s |
| 2026-10-31 | Ollama (openai-compatible, declared local) | `nomic-embed-text` | `OK`, local, dimension 768, cost `unknown`; exit 0 | 5.3 s |
| 2026-10-31 | Gemini (unpaid tier) | `gemini-3.6-flash` | `OK`, hosted, 47 input + 155 output tokens, $0.000617 at list price, not billed; exit 0 | 3.5 s |
| 2026-10-31 | Gemini (unpaid tier) | `gemini-embedding-2` | `OK`, hosted, dimension 3072, 17 input tokens (estimated); exit 0 | 0.6 s |
| 2026-10-31 | Gemini, wrong key | both of the above | `FAILED: not authorized` for both operations, exit 1, the key not in the output | 0.2 s, 0.3 s |
| 2026-10-31 | Gemini, 16,000-token limit | `gemini-3.6-flash` | `output_limit_reached` at 15,986 output tokens, 1 attempt, $0.06 at list price, not billed | 134.5 s of 300 s |

Other results from the same session:
- **Not counted:** an Anthropic run with a credential that is not an Anthropic API key failed as `rejected` (a 400) in 0.8 s. No Anthropic API key was available, so the Anthropic
  adapter is tested against stubs only.
- **`gemini-2.5-flash`** failed as `not available` for this key. It was the example in `docs/ai-providers.md`, which now shows
  `gemini-3.6-flash`, the model that worked.
- **`gemini-3.8-flash`** failed as `provider unavailable` after 3 attempts, twice (5.9 s and 9.9 s): a provider-side error retried
  and then reported, as designed.

## Not done in this pull request

- Committing, pushing and opening this pull request. Nothing has been committed.

## Spec coverage

**T** = a test in the required `test` check; **R** = review; **M** = a manual step above.

| Requirement | Held by |
|---|---|
| FR-001 to FR-009 configuration | T: `config.test.ts` (one case per rule, in order, no value in any message), `apps/api/test/llm/startup.test.ts` (no connection at start-up) |
| FR-010 time limit | T: `attempts.test.ts` (enforced in the loop for every adapter), each adapter's `hang` case, `http.test.ts`; measured at 330 s |
| FR-011 documentation | `docs/install.md`, `docs/ai-providers.md`; R |
| FR-012 to FR-016 structured results | T: `attempts.test.ts`, the four adapter tests, `same-shape.test.ts`, `schema.test.ts` |
| FR-017 to FR-019 embeddings | T: the three `*-embed.test.ts`, `embed.test.ts` |
| FR-020 to FR-024 failures and retries | T: `attempts.test.ts`, `embed.test.ts`, each adapter's error table |
| FR-030 to FR-034 usage and cost | T: `usage.test.ts`, `pricing.test.ts`, `data-files.test.ts` (every priced model, to the cent) |
| FR-040 to FR-042 content and tools | T: `content-section.test.ts`, `placement.test.ts` |
| FR-043, FR-043a keys and variables | T: `canary.test.ts`, `sdk-env.test.ts`, `config.test.ts` rule 11 |
| FR-044, FR-045 hosted or local | T: `config.test.ts`, `startup.test.ts`, `check.test.ts` |
| FR-046, FR-047 check | T: `check.test.ts` (output, streams, exit statuses, what is sent), the canary's check run; M: T072 |
| FR-050 threat model | constitution and `docs/threat-model/`: done; T: the dogfood checks (the files are Scrylux's own export, and nothing is stale) |
| FR-051, SC-009 no provider, no secret | T: every test uses stub servers |
| SC-001 | T: the unchanged suites and Playwright; `docker compose` with AI off |
| SC-002, SC-004, SC-004a, SC-005 to SC-008 | T: as above |
| SC-003 | M: T072 |
| SC-010 | T: the dogfood checks pass; M: the model's rebuild |
