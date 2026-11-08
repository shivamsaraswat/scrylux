# Contract: the `extract_system` kind

`apps/api/src/worker/extract-system.ts`, registered in `worker/kinds.ts`. It works through the `RunContext` of
Milestone 2 and returns a `KindOutcome` with a `commit` (research #10).

## Steps

1. **`select`**
   - Read the threat model's sources with their derived status (Milestone 3's store). Record each as read (ready) or
     left out (waiting, processing, failed). No ready source: fail `no_ready_source`.
   - `choosePath` (research #6), the same function the route uses: whole when the ready sources' `text_chars` sum to at
     most `EXTRACTION_CONTEXT_CHARS` and their `chunk_count` to at most 1,000. Read every chunk in source order
     (`added_at`, `id`) and position.
   - Otherwise the retrieval path: no embedding provider → `not_configured`; a ready source whose embedding model or
     dimension differs from the configured one → `embeddings_out_of_date`. Embed the queries of
     `retrieval-queries.yaml` in one `llm.embed` request (after `beforeRequest`, recorded with `record`), then run the
     one ranking statement of research #6 and fill the budget: first chunks as seeds, up to a quarter of the budget,
     then ranked chunks interleaved, skipping any that would pass the budget.
2. **`generate`**
   - Build the content: one header line and the text of each chunk, labelled `c1`… in the order sent (research #3).
   - `beforeRequest({ operation: 'generate', inputChars: requestSize(request) })`, then `llm.generate` with
     `schema: DraftAnswer.superRefine(checksFor(sent))`, `schemaName: 'scrylux_draft'`, `instructions` from
     `instructions.md`, `content`, `maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS`, `attemptLimit: 3`, `signal`.
   - Record the usage. A failure of the layer ends the job with its category (`invalid_output`, `input_too_large`,
     `output_limit_reached`, `refused`, and Milestone 2's transient ones).
3. **`store`**: map labels to chunk ids, refs to new item ids, quotes to spans (research #4), and return the commit:
   lock the read sources `FOR KEY SHARE` in id order; check every cited chunk exists (else `sources_changed`); after the
   fenced update, replace the draft.

The kind never reads the threat model's elements, threats or mitigations, and never writes them (FR-020, FR-050). It
offers no tool (FR-037): `llm.generate` has no tool parameter.

## Result

What the job keeps (`keep`), shown on the Jobs page: `{ path, chunks_read, chunks_available, sources_read,
sources_left_out, items: { elements, assets, assumptions }, context_chars, max_output_tokens }`. Counts and the two
settings the retry rules compare (research #11). No text, name, label or reference (M2 FR-051).

## Failure categories added (`apps/api/data/failures.yaml`, FR-044)

| Category | Retried by the job | A start after it |
|---|---|---|
| `no_ready_source` | no | allowed once a source is ready |
| `embeddings_out_of_date` | no | refused until the sources are refreshed |
| `sources_changed` | yes, as a transient failure | allowed |

Per-kind hints for the layer's categories when the kind is `extract_system`: `invalid_output` ("The model did not
return a draft that passed Scrylux's checks after 3 attempts. Try again, or ask the operator to choose a larger model."),
`input_too_large` (lower `EXTRACTION_CONTEXT_CHARS`), `output_limit_reached` (raise `EXTRACTION_MAX_OUTPUT_TOKENS`).

## Logs

One line per run, after it ends: `{ "event": "extract_system", "job_id", "threat_model_id", "path", "chunks_read",
"chunks_available", "elements", "assets", "assumptions", "outcome" }`. Nothing else (FR-065).
