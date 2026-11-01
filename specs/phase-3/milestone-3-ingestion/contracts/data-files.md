# Contract: data files

## `apps/api/data/failures.yaml` (Milestone 2's, extended)

Gains one entry per category of [data-model.md](../data-model.md#failure-categories), each `{ message, hint }`, and two
additions to its shape:

- `details`: per category and detail, a message that replaces the category's (`unreadable.time`, `unreadable.memory`),
  as `cap_reached.cap_below_one_request` does today.
- `kinds`: per job kind and category, a hint that replaces the category's for that kind. Used for
  `ingest_source.input_too_large` and `refresh_embeddings.input_too_large`: "This embedding model does not accept
  Scrylux's chunk size of 2,000 characters. Choose an embedding model that accepts at least 2,048 tokens."
- `sources.cancelled`: the message and hint a source shows when its ingestion was cancelled ("Processing was cancelled.
  Retry to process it again.").

The loader (`jobs/failures.ts`) checks, at start, that every category of `JobFailureCategory` has an entry and that no
entry names an unknown category, kind or detail. No message names a file, a path, a provider error or any content
(M2 FR-064).

## pdfjs-dist's CMaps and standard fonts

Read from the installed package's `cmaps/` and `standard_fonts/` directories, resolved from the package's location at
run time, never fetched (research #4). The Dockerfile copies nothing extra: `pnpm deploy --prod` ships the package with
them.
