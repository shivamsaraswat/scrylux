# Research: System Extraction

Phase 0 of [plan.md](./plan.md). Each section is one decision: what was chosen, why, and what else was weighed. The
spec's requirements are cited as FR-nnn, Milestone 2's as M2 FR-nnn, Milestone 3's as M3 FR-nnn.

## 1. One job kind, `extract_system`, in three steps

**Decision**: A new job kind `extract_system`, run by the worker, with the progress steps `select`, `generate` and
`store` (FR-040). Its input is `{}`: the job row's `threat_model_id` names the threat model (FR-041), as an ingestion
job's `source_id` names its source. The kind:

1. **select**: reads the threat model's ready sources and their chunks, decides the path (#5) and, on the retrieval path,
   embeds the queries and chooses the chunks (#6). Records which sources it read and which it left out (FR-004).
2. **generate**: one structured request through `llm.generate`, under `beforeRequest` (the caps, M2 FR-042).
3. **store**: maps the answer back to chunks and items (#3) and returns a `RunCommit` (#10) that writes the draft in the
   transaction that ends the job.

`NEEDS` in `apps/api/src/jobs/kinds.ts` gains `'generation'`, so Milestone 2's rule for kinds that call a model applies
with the generation provider (FR-047). Whether the retrieval path also needs embeddings is decided by the route and the
kind (#7), because it depends on the sources, not on the kind.

**Rationale**: Milestone 2 gives a kind its caps, progress, cancellation, retries of transient failures and the fenced
commit. The three steps are what a person waiting on the page can tell apart: the cost is in `generate`.

**Alternatives considered**: one job per source, merged into one draft afterwards (a merge step the spec does not ask
for, and a model that never sees how the sources relate); a synchronous route (the API never calls a provider, M2 FR-070).

## 2. Validation: a fixed schema, and the request's own checks in a refinement

**Decision**: `packages/core/src/schemas/draft.ts` holds `DraftAnswer`, a zod schema of strict objects whose JSON Schema
is the same for every request: kinds, lengths, item limits, the label pattern `^c[1-9][0-9]{0,3}$` for a cited chunk and
`^[a-z][a-z0-9_]{0,23}$` for an item's reference. The worker builds, per request, `DraftAnswer.superRefine(check)`, where
`check` holds what only this request knows: the labels that were sent and each chunk's text. zod 4 leaves a refinement
out of `toJSONSchema` and runs it in `safeParse` (checked at planning against the version in the lockfile), so:

- the provider is sent the fixed schema, and its sanitizing (`sanitizeFor`) sees no per-request enum;
- the attempt loop's `req.schema.safeParse` runs the checks, so a failed check is a schema attempt, retried with the
  issues in `prompts/schema-retry.md`, and "invalid output" after the attempt limit (FR-035), with no change to the
  attempt loop beyond the fix to its issue messages below.

The refinement checks, in order, with one issue per problem: a cited label that was not sent (FR-032); a quote not in
its chunk (#4); a reference that names no item, or an item of the wrong kind (a flow's endpoint must be a process, a
data store or an external entity, an element's boundary must be a trust boundary, an asset's holder must be an element);
a flow with the same source and target, or with a boundary; a boundary nested in itself through any chain; two items of
one kind whose names are equal ignoring case; a reference used twice; a flag that does not apply to the item's type,
or the same flag twice; and a `nothing_found` reason that is missing when every list is empty or present when one is not
(FR-024, FR-031 to FR-034).

**The retry note carries no document text.** Every issue message is fixed text with its path, such as
`elements.3.citations.0.quote: is not in the cited chunk`. It never quotes a name, a reference, a label or a quote that
the model wrote, because that text may come from a document and would go back into the next request outside the
marked content section: `userTurn` appends the retry note after the section's end marker. Each message is at most 300
characters, the size `RETRY_ALLOWANCE_CHARS` assumes, and a test holds both rules.

**A fix in the layer.** Planning found that zod's own message for `unrecognized_keys` quotes the unknown keys
(`Unrecognized key: "…"`), and `describeIssues` in `packages/llm/src/attempts.ts` passes it through. A document could
make the model write a key whose name is an instruction, and the retry note would carry it to the model outside the
marked section. Nothing sent document text to generation before this milestone, so it was harmless until now.
`describeIssues` changes to use fixed text for that code ("has a field that is not allowed") and for any code whose zod
message can include input. A layer test runs every zod issue code against an answer whose keys and values are a canary,
and checks the retry note holds none of it.

**Rationale**: the structure, citations and references can only be checked against the request, so they cannot be in
a fixed schema. A per-request enum of labels would put them in the JSON Schema, where providers limit enum sizes and
the prompt version (#12) would no longer name one schema.

**Alternatives considered**: checking after the layer returns and calling it again (attempts and caps counted twice,
and the retry note would not say what was wrong); a `validate` hook added to `@scrylux/llm` (a layer change that the
refinement makes unnecessary).

## 3. Labels for chunks, references for items

**Decision**: The content section lists the chosen chunks in the order sent (#5, #6), each under a header line that
the instructions describe: `[c7] <source name> · page 3` (or `lines 40–58`, `section: <heading>`). The model cites `c7`.
Items carry a `ref` the model chooses, unique in the answer, and name each other by it: a flow's `source` and `target`,
an element's `boundary`, an asset's `held_by`. When storing, Scrylux maps labels to chunk ids and refs to the new item
rows. No database id is ever sent (FR-036).

**Rationale**: a UUID is 36 characters, and a model copying it is a common source of invalid output, especially on a
small local model. A label the model could not have seen does not resolve, so a citation outside the request fails
validation without any lookup. A chunk of another threat model cannot even be named (FR-032, US6).

**Alternatives considered**: sending chunk ids (longer answers, copy errors, and ids of the install in the prompt);
names as references between items (a process and a data store may share a name).

## 4. Quotes: checked with whitespace treated as one, stored as a span of the chunk

**Decision**: A citation is `{ chunk: label, quote: 12–200 characters }`. The check collapses every run of Unicode
whitespace to one space and trims, in both the quote and the chunk's text, then looks for the quote in the chunk. No
other difference is allowed: case, punctuation and quotation marks must match (FR-032). On a match, Scrylux maps the
position back to the chunk's own text and stores the citation as `quote_start` and `quote_end`, in code points within
the chunk, as Milestone 3 counts its offsets. The first match is kept.

The quote's text is never stored. It is read from the chunk when the draft is shown. When a source is deleted, its
chunks go (M3 FR-053), the citation's `chunk_id` becomes null, and the citation is shown as "source deleted" (FR-054).

**Rationale**: storing the quote would keep a copy of a deleted document's text in the draft, against Milestone 3's
promise that deleting a source removes its text. 12 characters is enough to refuse quotes like "the API" that match
anywhere.

**Alternatives considered**: storing the quote (above); a fuzzy match (a misdirected citation can pass); a minimum of
one word (matches too much).

## 5. The context budget, and which path an extraction takes

**Decision**: `EXTRACTION_CONTEXT_CHARS`, read by the API and the worker, default **36,000**, from 2,000 to 2,000,000.
It counts the characters of chunk text sent, not the instructions, the headers or the schema, which are fixed and
included in the sizing below. If the ready sources' `text_chars` add up to at most the budget, the extraction takes the
**whole** path: every chunk, ordered by the source's `added_at`, then `id`, then the chunk's position (FR-011). Otherwise
it takes the **retrieval** path (#6). At most 1,000 chunks are sent in one request, which the label pattern allows.

**Sizing (FR-016)**, with the layer's estimate of 4 characters a token, for one attempt at the defaults:

| Part | Characters | Tokens |
|---|---|---|
| Instructions and the content-section preamble | about 6,000 | 1,500 |
| JSON Schema of `DraftAnswer` (sent natively, or in the instructions) | about 5,000 | 1,250 |
| Chunk headers, at most about 20 chunks at the default budget | about 2,500 | 625 |
| Chunk text | 36,000 | 9,000 |
| `RETRY_ALLOWANCE_CHARS` | 8,000 | 2,000 |
| **Input** | **about 57,500** | **about 14,400** |
| Output limit (`EXTRACTION_MAX_OUTPUT_TOKENS`, #9) | | 12,000 |
| **One call** | | **about 26,400** |

- **A 32,768-token local context** holds one call with about 20% to spare, for tokenizers denser than the estimate. The
  pre-release run checks the margin against the tokens the provider reports (#8).
- **The default caps** (500,000 tokens and $5, M2): the worst case is 5 calls (3 schema attempts and 2 transient retries,
  `worstCase`), about 132,000 tokens. At the dearest list price below the "pro" tier (Fable 5.1, $10 and $50 a million),
  that is $3.73, measured by `apps/api/test/extract-system/caps.test.ts`, which also checks every model of the price list. One does not fit at the default $5: `gpt-6-astra`, priced like Fable 5.1 but with a higher tier above 272,000 input tokens, which the worst case takes as a ceiling although one request here is about 14,600 tokens. Its worst case is $5.96, so its job stops as `cap_reached` with `cap_below_one_request` until `JOB_COST_CAP` is 6 or more; the operator's guide says so. A "pro" model, such as gpt-5.5-pro, needs more than $5 for one request and fails as "cap reached"
  with `cap_below_one_request`, whose hint already tells the operator to raise the cap (M2 FR-044).
- **About ten pages** of a typical design document (3,000 to 3,500 characters a page) take the whole path, which SC-002
  measures.
- **The table's estimates are tested, not trusted.** `caps.test.ts` builds the request at the default budget with the
  real `DraftAnswer` and instructions, in the JSON-instructions mode that adds the pretty-printed schema (the largest
  form), takes `requestSize`, and asserts that it plus the output limit fits 32,768 tokens with at least 15% to spare,
  and that `worstCase` fits the default caps.

**Rationale**: characters are what Scrylux stores and can count before sending. A budget in tokens would need the
model's tokenizer, which the layer does not have.

**Alternatives considered**: a budget per model from `models.yaml` (a context size table to keep up to date, for a
setting the operator can set); a larger default (a 32k local context would no longer hold it).

## 6. Retrieval: exact, one pass, within the threat model

**Decision**: On the retrieval path, the worker embeds the retrieval queries (#12) with the configured embedding model in
one request, then runs one SQL statement over the threat model's ready chunks:

```text
chunks of the ready sources (reached through chunks_position_key's source_id prefix)
× the query vectors (unnest of a vector[] parameter, with ordinality)
→ cosine distance (<=>) for every pair, ranked per query (row_number over partition by query)
```

It returns the top 50 chunks of each query with their rank. The query vectors are parsed **once**, with `WITH q AS
MATERIALIZED`. This is not optional, and it was found by measuring (the first version of the statement took 17 seconds at
the largest size, against a target of 2): without `MATERIALIZED` the planner rescans the small query table for every
chunk and parses each query's text again, 80,000 parses of 30 KB at 10,000 chunks and 8 queries. The distances themselves
are cheap: one distance per chunk over all 10,000 took 97 ms. Two other explanations were tried first and were wrong:
that a vector stored out of line (`attstorage = 'e'`, as 3,072 dimensions are) is fetched once per query, and that the
arithmetic dominates. Reading each vector once (a lateral `l2_normalize`, a materialized copy) made no difference.

The worker then fills the budget:

1. **Seeds**: the first chunk of each ready source (which usually names the system and its parts), in source order,
   while they take at most a quarter of the budget.
2. **Ranked**: the queries' results interleaved by rank (the first of every query, then the second of every query…),
   skipping chunks already chosen.

A chunk that would pass the budget is skipped, and filling goes on with the next, until no candidate fits. The chosen
chunks are sent in source order, then position (FR-012). The draft records them (FR-014).

**The path is one function.** `choosePath(readySources, budget)` in `extract-system/select.ts` decides from the ready
sources' `text_chars` and `chunk_count`: whole when the text fits the budget and there are at most 1,000 chunks,
retrieval otherwise. The route and the kind call the same function, so the API never approves a path the worker would
not take.

**No approximate index (clarified at planning).** plan.md planned "the vector index it queries". Three facts decided
against it:

- The query is always filtered to one threat model: at most 10,000 chunks at the default limits (20 sources × 500
  chunks of 2,000 characters). An HNSW or IVFFlat index over the whole install answers a filtered query by scanning its
  graph and dropping the rows of other threat models, which returns fewer rows than asked unless iterative scans are
  tuned, and recall that depends on the rest of the install.
- `chunks.embedding` has no fixed dimension (M3 FR-032). An index needs one, so it would be one partial expression index
  per dimension, created for the models someone happens to configure.
- An exact pass is fast enough. At 10,000 chunks of 3,072 dimensions and 8 queries (80,000 distances over about 120 MB of
  vectors) it took **0.5 to 0.7 seconds** on a PostgreSQL 16 container running natively on arm64, against a target of 2
  (SC-006). `apps/api/test/extract-system/retrieval-scale.test.ts` measures it at that size on every run and fails above
  2 seconds. A host without SIMD, or an emulated one, will be slower; the operator's guide says the cost is linear in the
  number of chunks and the dimension.

The existing `chunks_position_key` (source_id, position) finds a threat model's chunks. No migration adds an index.

**Rationale**: exact results, for every dimension, with no setting and no index to maintain, at the size the limits
allow. If Phase 6 lifts the limits far enough for this to be slow, an index can be added then.

**Alternatives considered**: an HNSW index per documented dimension (above); one statement per query (8 reads of the
vectors instead of 1); retrieval by keywords (a second ranking with no gain the embeddings do not give).

## 7. Embeddings on the retrieval path

**Decision**: The whole path needs no embeddings. The retrieval path needs a configured embedding provider and every
ready source's `embedding_model` and `embedding_dimension` equal to the configured ones. The route checks this at start
(`409`, naming which, FR-015) using the API's settings; the kind checks it again at `select` using the worker's, and
fails as `embeddings_out_of_date` (not retried; a start is refused until the sources are refreshed) or `not_configured`.

**Rationale**: Milestone 3 forbids comparing two models' vectors, and the query vectors come from the configured
model. Refusing beats leaving the out-of-date sources out, which would read part of the documents without saying why.

## 8. Local models and silent truncation

**Decision**: The documentation (`docs/ai-providers.md`, FR-082) states that extraction at the default budget needs a
context of at least **32,768 tokens** and, for Ollama, sets `OLLAMA_CONTEXT_LENGTH=32768` on the Ollama server. It names
the local generation model that the pre-release run (FR-084) found to give a valid draft of the sample document. The
candidates are 7B to 14B instruction models with a 32k context and reliable JSON output. The guide's current example,
`llama3.2` (3B), stays the example for the provider check, and the guide says it is too small for extraction. The run
records, for each model: the context setting, the input tokens the provider reported, valid or not, attempts, item
counts, usage and duration.

**Rationale**: Ollama cuts an input longer than its context with no error (`docs/ai-providers.md` says so already), and
the model then reads part of the sources while the draft says it read them whole. Nothing in the answer reveals it.

**Time, too.** A full draft is up to 12,000 output tokens. A hosted model writes that in one to three minutes, inside
`LLM_TIMEOUT`'s default of 5 minutes a call. A local model on a GPU is close to it, and one on a CPU is far past it. A
call that times out fails as `provider_unavailable`, which is transient, so the job runs again, and pays again. The guide
therefore says, for local generation, to set `LLM_TIMEOUT` to cover the output limit at the host's speed (for example
`30m` on a CPU), and that `JOB_TIME_LIMIT` (60 minutes) bounds the whole job. No new setting: the operator already
sets both. The pre-release run records the Ollama host's hardware with its duration, and SC-002's 5 minutes applies to
a host with a GPU.

**Alternatives considered**: comparing the reported input tokens with the estimate and failing when they are much lower.
Ollama reuses its cache across the attempts of one request and then reports only the tokens it evaluated, so the
comparison would fail correct requests. Rejected as unreliable; the documented requirement and the recorded run remain.

## 9. The output limit and the item limits

**Decision**: `EXTRACTION_MAX_OUTPUT_TOKENS`, worker only, default **12,000**, from 1,000 to 32,000 (the layer's
maximum). The schema allows at most **40 elements, 15 assets and 15 assumptions** (FR-034); with rationales of at most
300 characters, descriptions and statements of at most 300, at most 5 citations an item and 2 a flag, a full draft is
about 170 tokens an item, about 11,900 tokens in all. An answer cut off at the limit fails at once as
`output_limit_reached` (the layer does not retry it), with the hint that the draft was larger than the output limit
and that the operator can raise `EXTRACTION_MAX_OUTPUT_TOKENS`. A start after it is refused until the limit or the
generation model changes (FR-045).

**Rationale**: 40 elements is a larger system than one design document of ten pages describes; Milestone 5 accepts
them into a threat model that holds 1,000. The limits keep a full answer inside the output limit, so the common failure
is a model that writes too much, which the hint addresses.

## 10. The draft is written in the commit, in one lock order

**Decision**: The kind returns a `RunCommit` (M3 research #2):

1. `lock`: `SELECT id FROM sources WHERE id = ANY($read) ORDER BY id FOR KEY SHARE`. Every source the draft read must
   still exist; if one is gone, the commit's check fails the job.
2. `check`: every cited chunk id still exists. If a source or a chunk is missing, the outcome becomes `failed` /
   `sources_changed`, which is transient (FR-044, FR-051): the job runs again, chooses again and asks again.
3. Milestone 2's fenced update of the job row.
4. `write`, only if the job succeeded: delete the threat model's draft, if any, and insert the new one with its items,
   citations, sources and read chunks (data-model.md).

Lock order: the source rows in id order, then the job row, as every Milestone 3 path locks a source before its jobs.
`FOR KEY SHARE` blocks a source's deletion until the commit ends, without blocking a refresh's `FOR UPDATE` on another
row, and two extractions on one threat model cannot commit at once (#11). A deleted threat model takes its jobs with it,
the fenced update returns `lost`, and nothing is written.

**Rationale**: a source deleted between the check and the insert would otherwise surface as a foreign-key error in
`write`, which throws, loses the job's clean failure, and is retried as a job error.

## 11. Starting: one route, one active extraction, Milestone 2's limit

**Decision**: `POST /threat-models/{id}/extraction` starts one ([contracts/http-api.md](./contracts/http-api.md)). In
one transaction it takes the account lock (M2), then checks, in the order of the contract's table:

1. a generation provider (FR-002);
2. no extraction of this threat model queued or running, read from its latest one (FR-042);
3. no source waiting or processing (FR-004);
4. at least one ready source (FR-003);
5. the path (`choosePath`, #6) and, on the retrieval path, the embeddings (FR-015);
6. the retry rules against the threat model's latest extraction, if it failed (FR-045).

It then queues the job through Milestone 2's `enqueue`, which counts it toward the account's limit of 3 (FR-046:
`extract_system` is not an ingestion kind). A partial unique index, `jobs (threat_model_id) WHERE kind =
'extract_system' AND state IN ('queued', 'running')`, catches two starts that race past check 2. The route answers
that unique violation with check 2's `409`. Milestone 2's `POST /jobs` refuses the kind (FR-045a). No cooldown (FR-046).

The retry rules compare, as Milestone 3 does: for `cap_reached`, the job's `token_cap` and `cost_cap_usd` with the
current settings; for `input_too_large`, the job's `last_model` and a new `context_chars` field of its result with the
current model and budget; for `output_limit_reached`, the model and a `max_output_tokens` field of its result.

## 12. Prompts and retrieval queries as versioned data

**Decision**: `apps/api/prompts/extract-system/` holds `instructions.md` (the instructions: describe the system, data not
instructions, cite every item and every flag with a quote, leave unsupported flags out, say why when nothing is found)
and `retrieval-queries.yaml` (8 queries: components and services; data stores; people and outside systems; data flows,
APIs and protocols; networks, zones and trust boundaries; authentication and authorization; sensitive data and assets;
deployment, assumptions and constraints). The **prompt version** recorded on a draft is `extract-system/` followed by the
first 12 hex digits of the SHA-256 of the two files and the JSON Schema of `DraftAnswer`, computed when the worker
starts. A change to any of them changes the version without anyone remembering to bump it, which is what Milestone 7
records results by.

**Rationale**: Principle IV keeps prompts as data. A hash cannot drift from the content.

**Alternatives considered**: a hand-written version number (forgotten on a one-word change); prompts inside
`packages/llm/prompts` (that tree is the layer's own wording; this prompt belongs to the feature).

## 13. Sources changed: derived, not stored, and without timestamps

**Decision**: A draft stores its `draft_sources` rows, one for every source the extraction considered at `select`, each
with `read` true or false (left out), and `sources_total`, their number. It has changed since it was made (FR-053) when
any of these holds, computed by the API on read:

- fewer `draft_sources` rows remain than `sources_total` (a source was deleted; the rows cascade);
- a source of the threat model has no `draft_sources` row (it was added after `select`);
- a left-out source is now ready.

**Rationale**: Milestone 3's reasoning (M3 research #1): deriving needs no write from the paths that delete or add
sources. No rule compares a time with `made_at`, because the sources are read at `select` and the draft is written
minutes later: a source added, or a left-out source made ready, while the model was answering would come before
`made_at` and be missed. The kind test adds a source during `generate`, and makes a left-out one ready then, and checks
that the draft says its sources changed.

## 14. The draft diagram: a layout of its own, read-only React Flow

**Decision**: `packages/core/src/draft-layout.ts` lays out a draft from the inside out: each boundary's members (nodes
and nested boundaries) on a grid of at most 4 columns, the boundary sized to fit them with Milestone 1's header and
margin, then the top level the same way, processes and stores first. Flows are edges between their endpoints, as on the
threat model's diagram. Nothing is stored (spec assumption: layout is Scrylux's). The web app shows it with React Flow
read-only (no dragging, connecting or deleting), reusing `ElementNode` and `FlowEdge`, and a `DraftBoundaryNode` because
`BoundaryNode` depends on the editor's context. A list of every item, grouped by kind, sits beside it (FR-060).

**Rationale**: `resolveLayout` keeps a boundary at its stored or default size of 320 × 220, so a draft boundary with ten
members would spill out. A layered graph layout library (dagre, elkjs) would be a dependency for a read-only view whose
reviewer reads the list as much as the picture.

## 15. The notice on the Draft tab

**Decision**: The Draft tab shows `ExtractionNotice` above the start button on every visit: with a hosted generation
provider, "Starting an extraction sends the text of this threat model's sources to <provider> outside this install, to
the generation model." With a local one, "Extraction runs on a local model: the text stays in this install." (FR-070,
FR-071). `SourcesNotice`'s generation sentence changes from "When the AI features of later releases run" to "When you
start an extraction on the Draft tab, it sends this text to…" (FR-072). The retrieval queries are fixed text and need no
notice (FR-071).

## 16. The eval gate and the constitution's version

**Decision**: Principle II's sentence "Once any LLM-backed feature exists (Phase 3+), a change to a prompt, provider
adapter, or extraction/threat-generation pipeline MUST pass the eval harness" becomes "From Phase 3 Milestone 7, when the
eval harness ships, a change to…", with a sentence that until then such a change passes the tests with simulated
answers and the milestone records a manual run against a hosted model and, where the maintainer has hardware for one, a local model, before release (FR-084; the local run was waived on 2026-11-09, see `evals/manual-runs/m4.md`). The
constitution goes to **1.17.0**, a MINOR.

**Why MINOR and not MAJOR**: Governance reserves MAJOR for "backward-incompatible principle removals or redefinitions".
The principle (test first, an eval gate for AI changes) stays. The amendment states when a gate that could not yet be
met starts to apply, which Governance's "updating those details to match the current phase" describes, and the same
change adds guidance (the Threat Model section, FR-080). The maintainer may still prefer 2.0.0, and the PR says so.

## 17. The threat model update

**Decision** (FR-080): assets: the draft (AI text derived from confidential documents, held until it is discarded or
replaced, including after a source it read is deleted; its citations keep no text). Entry points: the four routes. The
boundary of untrusted document content into generation prompts becomes current. The outbound provider boundary carries
document text to the generation provider. Risks:

- **Tampering / Spoofing (indirect prompt injection)**: mitigated by the nonce-delimited content section (M1), labels
  instead of ids (#3), the fixed schema and its request checks (#2), quotes checked against the chunks (#4), no tool
  and no action but storing a draft (FR-037), escaped rendering, and Milestone 5's human review. Accepted: a document
  can change what is proposed, including a component the design does not have, if it can quote its own text in support;
  a reviewer sees the quote. The retry note no longer echoes any part of an answer (#2's fix to the layer), so nothing
  the model wrote reaches the prompt outside the marked section. The Spoofing "planned" item and the accepted
  stored-injection item of Milestone 3 are resolved with the tests of [quickstart.md](./quickstart.md) (§1, Injection).
- **Information Disclosure**: drafts in logs, job records and errors (canary, SC-009); exports (FR-067); a draft
  outliving its sources (discard; "sources changed").
- **Denial of Service / spend**: caps, one extraction per threat model, the account limit. Open until Phase 6: many
  accounts.
- **Elevation of Privilege**: any signed-in account can start, read and discard any draft (FR-068), the justified
  widening.

## 18. No new dependency

**Decision**: None. zod, Kysely, pgvector, React Flow and the provider layer cover it. The one change to
`@scrylux/llm` is the issue-message fix of #2.

## 19. Logs

**Decision**: The start and discard routes write Milestone 3's write-log line (who, what, threat model, job). The kind
logs at most one line per run: the path, the number of chunks read and available, the item counts and the outcome. No
name, text, quote, rationale, reference or label (FR-065).

## 20. What the live runs found (2026-11-08)

The manual runs of `evals/manual-runs/m4.md` found three things that tests with simulated answers could not.

- **Gemini refuses a long array limit.** Gemini answered `400 INVALID_ARGUMENT`, with no detail, to the draft's answer
  schema, 7 seconds in. Bisected against the provider with the layer's own schema: `maxItems` was the cause (arrays of 40
  and 15 refused, 10 accepted); patterns, string lengths and `additionalProperties` were not. **Decision**: for Gemini,
  `maxItems` moves into the field's description as the other length limits already do, and the zod schema stays the only
  judge of validity (`packages/llm/src/schema.ts`; test: `packages/llm/test/schema.test.ts`).
- **The failure hint named the wrong provider.** Every job that was not a provider check took the embedding prefix, so a
  generation failure said to check `EMBEDDING_MODEL`. **Decision**: an extraction names `LLM_MODEL`, unless it failed in its
  first step, where the embedding provider may have chosen the chunks (`failedPrefix` in `apps/api/src/jobs/store.ts`; test:
  `apps/api/test/contract/v1/extraction.test.ts`).
- **The upgrade check counted migrations by a literal.** `scripts/check-db-upgrade.sh` asserted 17 rows in
  `schema_migrations` and failed on migration 018. **Decision**: it counts the migration files.

A fourth result is not a defect: a local model run with Ollama's 4,096-token default context had its input cut to about
2,050 tokens per attempt and failed `invalid_output` with the designed hint, which confirms #8's warning that the cut is
silent. The local run was then waived (FR-084, SC-002; Principle II is worded "where the maintainer has hardware for one").

