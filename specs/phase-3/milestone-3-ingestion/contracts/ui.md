# Contract: the Sources tab

`apps/web`, research #17. Every name, text and chunk is rendered as a text node, never as markup (FR-066).

## `/threat-models/:id/sources` (a tab beside Threats and Diagram)

1. **The notice** (FR-070 to FR-072), from `GET /jobs/status`, above the add form and above the list:
   - embeddings hosted: "Text you add here is sent to <provider> outside this install, to make its embeddings."
   - generation hosted: "When the AI features of later releases run, they send this text to <provider> outside this
     install."
   - only local providers: "Text you add here stays in this install: the configured providers run locally."
   It is part of the form, before the submit control, on every visit.
2. **Adding** (offered only when an embedding provider is configured; otherwise "Adding documents needs an embedding
   provider. Ask the operator to set one up." and no form):
   - **Upload**: a file input accepting `.md,.txt,.pdf,.docx`, several at once. The files are sent one at a time, in
     order; each shows its own result (added, or the refusal's text). Files over the limit are refused in the browser
     first, with the same text. The request helper shows the server's `{ error }` text for every refusal, `503` and
     `507` included, not a generic server-error message.
   - **Paste**: a title (1–200) and a text area; "Add text".
   - The limits from `SourceList.limits`: the size, the count, and how full the document space is.
3. **The list**: name, type, size, who added it, when, the status (waiting, processing with its step and `done of total`
   chunks, ready with its chunk count and embedding state, failed with message and hint), and actions: **Retry** (when
   `failure.retryable` or `refresh_failure.retryable`), **Refresh embeddings** (when `refreshable`), **Delete** (with the
   existing `ConfirmDialog`: "Delete <name>? Its text and chunks are removed."). "No worker is processing documents" when
   a source is waiting and `worker_alive` is false (FR-064).
4. **Refetching**: every 2 s while a listed source is waiting or processing, or refreshing; none otherwise (FR-063).

## `/threat-models/:id/sources/:sourceId`

The source's facts, its pages without text (PDF), its embedding state, and its chunks in order, 50 at a time ("Show more"),
each with its position, its pages or lines, and its heading, and its text in a `<pre>`-styled block that keeps line
breaks.

The page offers the same actions as the list for its source, under the same rules: **Retry** (when `failure.retryable` or
`refresh_failure.retryable`), **Refresh embeddings** (when `refreshable`) and **Delete** (after the same question, then back to
the list). A source that is not ready shows its status, and its failure's message and hint, in place of the chunks. (Retry here
was added in implementation, for T074's "last refresh failure with Retry", and kept for a failed ingestion.)

## Jobs page

Rows of the new kinds read "Process a document" and "Refresh embeddings", and the job's page links to its source when
`source_id` is not null ("The document was deleted" otherwise).
