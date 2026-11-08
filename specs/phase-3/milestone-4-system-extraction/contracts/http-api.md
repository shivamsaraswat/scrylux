# Contract: the extraction routes

Four operations on two paths under `/api/v1` (`GET` and `POST …/extraction`, `GET` and `DELETE …/draft`), defined with `defineOperation`, so the router and the generated OpenAPI document
describe the same routes (FR-064). Every one needs sign-in, answers errors as `{ "error": string }` with fixed text, and
is open to every signed-in account (FR-068). Records are those of
[data-model.md](../data-model.md#api-records-packagescoresrcschemasdraftts).

Statuses common to all: `400` (the threat model id is not a UUID, checked by `defineOperation`'s shared `uuid` schema
as for every `/api/v1` route), `401` (not signed in), `404` (no such threat model), `500`. No error answer holds a source's
name or text, or any text of a draft (SC-009). A refusal that names sources still being processed counts them and links
to the Sources tab; it does not list their names in the error text (the UI lists them from the sources it already has).

## `GET /threat-models/{id}/extraction`

`200 ExtractionStatus`: the threat model's latest extraction job, and whether a start would be accepted now and why
not. The Draft tab polls it every 2 s while `latest` is queued or running, and stops when it ends (FR-063).

## `POST /threat-models/{id}/extraction`

No body. Starts an extraction, or retries the last one (research #11). `201 JobRecord` of kind `extract_system`, as `POST /jobs` answers.

Checks in this order, each with its answer:

| Status | When | `error` (fixed text) |
|---|---|---|
| `409` | no generation provider configured (FR-002) | "Extraction needs a generation provider. Ask the operator to set LLM_PROVIDER." |
| `409` | an extraction of this threat model is queued or running, read from its latest one, or caught by the unique index when two starts race (FR-042) | "An extraction of this threat model is already queued or running." The page finds the job in `GET …/extraction`. |
| `409` | a source is waiting or processing (FR-004) | "2 sources of this threat model are still being processed. Wait until they are ready." |
| `409` | no ready source (FR-003) | "Extraction needs at least one ready source. Add a document on the Sources tab." |
| `409` | retrieval path, no embedding provider (FR-015) | "These sources are larger than the extraction budget, and choosing among them needs an embedding provider. Ask the operator to set EMBEDDING_PROVIDER." |
| `409` | retrieval path, a ready source's embeddings out of date (FR-015) | "These sources are larger than the extraction budget, and 1 of them has embeddings from another model. Refresh its embeddings on the Sources tab." |
| `409` | the latest extraction failed in a way that would repeat (FR-045) | "Retrying would reach the same cap. Ask the operator to raise JOB_TOKEN_CAP or JOB_COST_CAP." / "The input was too large for this model. Ask the operator to lower EXTRACTION_CONTEXT_CHARS or choose another model." / "The draft was larger than the output limit. Ask the operator to raise EXTRACTION_MAX_OUTPUT_TOKENS." / the embeddings sentence above |
| `429` | the account has 3 jobs queued or running (M2 FR-046), `Retry-After` | Milestone 2's text |

A start does not ask whether a draft exists: replacing it is the expected result, and the UI says so before the
button is used (FR-052).

## `GET /threat-models/{id}/draft`

`200 DraftRecord`, or `404` "This threat model has no draft." Every text in it is AI-generated or document text and is
rendered as text by the UI (FR-066). Citations whose source was deleted have `chunk: null, quote: null`.

## `DELETE /threat-models/{id}/draft`

Discards the draft. `204`. `404` when there is none. An extraction queued or running is not cancelled: if it succeeds,
it writes a new draft.

## Changes to existing routes

- `POST /jobs` refuses `kind: "extract_system"` with `400` and the error `kind: This kind of job is started from a threat model's Draft tab.` (FR-045a; the `kind:` is the schema's own path prefix, as for every body error), and the ingestion kinds the same way with "Sources tab". An unknown kind keeps the schema's own message. Nothing is queued (`apps/api/test/contract/v1/jobs.test.ts`).
- `GET /jobs`, `GET /jobs/{id}`: the new kind, its steps and its categories. Its result holds only counts and ids
  ([worker.md](./worker.md#result)).
- `DELETE /threat-models/{id}` and `DELETE /projects/{id}`: unchanged; drafts and extraction jobs cascade (FR-056).
- Exports, imports and reports: unchanged; drafts are never read by them (FR-067).

## Write log

`POST …/extraction` and `DELETE …/draft` write one line each: `{ "event": "extraction", "action": "start" | "discard", "account_id",
"threat_model_id", "job_id" }`, with `job_id` on a start only. Nothing else (FR-065).
