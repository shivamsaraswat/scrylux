# Implementation Plan: System Extraction

**Branch**: not yet created (spec directory `phase-3/milestone-4-system-extraction`; work is on `feat/phase-3`; the setup
script inferred `milestone-4-system-extraction` as the branch name, but no branch by that name was created) |
**Date**: 2026-11-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/phase-3/milestone-4-system-extraction/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Phase 3 / Milestone 4 lets a signed-in person start an extraction on a threat model's Draft tab. The API checks that a
generation provider is configured, that no source is still being processed and that at least one is ready, then queues
an `extract_system` job. The worker sends the ready sources' chunks to the generation model through `@scrylux/llm`, all
of them when they fit a budget of 36,000 characters, or else the chunks an exact embedding search ranks most relevant
to a system model. The chunks go inside the layer's marked content section under labels `c1`, `c2`…. The model
answers with a fixed JSON structure. A per-request check validates every label, quote, reference and diagram rule as
part of the layer's schema attempts. A valid answer is written as the threat model's draft in the transaction that ends
the job, replacing the earlier one. The Draft tab shows it read-only, as a diagram and a list, with each item's
rationale and citations. Nothing is written to the threat model.

At planning the plan settled six things and recorded them in the spec (Clarifications, session 2026-11-08, during
planning):

- **No approximate vector index**: retrieval compares exactly within the threat model, which plan.md's "adds the vector
  index it queries" did not foresee (FR-013, FR-090, FR-091; research #6).
