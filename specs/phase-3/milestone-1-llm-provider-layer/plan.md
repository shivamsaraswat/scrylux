# Implementation Plan: LLM Provider Layer

**Branch**: not yet created (spec directory `phase-3/milestone-1-llm-provider-layer`; the setup script
inferred `milestone-1-llm-provider-layer` as the branch name, but no branch by that name was created;
work is on `feat/phase-3`) | **Date**: 2026-10-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/phase-3/milestone-1-llm-provider-layer/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Phase 3 / Milestone 1 adds `packages/llm` (`@scrylux/llm`), the provider-agnostic layer every AI
feature of Phase 3 will call. It does two things: it returns a schema-validated structured result, and
it turns text into embeddings. It has four adapters: Anthropic, OpenAI-compatible (OpenAI, Azure OpenAI,
Ollama, vLLM), AWS Bedrock, and Google Gemini, which the maintainer added at planning. Every request
returns a usage record with tokens and cost, and writes one log line. The API validates the
configuration at startup, and an operator can run a check command against the configured provider. No
user content reaches a model in this milestone.

At planning the spec changed in four places (spec Clarifications, session 2026-10-20):

- Gemini was added (FR-002, FR-002a).
- The temperature rule now also covers vendor advice (FR-015a).
- The "rejected" failure category was added (FR-020).
- The default output limit went from 4,096 to 16,000 tokens (research #7).

**1. The package** (`packages/llm/`).

- **Public API**: `parseLlmConfig`, `llmStatus` and `createLlm(config).generate | embed`
  ([contracts/library-api.md](./contracts/library-api.md)).
- **One adapter per provider** behind one internal interface, each on its official SDK. Each SDK is
  loaded with a dynamic `import()`, and each SDK's own retries are turned off (research #2, #3).
- **The attempt loop**: schema attempts (≤ 3) and transient retries (≤ 2 per request) are counted
  separately, with abortable waits, `retry-after` honoured up to 60 seconds, and free resends when a
  model refuses a temperature or the native output format (research #9).
- **zod → JSON Schema** with zod's own `z.toJSONSchema`, a strictness check, a per-adapter step that
  removes what the provider rejects, and the caller's zod schema as the only judge (research #5).
- **Untrusted content** goes in a section bounded by a random per-request nonce, never in the
  instruction position (research #10).
- **Usage and cost**: provider-reported or estimated tokens, prices from the operator or the shipped
  list, tiers, and unknown never reported as 0 (research #11).

**2. Data files.**

- `data/prices.yaml`: dated and sourced prices.
- `data/models.yaml`: per-model temperature, output-format, parameter-name and batch facts.
- `prompts/`: the content-section preamble, the schema-retry message, the JSON fallback instruction and
  the check request.
- All of them are parsed strictly and tested ([contracts/data-files.md](./contracts/data-files.md)).

**3. The API.**

- **Startup**: `server.ts` validates the configuration after `config.load()`. It refuses to start with
  a message naming the variable, and otherwise logs which providers are on.
- **The secret**: `config.ts` reads `LLM_API_KEY` and `EMBEDDING_API_KEY` from the secrets-manager
  secret.
- **The check command**: `src/llm-check.ts` ([contracts/check-command.md](./contracts/check-command.md)).

**4. Packaging, docs and the threat model.**

- **Packaging**: the Dockerfile copies the new package's manifest. Both compose files pass the new
  variables through. One license exception is added, for `fast-sha256`.
- **Docs**: `docs/install.md` rows and a new `docs/ai-providers.md`. `plan.md` and `docs/roadmap.md`
  gain Gemini. CHANGELOG.
- **Threat model**: constitution 1.14.0, and `docs/threat-model/` rebuilt by its documented procedure.

## Technical Context

**Language/Version**: TypeScript 6.0.x, strict, on Node 22 (unchanged). Data files are YAML 1.2 and Markdown.

**Primary Dependencies**:

- **`@scrylux/llm` runtime**: `zod@^4.6.7` (already used), `yaml@^2.9.1` (already locked, as in
  threat-library), and the four official SDKs: `@anthropic-ai/sdk@^0.135.0` (MIT), `openai@^7.39.0`
  (Apache-2.0), `@aws-sdk/client-bedrock-runtime@^3.1152.0` (Apache-2.0, sharing `@aws-sdk/core` with
  the API's secrets-manager client), and `@google/genai@^2.30.0` (Apache-2.0). All are older than pnpm's
  24-hour `minimumReleaseAge`.
- **Added during implementation: `undici@^7.28.0` (MIT).** Node's built-in `fetch` gives up after about five
  minutes without response headers whatever an SDK's timeout is (measured: a 900 s timeout failed at 301 s),
  so a `LLM_TIMEOUT` above five minutes would do nothing for the Anthropic, OpenAI and Gemini SDKs, which use
  `fetch`. `adapters/http.ts` gives them a pool whose header and body timeouts follow `LLM_TIMEOUT`
  (research #2). Bedrock's HTTP client has no such limit. 7.x rather than 8, which needs Node 22.19.
- **`@scrylux/api`** adds `@scrylux/llm` (workspace).
- **`pnpm-workspace.yaml`**: `allowBuilds` is `false` for `@google/genai` and `protobufjs`. pnpm refused to
  install until each was decided; neither package's install script is needed (one is a publishing hook, the
  other a version notice).
- **No other package changes its dependencies.** No new dev dependency: the stub servers use `node:http` and
  `node:http2`.

**Storage**: none. No table, column or migration. The data files are read from the package directory,
like threat-library's `rules/`.

**Testing**:

- **Vitest** in `packages/llm/test/`. Adapters are tested against `node:http` stub servers that play
  each provider's REST API, through the real SDKs. Pure tests cover the loop, cost, configuration, data
  files and content markers.
- **`apps/api/test/llm/`** holds the startup, check-command and canary tests.
- **All run in CI's required `test` check** with no secret and no provider network (research #15). The
  dogfood checks cover the updated threat model.
- **Live runs** against a hosted provider and Ollama are manual, per [quickstart §4](./quickstart.md).
- **No Playwright change**: there is no UI.

**Target Platform**: Node 22. The API process (and the check command in the same image) today; the
worker of Milestone 2 later.

**Project Type**: a library package inside the pnpm monorepo, plus a startup hook and a command in `apps/api`.

**Performance Goals**:

- The layer's own overhead per request is negligible next to a provider call: under 5 ms for schema
  conversion, validation and accounting at the sizes Phase 3 expects.
- Startup cost with AI off is unchanged, because no SDK is loaded.

**Constraints**:

- A per-attempt time limit (default 300 s) and at most 3 tries against a failing provider (SC-008).
  Cancellation takes effect within 1 s (SC-007).
- No prompt, content, answer, key or base address in any log, error or usage record (SC-005).
- Stateless across requests (Principle IV), apart from the per-process memory of refused parameters,
  which only removes a free resend.
- No tools, no streaming, no thinking or effort settings (Principles III and VI).

**Scale/Scope**:

- About 20 source files in `packages/llm/src`: config, client, attempts, schema, content, usage,
  pricing, capabilities, data loading, log, errors, four adapters, and the shared adapter types.
- 6 data files, about 15 test files, 3 API source files changed or added, about 3 API test files, and
  docs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| **I. Secure coding** | Secrets from env or the secrets manager only; never logged, stored or sent to the browser; refuse to start if a required secret is missing. | ✅ Keys come only from `LLM_API_KEY` / `EMBEDDING_API_KEY` or the existing secret (FR-008), are passed explicitly to each SDK, and are never written to a log, error, usage record or the database. No endpoint exposes them: `llmStatus` returns provider, model and hosted only (FR-043, FR-045). A provider selected without its key stops startup (FR-006). A key embedded in a base address is treated the same way. Startup is refused while a variable the SDKs would read on their own is set (FR-043a, research #12), so no stray key, address, header or logging switch reaches a provider. The canary test proves all of this (SC-005). No SQL and no new endpoint. |
| **II. Test-first** | A failing test before each behavior; the suite green; eval gate for adapter changes. | ✅ Every FR maps to a test in [quickstart §1](./quickstart.md#1-automated-suites), written before the code it covers. **The eval gate**: Principle II requires `pnpm eval` for adapter changes once an LLM-backed feature exists. None exists yet and the harness is Milestone 7, so this milestone's gate is the stub-server suite plus the manual live runs (spec Assumptions). The constitution's Development Workflow section states the same gate as "from Phase 3 onward" with no condition, so the 1.14.0 amendment (T065) aligns that sentence with Principle II's, and the PR says so. |
| **III. Simplicity / YAGNI** | No later phase's scope; no premature dependencies; no dead code. | ✅ **Not added**: job queue, persistence of usage, or caps (M2); ingestion or a vector store (M3); prompts for extraction or threats (M4, M6); the UI notice and prompt logging (M8); Vertex AI; streaming; thinking or effort controls; tool calling (excluded by Phase 3). **Dependencies**: four SDKs, one per provider in scope, each loaded only when configured. `plan.md` chose official SDKs, and research #2 records why not plain `fetch` or a multi-provider library. **Gemini** widens `plan.md`'s Milestone 1 list at the maintainer's request, and `plan.md` is updated in the same change. |
| **IV. Maintainability** | Env-only config, documented; stdout logs without raw LLM payloads; stateless; prompts as data files. | ✅ 16 environment variables, all in `docs/install.md` (FR-011). One JSON line per request with counts only (FR-034). Prompts, prices and model capabilities are versioned data files in the package, read from the module's own path, never chosen by an install (FR-041). No state survives a request, except the per-process memory of refused parameters. |
| **V. Least privilege / threat-aware** | Threat Model updated for new assets, entry points and boundaries in the same change. | ✅ **The section changes (FR-050)**: provider keys and the Bedrock role become current assets; the outbound connection to a hosted provider becomes a current boundary; four risks are added. The constitution goes to 1.14.0 and `docs/threat-model/` is rebuilt by its own procedure. **No new inbound entry point**: the check command runs only for someone with shell access to the deployment. **Least privilege**: Bedrock needs only `bedrock:InvokeModel` on the chosen models, and the docs say so. **One policy exception**: `fast-sha256` (Unlicense) is added to the license policy's `exceptions`, named and justified in the PR (research #16). |
| **VI. AI output is a draft** | Provider-agnostic interface; output validated before use; untrusted input delimited; no tool calls; local model supported; hosted disclosure. | ✅ Callers see one interface (FR-016). Output is returned only after strict zod validation (FR-013). Content goes in a nonce-bounded section, never in the instruction position (FR-040). No tools are offered or executed (FR-042). The OpenAI-compatible adapter keeps Ollama and vLLM supported, and they can be declared local. **The UI notice** is not built here, because no user content is sent yet. The layer supplies `hosted` for it (FR-044, FR-045), and the spec records that the notice must ship no later than Milestone 3, which sends chunks for embedding. Principle VI's "when a hosted provider is configured" sits under "from the moment any LLM-backed feature exists"; the check command sends only fixed text, so no user data leaves the install. The 1.14.0 amendment (T065) states that reading, and `plan.md` gains the Milestone 3 deadline (T068). |

**Post-design re-check (after Phase 1)**: still passing.

- The design added no endpoint, table or UI. It added 16 environment variables, documented, and one
  command that only an operator with shell access can run.
- The contracts expose no key, no address and no raw provider object.
- The license exception and the Gemini scope change are the two items the PR must call out.
- The constitution amendment (1.14.0) is part of this milestone's implementation, not a precondition
  for it. Its Principle IV wording fix (`docs/install.md`, not `README.md`) is applied with the docs task
  (T038), so the docs and the constitution never disagree. The rest waits for US7.
- After cross-artifact analysis (2026-10-21) the amendment also aligns the Development Workflow's eval
  gate with Principle II, and states when Principle VI's notice applies. The design gained a test-only
  entry point, `@scrylux/llm/testing`, which is never built or shipped
  ([contracts/library-api.md](./contracts/library-api.md)).

## Project Structure

### Documentation (this feature)

```text
specs/phase-3/milestone-1-llm-provider-layer/
├── plan.md              # This file
├── research.md          # Phase 0: decisions 1–18
├── data-model.md        # Phase 1: in-memory entities and the request lifecycle
├── quickstart.md        # Phase 1: automated suites and manual live runs
├── contracts/
│   ├── library-api.md   # what @scrylux/llm exports
│   ├── configuration.md # environment variables and their rules
│   ├── data-files.md    # prices.yaml, models.yaml, prompts/
│   └── check-command.md # the operator check
├── checklists/
│   └── requirements.md  # spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
packages/llm/                        # new: @scrylux/llm
├── package.json                     # files: dist, data, prompts; @scrylux/source export condition
├── README.md                        # contributor guide: adding a model, a price or a provider
├── data/
│   ├── prices.yaml
│   └── models.yaml
├── prompts/
│   ├── content-section.md
│   ├── schema-retry.md
│   ├── json-instructions.md
│   └── check.yaml
├── src/
│   ├── index.ts                     # the public exports of contracts/library-api.md
│   ├── config.ts                    # parseLlmConfig, llmStatus, LlmConfigError
│   ├── client.ts                    # createLlm: generate and embed
│   ├── attempts.ts                  # the attempt loop, waits, cancellation
│   ├── schema.ts                    # zod → JSON Schema, strictness check, per-adapter sanitizers
│   ├── content.ts                   # nonce-bounded content section, prompt placeholders
│   ├── usage.ts                     # usage records, estimation
│   ├── pricing.ts                   # price lookup, tiers, cost
│   ├── capabilities.ts              # models.yaml lookup and the runtime override map
│   ├── data.ts                      # strict YAML/Markdown loading of data/ and prompts/
│   ├── log.ts                       # the one JSON line per request
│   ├── errors.ts                    # FailureCategory, FAILURE_MESSAGES, LlmSchemaError
│   └── adapters/
│       ├── types.ts                 # the internal adapter interface
│       ├── anthropic.ts
│       ├── openai-compatible.ts
│       ├── bedrock.ts
│       └── gemini.ts
├── testing/
│   └── index.ts                     # @scrylux/llm/testing: stub endpoints for tests; source-only, never built or shipped
└── test/
    ├── stubs/                       # one node:http stub server per provider
    ├── adapters/                    # one generate and one embed test file per adapter
    ├── attempts.test.ts
    ├── config.test.ts
    ├── schema.test.ts
    ├── content-section.test.ts
    ├── usage.test.ts
    ├── pricing.test.ts
    ├── sdk-env.test.ts              # every variable the installed SDKs read is refused or exempt (FR-043a)
    └── data-files.test.ts

apps/api/
├── package.json                     # + @scrylux/llm; script "llm:check"
├── vitest.config.ts                 # + aliases for @scrylux/llm/testing and @scrylux/llm to their source (testing first)
├── src/config.ts                    # + LLM_API_KEY, EMBEDDING_API_KEY from the secret
├── src/server.ts                    # + parseLlmConfig at startup, one status line
├── src/llm-check.ts                 # new: the check command
└── test/llm/                        # new: startup, check-command and canary tests

Dockerfile                           # + COPY packages/llm/package.json
docker-compose.yml                   # + the LLM_* / EMBEDDING_* variables passed through; host.docker.internal
docker-compose.release.yml           # + the same; keep the scans of scripts/release and apps/api/test/demo green (empty defaults only)
scripts/license-policy.json          # + exception: fast-sha256
.specify/memory/constitution.md      # 1.14.0: Threat Model section; Principle IV names docs/install.md's table, not README.md's
docs/threat-model/                   # rebuilt: report.md, threat-model.scrylux.json, README sentence
docs/install.md                      # + environment variable rows; secret keys
docs/ai-providers.md                 # new: per-provider configuration, hosted and local, data use, the check
docs/roadmap.md, plan.md             # + Gemini in Phase 3 Milestone 1 and the competitive table; the notice's Milestone 3 deadline
README.md, CHANGELOG.md              # documentation link; Unreleased entry
```

**Structure Decision**: one new package in `packages/`, where `plan.md`'s layout and Principle III put
`packages/llm`. Its shape copies `packages/threat-library` (data shipped in the package, the
`@scrylux/source` condition, a strict YAML loader). The API gains only a startup check and a command.
It does not call the layer on any request path in this milestone.

## Complexity Tracking

No constitution violation needs justifying. Two items are deliberate and are called out in the PR:

| Item | Why needed | Simpler alternative rejected because |
|---|---|---|
| Four SDK dependencies | One official SDK per provider in scope, as `plan.md`'s tech stack chose. Each is loaded only when its provider is configured | Plain `fetch` means hand-writing every request shape, error type, AWS signing and credential chain. A multi-provider library puts someone else's abstraction under the interface Principle VI says Scrylux owns (research #2) |
| One more dependency, `undici` (MIT) | Without it a time limit above five minutes silently does nothing for three of the four providers, which is the case FR-010 exists for (slow local hardware) | Capping `LLM_TIMEOUT` at five minutes: the default would be the ceiling. Streaming: out of scope for the milestone (research #7) |
| A license-policy exception for `fast-sha256` (Unlicense) | It comes in through `@anthropic-ai/sdk` → `standardwebhooks`, and the policy is default-deny | Widening `allowed` to all Unlicense packages is broader than needed. The policy's `exceptions` names one package with its reason (research #16) |
