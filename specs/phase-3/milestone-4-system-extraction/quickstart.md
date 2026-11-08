# Quickstart: validating system extraction

How to prove the milestone works. §1 runs in CI with no provider and no secret (FR-083); §2 and §3 are by hand, and §3
is the recorded pre-release run that stands in for the eval gate until Milestone 7 (FR-084).

## Prerequisites

- The dev database on the pgvector image (Milestone 3): `docker compose up -d db`.
- `pnpm install`. No new dependency (research #18).

## 1. Automated suites

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`. What each part proves:

| Area | Test location | Proves |
|---|---|---|
| Migration 018 | `packages/db/test/` | the tables and checks of [data-model.md](./data-model.md); one draft per threat model; a citation's `chunk_id` set to NULL when its source is deleted, the draft kept; the partial unique index refuses a second active extraction; cascades from threat model and project (FR-042, FR-054, FR-056) |
| Answer schema | `packages/core/test/draft.test.ts` | `DraftAnswer` is strict everywhere (`assertStrict`), its JSON Schema is the same for every request and holds no refinement, the limits of research #9 |
| Settings | `apps/api/test/extract-system/config.test.ts` | every row of [contracts/configuration.md](./contracts/configuration.md): defaults, ranges at both ends, a bad value refused by name and never by value (FR-010) |
| Prompt files | `apps/api/test/extract-system/prompt.test.ts` | the files load; the queries file's rules; the prompt version's pattern, stability, and change on any one-character change to a file or the schema; no placeholder a source could fill (research #12) |
| Content | `apps/api/test/extract-system/content.test.ts` | labels in send order; header lines with source and location; content only in `content`; no chunk id or source id anywhere in the request (FR-020, FR-036) |
| Acceptable as it stands | `apps/api/test/extract-system/acceptable.test.ts` | every element of a stored draft can be created in a threat model through the existing element writes with no constraint error (FR-033) |
| Sources changed | `apps/api/test/extract-system/sources-changed.test.ts` | the three rules of research #13, including a source added and a left-out source made ready while the model answers; never from `made_at` (FR-053) |
| Request checks | `apps/api/test/extract-system/checks.test.ts` | one answer per rule of research #2, each invalid with one issue; issue messages are fixed text under 300 characters and never contain the answer's names, refs, labels or quotes; a label not sent; a quote off by a word, by case, by a quotation mark (invalid) and by whitespace only (valid); flags without citations; boundary cycles; duplicate names ignoring case (FR-022, FR-031 to FR-034, SC-003) |
| Attempts | `apps/api/test/extract-system/attempts.test.ts` | against Milestone 1's stub: an answer fixed on the second attempt is stored; one never fixed fails `invalid_output` after 3 and stores nothing; the retry note names the problems; a cut-off answer fails `output_limit_reached` at once; a provider refusing the input as too long fails `input_too_large` with the hint to lower the budget (FR-016, FR-035, SC-004) |
| Paths | `apps/api/test/extract-system/select.test.ts` | the whole path sends every chunk in order and makes no embedding request; over the budget, the retrieval path sends chunks within the budget, in source order, first chunks first; out-of-date embeddings and no embedding provider at run time; 1,000-chunk limit (FR-011 to FR-015, SC-007) |
| Retrieval at scale | `apps/api/test/extract-system/retrieval-scale.test.ts` | 20 sources, 10,000 chunks with 3,072-dimension vectors generated in SQL, ranked in under 2 s, in one statement; a source of another dimension or model is never compared (SC-006) |
| The kind end to end | `apps/api/test/extract-system/kind.test.ts` | progress steps; the draft written in the commit with its items, citations, read chunks and sources; a successful run replaces the draft, a failed or cancelled one keeps it; a source deleted during the run fails `sources_changed` and runs again; a source added, and a left-out source made ready, during `generate` make the stored draft say its sources changed; a lost run writes nothing; 0 elements, threats or mitigations changed (FR-040 to FR-053, SC-005) |
| Caps and context | `apps/api/test/extract-system/caps.test.ts` | the request built at the default budget with the real schema and instructions, in its largest form, plus the output limit fits 32,768 tokens with 15% to spare; `worstCase` fits the default caps with 3 attempts and 2 retries; `cap_reached` stores nothing (FR-016, FR-043) |
| Retry note | `packages/llm/test/attempts.test.ts` (extended) | every zod issue code, against an answer whose keys and values are a canary: the retry note holds none of it, including `unrecognized_keys` (research #2) |
| Injection | `apps/api/test/extract-system/injection.test.ts` | sources holding "ignore your instructions", a fake end marker, a request to cite another threat model's chunk and to call a tool: the stub records that all source text, names and headers are inside the nonce-marked section and none in the instructions; no tool is offered; answers that follow the injection (a label not sent, an unknown field whose name is an instruction, a quote from another threat model) are rejected, and the next attempt's retry note holds none of their text; markup in names is stored as text (FR-036, FR-037, SC-008, US6). Resolves the constitution's Spoofing and stored-injection items |
| Routes | `apps/api/test/contract/v1/extraction*.test.ts` | every status of [contracts/http-api.md](./contracts/http-api.md) in its order; two starts at once queue one job; `POST /jobs` refuses the kind; the retry rules per category (SC-012); `GET …/draft` resolves citations, quotes read from chunks, "source deleted"; `sources_changed` per rule of research #13; discard; write-log lines |
| Canary | `apps/api/test/worker/canary.test.ts` (extended) | a fake text, name and quote run through every extraction outcome appear in 0 log lines, job rows, usage rows, failure messages or error answers (SC-009) |
| Settings | `apps/api/test/startup-process.test.ts` (extended) | each process refuses a bad `EXTRACTION_*` value by name, never by value |
| Layout | `packages/core/test/draft-layout.test.ts` | members inside their boundary, nested boundaries sized to fit, no overlap, deterministic |
| Web | `apps/web/src/pages/DraftTab.test.tsx`, `components/ExtractionNotice.test.tsx` | notice wording per configuration; each refusal's message; replace warning; polling only while active; banner on every view; citations, "source deleted", "no remaining citation"; every draft text rendered as text (FR-060 to FR-072) |
| Browser | `apps/web/e2e/draft.spec.ts` | add a source → ready → start extraction with a stubbed generation answer → the draft diagram and list → select an item → open a citation in its source → discard; the hosted notice on screen before the start button can be used (SC-010) |

## 2. By hand: a draft from a real document

1. Start the stack with a hosted generation provider and an embedding provider (`docs/ai-providers.md`).
2. Create a threat model, add the sample design document `evals/samples/scrylux/design.md` (committed with this
   milestone, about ten pages, the first of Milestone 7's samples) on the Sources tab, and wait until it is ready.
3. Open the Draft tab: check the notice names the provider. Start the extraction.
4. When it ends: check the draft diagram and list, select three items, open each citation, and check the quoted passage
   is in the source's chunk. Check the threat model's Diagram and Threats tabs are unchanged.
5. Lower `EXTRACTION_CONTEXT_CHARS` to 8000 on both processes, restart, start again: check the draft says it read part
   of the chunks, and how many.
6. Delete the source: check the draft says its sources changed and its citations show "Source deleted".

## 3. Pre-release run (FR-084, SC-002)

With Scrylux on the smallest host the deployment guide names and the default settings, run §2 steps 1–4 twice: once
with a hosted provider, once with Ollama on a host with a GPU and the candidate local models (research #8), with
`OLLAMA_CONTEXT_LENGTH=32768`. Record in `evals/manual-runs/m4.md`, for each run: provider, model, the Ollama host's
hardware, context setting, `LLM_TIMEOUT`, valid draft or not, attempts, item counts, input tokens the provider
reported, usage, cost and duration. The run passes when a hosted model, and a local model where the maintainer has hardware for one, give a valid draft within 5
minutes. The local run was waived on 2026-11-09 (`evals/manual-runs/m4.md`). `docs/ai-providers.md` names the local model that passed and the hardware it ran on, once one has.