- **Labels, not ids, in the prompt** (FR-036; research #3).
- **A cut-off answer is not retried**, and retrying it is refused until a setting changes (FR-045; research #9).
- **Silent truncation by local servers** is documented, not detected (FR-016; research #8).
- **Starting again is retrying** (FR-045, FR-064; research #11).
- **Quotes stored as spans of the chunk**, so a deleted source leaves no text in a citation (FR-054; research #4).
- **A fix in Milestone 1's layer**: its retry note quoted zod's message for an unknown field, which names the field,
  outside the marked section. It now uses fixed text (FR-036; research #2).
- **Local timeouts**: the guide says to raise `LLM_TIMEOUT` for a local model, and SC-002 is measured on a GPU host
  (FR-082; research #8).

**1. Database** (`packages/db/migrations/018_drafts.sql`): six tables, `jobs`' new kind, categories and the partial
unique index ([data-model.md](./data-model.md)).

**2. Shared schemas** (`packages/core`): `DraftAnswer`, `DraftRecord`, `ExtractionStatus`, the new job kind, steps and
categories; `draft-layout.ts` (research #2, #14).

**3. The kind** (`apps/api/src/extract-system/` and `worker/extract-system.ts`): settings, the path and the retrieval
statement, the content builder, the request checks, the mapping and the commit, the prompt version
([contracts/worker.md](./contracts/worker.md); research #1–#13).

**4. Data files**: `apps/api/prompts/extract-system/`, `failures.yaml`'s additions
([contracts/data-files.md](./contracts/data-files.md)).

**5. The API**: four routes (two paths), `POST /jobs` refusing the kind ([contracts/http-api.md](./contracts/http-api.md)).

**6. The web app**: the Draft tab, `ExtractionNotice`, `SourcesNotice`'s sentence, the source page's `?offset=`, the
Jobs page's kind ([contracts/ui.md](./contracts/ui.md)).

**7. Docs, governance and the threat model**: `docs/install.md` (two variables), `docs/ai-providers.md` (where text goes
during extraction, the context requirement, the local model that passed), `docs/formats/` (drafts not exported),
`CHANGELOG.md`, plan.md and `docs/roadmap.md` (M4 as built: exact retrieval, no index), constitution 1.17.0 (Principle
II's eval gate from Milestone 7; the Threat Model section), `docs/threat-model/` rebuilt, the sample document and the
recorded manual run (research #16, #17).

## Technical Context

**Language/Version**: TypeScript 6.0.x, strict, on Node 22.13 or later. SQL for the migration, Markdown and YAML for the
prompt files.

**Primary Dependencies**: none added (research #18). One change to `@scrylux/llm`: the retry note's issue messages. zod 4.6 (its refinement stays out of `toJSONSchema` and runs in
`safeParse`: research #2), Kysely, pgvector 0.8.7's `<=>` operator and `vector[]`, React Flow 12, `@scrylux/llm`.

**Storage**: PostgreSQL 16 with pgvector. One migration, six tables, no vector index. Per threat model: at most one
draft of at most 70 items, about 350 citations and 1,000 read-chunk rows.

**Testing**:

- **Vitest** with the Postgres service container: `packages/db/test/`, `packages/core/test/`, `apps/api/test/extract-system/`,
  `test/contract/v1/extraction*.test.ts`, the canary, and web unit tests.
- **Stubs**: Milestone 1's `startStub` for generation and embeddings, now recording each request's system and user text
  so the injection tests can assert where source text went.
- **A scale test**: 10,000 chunks of 3,072 dimensions, generated in SQL so the fixture costs no transfer (SC-006).
- **One Playwright spec** with its own API, worker and stub. The rest of the browser suite is unchanged (SC-001).
- **No secret, no provider network** (FR-083). §2 and §3 of [quickstart.md](./quickstart.md) are by hand, and §3 is
  the recorded run of FR-084.

**Target Platform**: the published image on Node 22, the same two processes. No new entry point.

**Project Type**: the existing web service (`apps/api`, `apps/web`) and its packages.

**Performance Goals**:

- A draft within 5 minutes of the start for the ten-page sample, hosted, and local where the maintainer has hardware for one (SC-002). Most of it is the model's
  answer, of at most 12,000 tokens.
- Choosing chunks under 2 s at 10,000 chunks (SC-006): one statement, one read of the vectors.
- UI updates within 5 s while an extraction is active: poll every 2 s (FR-063).
- Cancel within 10 s (M2): the layer's request aborts on the job's signal.

**Constraints**:

- Source text, names and locations only inside the nonce-marked content section, under labels, and no database id sent
  (FR-036).
- No issue message in a retry note quotes the model's answer (research #2).
- The draft is written only in the fenced commit, with the read sources locked before the job row (research #10).
- No draft text in a log line, job row, usage row or error answer (SC-009). No write to `elements`, `threats` or
  `mitigations` (SC-005).
- Every v0.1, Milestone 2 and Milestone 3 flow works with no worker and no generation provider (FR-092).

**Scale/Scope**:

- About 9 new source files in `apps/api/src`: `extract-system/` with `config.ts`, `select.ts`, `retrieve.ts`,
  `content.ts`, `checks.ts`, `store.ts` and `prompt.ts`, plus `worker/extract-system.ts` and `v1/extraction.ts`. About 8
  changed: `worker/kinds.ts`, `jobs/kinds.ts`, `jobs/store.ts`, `v1/jobs.ts`, `router.ts`, `openapi.ts`, `config.ts`,
  `worker.ts`.
- One migration and its types. `schemas/draft.ts`, `draft-layout.ts`, and changes to `schemas/job.ts` in
  `packages/core`.
- One tab, one notice, their queries and tests in `apps/web`, and small changes to the source page, the Jobs page and
  `SourcesNotice`.
- About 12 test files, a sample document, the docs, the constitution and the threat model.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| **I. Secure coding** | Parameterized SQL only; identifiers only from constants; secrets never logged or sent; input validated; consistent errors. | ✅ Draft writes and the ranking statement go through Kysely or parameterized `sql` templates; the query vectors are one bound `vector[]` parameter. The routes take no body; the threat model id is validated as a UUID. Every error is fixed `{ error }` text. No new secret. |
| **II. Test-first** | A failing test before each behavior; the suite green; eval gate. | ✅ with an amendment. Every FR maps to a test in [quickstart §1](./quickstart.md#1-automated-suites), written first. **The eval gate**: this milestone adds a prompt and an extraction pipeline, which Principle II says must pass `pnpm eval`, and the harness arrives in Milestone 7. As clarified (FR-084), Principle II is amended in this change so the gate applies from Milestone 7, and this milestone records the manual run of quickstart §3 before release (research #16). |
| **III. Simplicity / YAGNI** | No later phase's scope; no premature dependencies; no dead code; layout. | ✅ **Not added**: accept, edit or reject (Milestone 5), threats (Milestone 6), the eval harness (Milestone 7), a vector index (research #6), a layout library (research #14), multi-pass extraction, a cooldown, a project-wide draft. **Dependencies**: none. The sample document is the first of Milestone 7's samples, committed now because FR-084's run needs it. No new workspace package. |
| **IV. Maintainability** | Env-only config, documented; stdout logs without payloads; forward-only migrations; stateless processes; data files. | ✅ Two variables, both in `docs/install.md` ([contracts/configuration.md](./contracts/configuration.md)). One forward-only migration. The instructions and retrieval queries are versioned data files, and every draft records the hash of them as its prompt version (research #12). Failure messages are data. Log lines hold counts and ids only. Both processes stay stateless. |
| **V. Least privilege / threat-aware** | Threat Model updated for new assets, entry points and boundaries in the same change; broader grants called out. | ✅ **The section changes (FR-080)**: the draft as an asset, four routes, the prompt boundary now current, document text to generation on the outbound boundary, and the risks of research #17. The two items that named this milestone are resolved with the injection tests. Constitution 1.17.0; `docs/threat-model/` rebuilt. **Called out as broadening (FR-068)**: any signed-in account can start an extraction on any threat model and make the generation provider spend, bounded by the caps, one extraction per threat model and the account limit of 3. |
| **VI. AI output is a draft** | Provider-agnostic; output validated; untrusted input delimited; no tool calls; local model supported; hosted disclosure; draft and accepted distinguishable. | ✅ Generation goes only through `@scrylux/llm`, from the worker. The answer passes the schema and the request's checks before anything is written; invalid answers are retried, then rejected (FR-035). Source text only inside the marked section, under labels; no tool; the only action is storing a draft. Every item and flag carries a rationale and quote-checked citations. Drafts live in their own tables and never enter the threat model in this milestone. Everything is rendered as text. A local model is supported and documented, with its context requirement. **Hosted disclosure**: the Draft tab's notice, on every visit, before the start button (FR-070). |

**Post-design re-check (after Phase 1)**: still passing.

- The design adds four authenticated routes, six tables, one job kind, two variables and two data files. Each is in
  the threat model update (research #17).
- The contracts expose no id to the model, and no draft text outside `DraftRecord`. A quote's text is never stored.
- The PR must call out:
  - the amendment to Principle II, and why it is MINOR (research #16);
  - the departure from plan.md's vector index (research #6);
  - the broadening of FR-068;
  - that a local server may shorten input silently, and the documented context requirement (research #8);
  - the planning clarifications above.

## Project Structure

### Documentation (this feature)

```text
specs/phase-3/milestone-4-system-extraction/
├── plan.md              # This file
├── research.md          # Phase 0: decisions 1–19
├── data-model.md        # Phase 1: migration 018, the answer schema, records, transitions
├── quickstart.md        # Phase 1: automated suites, by-hand run, pre-release run
├── contracts/
│   ├── http-api.md      # the four extraction routes and changes to existing ones
│   ├── configuration.md # the two variables
│   ├── worker.md        # the extract_system kind, its result, categories and logs
│   ├── data-files.md    # the prompt files and failures.yaml's additions
│   └── ui.md            # the Draft tab and the changes elsewhere
├── checklists/
│   └── requirements.md  # spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
packages/db/
├── migrations/018_drafts.sql        # new: six tables, jobs changes, one-extraction index
└── src/schema.ts                    # + the six tables' types

packages/llm/src/attempts.ts         # describeIssues: fixed text for every issue code (research #2)

packages/core/src/
├── schemas/draft.ts                 # new: DraftAnswer, DraftRecord, CitationRecord, ExtractionStatus
├── schemas/job.ts                   # + extract_system, its steps, three categories, sources_changed transient
└── draft-layout.ts                  # new: the read-only layout of a draft

apps/api/
├── prompts/extract-system/          # new: instructions.md, retrieval-queries.yaml
├── data/failures.yaml               # + three categories, per-kind hints
└── src/
    ├── extract-system/
    │   ├── config.ts                # EXTRACTION_CONTEXT_CHARS, EXTRACTION_MAX_OUTPUT_TOKENS
    │   ├── select.ts                # ready sources, left-out sources, the path
    │   ├── retrieve.ts              # query embeddings, the one ranking statement, filling the budget
    │   ├── content.ts               # labels and header lines
    │   ├── checks.ts                # the request's refinement and its fixed issue messages
    │   ├── store.ts                 # mapping, spans, the RunCommit, reading a DraftRecord, sources_changed
    │   └── prompt.ts                # loading the files, the prompt version
    ├── worker/extract-system.ts     # new: the kind's three steps
    ├── worker/kinds.ts              # + extract_system
    ├── jobs/kinds.ts                # NEEDS + 'generation'
    ├── jobs/store.ts                # the one-extraction refusal mapped to 409 with job_id
    ├── v1/extraction.ts             # new: the four operations
    ├── v1/jobs.ts                   # POST /jobs refuses the kind
    ├── v1/router.ts, v1/openapi.ts  # registration
    ├── config.ts, worker.ts         # settings checks at start
    └── (server.ts unchanged)

apps/api/test/
├── extract-system/                  # config, prompt, checks, select, content, kind, acceptable, attempts,
│                                    # retrieval-scale, sources-changed, caps, injection
├── contract/v1/extraction*.test.ts  # extraction, -retry, draft, draft-delete
├── worker/canary.test.ts            # extended
└── startup-process.test.ts          # extended

apps/web/src/
├── App.tsx                          # + /threat-models/:id/draft
├── pages/ThreatModelPage.tsx        # + Draft tab
├── pages/DraftTab.tsx               # new, with tests
├── draft/                           # new: DraftDiagram, DraftBoundaryNode, DraftList, ItemPanel, CitationView
├── components/ExtractionNotice.tsx  # new, with tests
├── components/SourcesNotice.tsx     # the generation sentence
├── pages/SourcePage.tsx             # ?offset=
├── pages/JobsPage.tsx, JobPage.tsx, components/job-format.ts   # the kind
└── api/queries.ts                   # + extraction and draft queries and mutations
apps/web/e2e/draft.spec.ts           # new

evals/samples/scrylux/design.md      # new: the sample design document (Milestone 7's first sample)
evals/manual-runs/m4.md              # new: the recorded pre-release run (FR-084)
docs/install.md, docs/ai-providers.md, docs/formats/ (drafts not exported), CHANGELOG.md
plan.md, docs/roadmap.md             # M4 as built
.specify/memory/constitution.md      # 1.17.0
docs/threat-model/                   # rebuilt
```

**Structure Decision**: the existing monorepo. Extraction is a module of `apps/api`, shared by the API (status, the
path at start, reading drafts) and the worker (the kind), as `sources/` is. The API never imports the worker's kind,
so it never calls a provider (M2 FR-070); the existing import-graph test covers the new files. The diagram layout is in
`packages/core` because it is pure and tested without a browser.

## Complexity Tracking

| Departure | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Exact retrieval instead of the vector index plan.md planned | Every query filters to one threat model's at most 10,000 chunks, where an install-wide approximate index returns too few rows, and `chunks.embedding` has no fixed dimension to index (research #6) | One HNSW index per dimension: an index for each model someone configures, with worse results under the filter than a scan that takes well under 2 s |
| A per-request refinement on a fixed schema | The citation, quote and reference checks depend on the request, and must count as schema attempts with their issues in the retry note (FR-035, research #2) | A per-request enum in the JSON Schema (provider limits, and a prompt version that no longer names one schema); checking after the layer (attempts counted twice, no retry note) |
| Quotes stored as spans | A deleted source must leave no text behind (M3 FR-053, FR-054, research #4) | Storing the quote's text: a copy of the deleted document's words inside every draft that cited it |
| A Principle II amendment | The eval gate cannot be met until Milestone 7 ships the harness (FR-084, research #16) | Waiting to merge until Milestone 7 (blocks the phase); a minimal harness now (Milestone 7's work, done twice) |
