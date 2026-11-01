# Research: Ingestion

Phase 0 of [plan.md](./plan.md). Each section is one decision: what was chosen, why, and what else was weighed. The
spec's requirements are cited as FR-nnn, Milestone 2's as M2 FR-nnn.

## 1. A source's status is derived from its latest job, not stored

**Decision**: `sources` holds only what a source is (name, type, size, digest, who added it) and what its successful
ingestion wrote (text length, chunk count, embedding model and dimension, ready time). Its status is read from the
source's latest `ingest_source` job when it is not ready: `queued` → waiting, `running` → processing, `failed` or
`cancelled` → failed, with the job's failure category (or `cancelled`). A ready source is ready whatever its jobs say. A
refresh in progress, and the last refresh failure, are read the same way from its latest `refresh_embeddings` job.

**Rationale**: Milestone 2 ends a job in five places: the worker's `finishRun`, the sweep (a lost worker, a passed
deadline), the hand-back of a stopping worker, the API's cancel of a queued job, and a threat model's deletion. Storing a
source status would need each of them to update it too, in the same transaction, or the two would drift. Deriving it
needs none of them to change, and the job already holds the category, the progress and the time.

**Alternatives considered**: a `status` column kept by triggers on `jobs` (logic in the database, hard to test, and a
trigger firing on every heartbeat); a `status` column set by the worker only (wrong after a sweep or an API cancel).

## 2. Writing chunks: one transaction, fenced, with one lock order

**Decision**: A kind's outcome may carry a **commit** (`KindOutcome.commit`), and `finishRun` runs it in the transaction
that ends the job:

1. `commit.lock(trx)`: `SELECT … FROM sources WHERE id = $1 FOR UPDATE`, then the document-space lock (#12).
2. `commit.check(trx)`: the document-space check (FR-009). A source that would pass it turns the outcome into
   `failed` / `document_space_full`.
3. The fenced `UPDATE jobs … WHERE id = $1 AND claim = $2 AND state = 'running'` of Milestone 2, unchanged.
4. If and only if that update returned `succeeded`: `commit.write(trx)` inserts the chunks with their embeddings (or,
   for a refresh, replaces the embeddings) and sets the source's ready facts.

A lost run (update returns nothing) or a cancel (update returns `cancelled`) writes no chunk. A deleted source (step 1
finds no row) makes the kind's outcome `cancelled`, which is what deleting it asked for (FR-044). Chunks are inserted in
batches of 500 rows, well under Postgres's 65,535 bind parameters (10 per row).

**Lock order**: every path that touches a source and its jobs locks in one order: the source row, then the account
lock (Milestone 2's start lock), then the document-space lock, then job rows.

- Deleting a source: lock the source, cancel its active jobs (M2's cancel), delete it.
- Deleting a threat model, or a project (whose cascade reaches its threat models' sources and jobs in no fixed order):
  lock the affected sources `FOR UPDATE ORDER BY id` first, collect their original keys, then delete.
- Retrying and refreshing: lock the source, then the account lock, then the space lock, then check that no job of the
  source is active and queue one. Two retries at once therefore queue one job.
- The commit: the source, the space lock, then the job.

So no two of them wait on each other in opposite orders. A deadlock Postgres still found would fail one transaction, and
the API's answer or the worker's run would end as an error and be retried as usual.

**No database error detail is logged.** A failed check puts the row, chunk text included, in the error's detail. The
worker's run and the API's error handler log only fixed text and ids, as today, and the canary test covers a failing
commit (SC-008).

**Rationale**: FR-024 (all chunks at once, never a partial set, never a duplicate after a lost run) and M2 FR-005 (a
lost worker writes nothing) both follow from writing the whole set in the one statement group that the fence guards.
The chunks of a 1,000,000-character source and their embeddings are a few megabytes: one transaction is cheap.

**Alternatives considered**: writing chunks as they are embedded, then flipping a flag (a crash leaves rows that every
reader must filter, and a second run must delete the first's); a staging table (two copies of every chunk).

## 3. Extraction runs in a child process with no secrets

**Decision**: The worker extracts a source's text in a **child process** forked per extraction from
`dist/extract/child.js`:

- `env: {}`: the child gets no database password, provider key or storage credential, and imports no module that
  reads them. It gets the original's bytes over IPC (`serialization: 'advanced'`, which carries a `Uint8Array`) and
  answers with the extracted blocks. It has no storage and no database access.
- `execArgv: ['--max-old-space-size=<¾ of EXTRACT_MEMORY_MB>']` (**as built, the default `EXTRACT_MEMORY_MB` is 1024, not 512:
  measured, a 10 MB PDF needs about 640 MB however little text it holds, and a Word file of a million characters about 320 MB**), and the child checks its own resident memory between
  pages and between archive parts, exiting with code 3 when it passes `EXTRACT_MEMORY_MB`. The heap flag sits below the
  resident bound so that the check usually fires first. When it does not, V8 aborts the child (`SIGABRT`) or the kernel's
  out-of-memory killer ends it (a `SIGKILL` the worker did not send): both are read as `unreadable`/`memory`, never as
  `damaged`, so the category names the bound (FR-011). Container memory limits remain the last line, and the
  documentation says so.
- `stdio: ['ignore', 'ignore', 'ignore', 'ipc']`: nothing a library prints reaches the worker's log (SC-008).
- A wall-clock timer (`EXTRACT_TIME_LIMIT`) and the run's abort signal (a cancel, the deadline, a lost job, a hand-back)
  both `SIGKILL` the child at once, so Milestone 2's 10-second cancel holds during extraction.
- Any exit other than a well-formed answer fails the run: by the bound it passed (`unreadable` with detail `time` or
  `memory`, `too_large_unpacked`), or as `damaged` for any other exit. The worker and its other jobs go on (FR-011).
- **The API never loads any of it** (FR-010): Milestone 2's import-graph test, which keeps the API from importing worker
  code, is extended so that `server.ts`'s graph contains no `extract/` module and none of `pdfjs-dist`, `yauzl` or
  `saxes`.
- **Under Vitest** the child is started from `src/extract/child.ts` with `--import tsx` added to its arguments, chosen
  from the extension of `import.meta.url`, so the tests run the real isolation, not an in-process stand-in.

**Rationale**: FR-010 and FR-011. A parser bug or a crafted file can then exhaust or crash only the child, and an
exploit in it finds no credential. Node's worker threads would share the process: their `resourceLimits` do not bound
`ArrayBuffer` memory, which is where decompressed streams live, and an exploit would share the environment.

**Accepted**: the child still has the worker's network. Node offers no sandbox for it. The threat model records the
child as a process holding no secret, and that limiting its egress is the operator's (a container network policy).

**Alternatives considered**: worker threads (above); a separate parsing service (plan.md keeps that as an open decision
for when evals show extraction is the bottleneck); extracting in the worker's own process (a crash takes every job down).

## 4. Reading PDFs: `pdfjs-dist`, with evaluation and fetching off

**Decision**: `pdfjs-dist` 6.4.x (Apache-2.0, Mozilla's PDF.js), legacy build, in the child:

- `getDocument({ data, disableFontFace: true, useSystemFonts: false, enableXfa: false,
  disableAutoFetch: true, disableStream: true, stopAtErrors: false, verbosity: 0, cMapUrl, cMapPacked: true,
  standardFontDataUrl })`, with `cMapUrl` and `standardFontDataUrl` pointing at the files shipped inside the package, as
  local paths. **As built:** pdf.js 6 has no `isEvalSupported` option, because it no longer has the font-compilation path of
  CVE-2024-4367 at all; `test/extract/pdfjs-no-eval.test.ts` fails if a version brings evaluation back. Without the CMaps
  many CID-font PDFs would extract as empty text.
- Page by page, `getTextContent()`; items joined with their end-of-line marks into one block per page. A page with no
  text counts toward `pages_without_text`. All pages empty → `no_text_found` (FR-014).
- A `PasswordException` → `encrypted`. A PDF that opens without a password (an owner password only) is read.
- More than `EXTRACT_MAX_PAGES` pages (default 2,000) → `too_large` with detail `pages`, before any page is read.
- `@napi-rs/canvas`, an optional dependency for rendering, is kept out with `ignoredOptionalDependencies` in
  `pnpm-workspace.yaml`, where pnpm 12 reads its settings (as it does `allowBuilds` today), so no native code enters
  the image. Text extraction does not need it. The implementation checks that the lockfile and `pnpm deploy --prod`'s
  output both leave it out.
- pdfjs-dist 6 needs Node ≥ 22.13. The `engines` fields move from `>=22` to `>=22.13`. CI installs the newest 22 and the
  image's `node:22-alpine` is newer than that; the implementation checks the pinned digest's version.

**Rationale**: the maintained reference implementation, pure JavaScript, used by Firefox, with per-page text and a clear
password error. Reading order is the content stream's, which is right for the design documents of the eval set; tables
come out row by row.

**Alternatives considered**: `pdf-parse` (wraps an old PDF.js, or a newer one with the same engine and less control);
`unpdf` (a wrapper over the same library); a native tool such as `pdftotext` (native code in the image, a subprocess).

## 5. Reading Word files, and what the API checks at upload

**Decision**: Our own `.docx` reader in the child, about 200 lines, on `yauzl` 3.x (MIT) and `saxes` 6 (ISC):

- `yauzl.fromBuffer` with `validateEntrySizes: true`, so an entry cannot inflate past the size its header declares.
  At most 10,000 entries, and the declared uncompressed sizes of the parts read add up to at most `EXTRACT_UNPACKED_MB`
  (default 50) → otherwise `too_large_unpacked` (FR-011).
- Only three parts are read: `[Content_Types].xml`, `word/document.xml`, `word/styles.xml`. A main part whose content
  type is the macro-enabled one (`application/vnd.ms-word.document.macroEnabled.main+xml`) → `unsupported_type`. A
  missing main part → `damaged`. Nothing else in the archive is opened: no macros, embedded objects, relationships to
  outside targets, images, headers, footers, comments or footnotes (FR-012). The documentation says that headers,
  footers, comments and footnotes are not read.
- Each part is parsed with `saxes`, which resolves no external entity. A part with a `<!DOCTYPE` is refused as `damaged`:
  Word never writes one, and no entity expansion can then happen.
- Text: `w:t` runs; `w:tab` → tab; `w:br`/`w:cr` → newline; each paragraph ends with a newline; table cells are joined by
  tabs and rows by newlines, so table text keeps its order (FR-014). Headings: a paragraph whose style is named
  `heading 1`–`heading 9` or `Title` in `styles.xml` (the names are stable in every Word language; style ids are not),
  or that has an `w:outlineLvl`.

**At upload, the API reads only fixed bytes** (FR-003, FR-010): `%PDF-` in the first 1,024 bytes for `.pdf`; the ZIP
local-header signature at offset 0 for `.docx`; the OLE compound-file signature (`D0 CF 11 E0`) at offset 0 is refused
with "This is an encrypted Word file or an older .doc" (both use that container); `.doc` and any other extension are
refused as unsupported. Text types must decode as UTF-8 with no NUL byte. Anything that needs the archive's directory
(`.docm`, a missing main part) is the worker's, as above.

**Rationale**: `mammoth`, the usual choice, loads the archive with JSZip, which inflates whole entries in memory with no
bound, and its raw-text output drops headings. A reader that opens three named parts with validated sizes is small,
bounded, and gives us the headings FR-022 needs.

**Alternatives considered**: `mammoth` (above); converting to PDF or HTML first (more parsers, not fewer).

## 6. Text and Markdown: one normalization, lines counted before it

**Decision**: A text source (`.txt`, `.md`, pasted) is decoded as UTF-8 (`TextDecoder` with `fatal: true`), its leading
byte-order mark removed, and every line break (CRLF, CR or LF) written as LF. Every line break becomes exactly one LF,
so a chunk's first and last line numbers, counted in the normalized text, are the line numbers of the text as received
(FR-022). Markdown is not rendered: its text is its source text. A Markdown heading is an ATX line (`#` to `######`) or
a setext underline, outside fenced code blocks. Line numbers are recorded for text types only, page numbers for PDFs
only.

Extracted text of every type then gets the same normalization, before it is measured or chunked:

- line breaks as above;
- **NUL characters removed** (a PDF's text layer can hold them, and Postgres `text` refuses them; a text upload with a
  NUL was refused at the API already);
- **lone surrogates replaced by U+FFFD**, so the text stored is the text measured.

**Unit**: every length and offset (`text_chars`, `SOURCE_MAX_CHARS`, the 2,000-character limit, `start_offset`,
`end_offset`) counts **Unicode code points**, which is what Postgres's `char_length` counts in a UTF-8 database. The
chunker works on code points, not JavaScript's UTF-16 indices, so a chunk holding an emoji passes the table's check.
The fixtures include an astral character and a PDF whose text layer holds a NUL.

**Rationale**: the reviewer's own copy has the original line numbers; normalizing before counting would make them drift
on CRLF files.

## 7. Chunking: consecutive slices of at most 2,000 characters

**Decision**: A chunk is a slice `[start, end)` of the normalized extracted text, in code points (#6), with no overlap
and no gap: chunk *n+1*
starts where chunk *n* ends, so concatenating the chunks in order gives the text back exactly (FR-021, SC-003).

- Aim for 1,500 characters; never more than **2,000** (FR-020). Prefer to end a chunk at a page break, a heading, a blank
  line, then a line end, then a sentence end, then a space; only a run of 2,000 characters with none of them is cut at
  2,000 code points.
- A chunk is never only whitespace: whitespace at a boundary joins the chunk before it.
- Each chunk records its pages (PDF, first and last), its lines (text types, first and last) and the nearest heading
  above or at its start (Markdown, `.docx`; at most 200 characters).
- Retrieval quality from overlap is Milestone 4's to want: it can read a chunk's neighbours by position.

**Why 2,000**: the documented embedding models accept 2,048 tokens or more: Gemini's embedding model 2,048, Ollama's
default context 2,048 for `nomic-embed-text`, Titan v2 8,192, OpenAI's 8,191. Two thousand characters stay under 2,048
tokens even for text that runs at about one token per character (dense scripts, code). A model that refuses a chunk fails
the job as `input_too_large` with FR-020's hint. Ollama truncates an over-long input instead of refusing it unless told
not to; at 2,000 characters that does not happen with its default context, and the documentation says to keep that
context at 2,048 or more.

**Alternatives considered**: token-based chunking (needs each model's tokenizer); overlapping windows (breaks exact
reconstruction and stores most text twice).

## 8. Embedding: batches, the caps, and vectors of any dimension

**Decision**:

- The worker embeds the chunks in order, **64 per request**, through `llm.embed` (which splits a request into the
  batches each provider accepts, Milestone 1). Before each request it calls `beforeRequest` with `requestSize`, so
  Milestone 2's gate and caps apply (FR-042), records its usage, and reports progress `embed` with done/total (FR-040).
- Every request of a run must return the same dimension, and every vector only finite numbers (pgvector refuses NaN
  and infinity), else the run fails as `rejected` before its commit.
- **Which model is recorded**: `EmbedResult.model` is the configured `EMBEDDING_MODEL` (Milestone 1's `client.ts`
  returns `op.model`, not a name the provider sends back), so `sources.embedding_model` compares directly with the
  configured model. Ollama's `nomic-embed-text:latest` or an Azure deployment's underlying model never appear.
- **Fit to the default caps** (FR-005): a 1,000,000-character source is about 670 chunks and, at Milestone 1's estimate
  of 4 characters per token, 250,000 tokens. Milestone 2's worst case for one request is 3 × its input (the request and
  two transient retries): at most 3 × 128,000 / 4 = 96,000 tokens. At the last request, 250,000 + 96,000 = 346,000 is
  under the 500,000-token default cap, so a source of the largest default size is ingested when the provider answers at
  the first attempt. The cost is cents at listed embedding prices, far under $5.
- **Accepted, and documented**: text that runs at more tokens per character than the estimate (dense scripts, code)
  is counted at the provider's reported tokens after each request, so such a source can reach `cap_reached` well under
  1,000,000 characters. The operator can raise `JOB_TOKEN_CAP`.
- **Storage**: `chunks.embedding` is a pgvector `vector` with no fixed dimension, so any model's vectors fit (pgvector
  stores up to 16,000 dimensions; the documented models produce 768 to 3,072). A source's model and dimension are on
  the source row, written in the same transaction as all its vectors, so a source never mixes two models (FR-032).
- **No vector index in this milestone.** An approximate index needs a fixed dimension and serves a query, and Milestone
  4 is the first to query (FR-035). It adds the index it needs, per dimension, with its query, and must filter on the
  model and dimension of the configured embedding provider. Nothing in this milestone compares two vectors.
- **Refresh** (FR-034) reads the stored chunks in order, embeds them the same way, and in its commit replaces every
  chunk's embedding and the source's model and dimension.

## 9. Uploads in the API: two routes, a bounded buffer, checks before storing

**Decision**:

- `POST /threat-models/{id}/sources` takes `multipart/form-data` with one `file` part, read by `busboy` 1.6 (MIT) with
  `limits: { files: 1, fields: 0, parts: 1, fileSize: limit + 1 }` and `defParamCharset: 'utf8'`, so a non-ASCII file
  name arrives as written. A `Content-Length` over the limit is refused before
  reading. `POST /threat-models/{id}/sources/text` takes JSON `{ title, text }` with the operation's body limit set to
  twice the upload limit, and the text's UTF-8 size checked against the limit after parsing.
- `Operation` gains an `upload` form beside `body` (`apps/api/src/v1/operation.ts`): the router mounts the multipart
  reader instead of `express.json`, and the OpenAPI generator describes a `multipart/form-data` request body with a
  binary `file` property. Router and document still cannot disagree (Phase 1 research #3).
- The body is held in memory, at most the upload limit. **At most 4 bodies are read at once per API process**: a fifth
  request is refused at once with `503` and `Retry-After: 5`, before reading it (FR-004). The UI uploads one file at a
  time.
- Order: authenticate → threat model exists → embedding provider configured (409) → read the body (413, 503) → type from
  first bytes (415) → UTF-8 for text types (400) → digest (SHA-256) → quick checks without a lock (source count, document
  space, ingestion jobs, duplicate) → **store the original** → one transaction: the account lock (Milestone 2's start
  lock), then the document-space lock (#12), the same checks again, insert the source, queue its job → commit. If the
  transaction refuses, the stored original is deleted at once. A crash in between leaves an original with no source,
  which the sweep removes (#11).
- Refusals answer before anything is stored, except the ones the transaction finds, whose original is removed at once.
  So a refused upload leaves nothing in storage (FR-056).

**Rationale**: checking everything that needs only the bytes before writing to storage keeps refused uploads out of it.
Holding at most 4 × 10 MB per process bounds memory on the smallest host. A separate JSON route for pasting keeps the
paste inside the shared zod schemas.

**Alternatives considered**: streaming straight into storage (every refusal then writes and deletes, and S3 needs the
length up front or a multipart upload); a temporary file (a local path on the API host, against Principle IV's spirit);
one multipart route for both (the paste would lose its JSON schema).

## 10. Storage: two backends behind one small interface

**Decision**: `apps/api/src/storage/` with one interface: `put(key, bytes)`, `get(key)`, `delete(key)` (no error if
missing), `list()` (keys and modification times under Scrylux's prefix). Keys are generated: `sources/<uuid>`, never a
name (FR-008).

- **Local** (`STORAGE_BACKEND=local`, the default): files under `STORAGE_DIR` (default `storage`, relative to the
  working directory: `/app/apps/api/storage` in the image). A write goes to `tmp/<uuid>` and is renamed into place after
  `fsync`, so the worker never reads a partial file. The image creates the directory owned by `node`, so the named volume
  both compose services mount there starts writable. This backend needs the app and the worker on one host, or a shared
  filesystem.
- **S3-compatible** (`STORAGE_BACKEND=s3`): `@aws-sdk/client-s3` 3.x (Apache-2.0) with every setting passed explicitly:
  `STORAGE_S3_BUCKET`, `STORAGE_S3_PREFIX` (default `scrylux/`), `STORAGE_S3_REGION`, and optionally
  `STORAGE_S3_ENDPOINT` and `STORAGE_S3_FORCE_PATH_STYLE` for MinIO, Ceph, R2 and others. `ignoreConfiguredEndpointUrls:
  true`, and `requestChecksumCalculation` / `responseChecksumValidation` set to `WHEN_REQUIRED`, which S3-compatible
  services other than AWS accept. Credentials: `STORAGE_S3_ACCESS_KEY_ID` and `STORAGE_S3_SECRET_ACCESS_KEY` when set
  (from the environment or the `DB_SECRET_ID` secret, whose key list gains them), otherwise the platform's role through
  the SDK's default chain. When `s3` is selected, Scrylux refuses to start if a variable the S3 client would read on its
  own is set (`AWS_ENDPOINT_URL`, `AWS_ENDPOINT_URL_S3`, `AWS_S3_*`, `AWS_USE_DUALSTACK_ENDPOINT`,
  `AWS_USE_FIPS_ENDPOINT`), as Milestone 1 does for Bedrock. A test, like `sdk-env.test.ts`, keeps the list in step with
  the installed client.
- **A dedicated bucket or prefix, and a policy per process.** Scrylux deletes what it finds under its prefix that
  matches its key pattern (#11), and nothing else. The documentation says to give it a bucket or prefix of its own, and
  gives one IAM policy per process, each limited to `<prefix>sources/*`: the app `s3:PutObject` and `s3:DeleteObject`;
  the worker `s3:GetObject`, `s3:DeleteObject`, and `s3:ListBucket` limited to the prefix (Principle V). At rest, the
  bucket's own encryption applies (on by default on AWS); the documentation says so.
- **Tests** use an in-process S3 stub (`apps/api/test/storage/s3-stub.ts`) that answers `PutObject`, `GetObject`,
  `DeleteObject` and `ListObjectsV2` with path-style addressing, so no account or secret is needed (FR-083). Both
  backends run one shared test suite.

**Rationale**: the spec's two backends (clarified 2026-11-01), with no setting a library would read behind Scrylux's back.

**Alternatives considered**: `@aws-sdk/lib-storage` for streamed uploads (not needed with bodies of at most 10 MB);
MinIO in CI (a second service container, and a dependency for developers).

## 11. Removing originals: at once where possible, and a sweep for the rest

**Decision**:

- **At once**: the worker deletes a source's original right after the commit that makes it ready (FR-057); the API
  deletes it after the transaction that deletes the source, or the threat model (whose sources' keys it reads, under
  their locks, before deleting); the API deletes it when the add's transaction refused it.
- **The sweep**: every worker, at start and every 10 minutes, lists the storage under its prefix and deletes every key
  that matches `sources/<uuid>` (and `tmp/<uuid>` on the local backend), is older than **1 hour**, and is not the
  `original_key` of a waiting, processing or failed source. Running it from several workers at once is safe.
- So an original outlives its need by at most 1 hour 10 minutes, whatever failed (FR-055, SC-005). The hour covers an
  upload between storing its original and committing its source, which takes seconds. The documentation states the
  bound.

**Rationale**: one rule, "storage holds exactly the originals some source still needs", covers a ready source, a
deleted one, a failed removal and a crash, with no table of pending deletions to keep.

## 12. The document space

**Decision**: `sources.stored_bytes` is the source's upload size while it is not ready, and, from the commit that makes
it ready, its text's UTF-8 size plus `chunk_count × embedding_dimension × 4` (FR-009, clarified at planning). The total is
`SUM(stored_bytes)` over all sources. An install-wide advisory lock (a fixed key) serializes the two checks:

- **Add** (API): the total plus the new source's upload size must stay within `DOCUMENT_SPACE` (`507`, "The document
  space of this install is full", otherwise). A **retry** adds nothing, because a source not ready is already counted at
  its upload size, and a **refresh** grows only by a change of dimension: the API checks only that the space is not
  already full, and the commit checks the real growth.
- **Commit** (worker): the total of the ready sources, with this source's new size in place of its old one, must stay
  within `DOCUMENT_SPACE`, else the run fails as `document_space_full`, writes nothing, and can be retried later
  (FR-045).
- Default `2GB`. At 1,536 dimensions a chunk stores about 1.5 KB of text and 6 KB of embedding, so 2 GB holds about
  400 MB of text; at 3,072 dimensions about 220 MB; at 768, about 670 MB. The documentation gives these figures.

## 13. Jobs: two new kinds, their own limit, and who may queue them

**Decision** (migration `017_sources.sql`, `apps/api/src/jobs/`):

- `jobs` gains `threat_model_id` (`ON DELETE CASCADE`, M2 research's deferred column, FR-041, FR-054) and `source_id`
  (`ON DELETE SET NULL`), both required on the new kinds when queued, and an index on `(source_id, kind, queued_at DESC)`.
  The kind check gains `ingest_source` and `refresh_embeddings`; the failure categories gain this milestone's
  ([data-model.md](./data-model.md#failure-categories));
  `failure_detail` gains `time` and `memory` for `unreadable`.
- `JobKind` gains the two kinds, but `JobCreateInput`, the body of `POST /jobs`, stays the provider check alone, so that
  route refuses them with its usual `400` (FR-045a). Only the source routes queue them.
- Milestone 2's count of active jobs per account excludes the two kinds. `INGESTION_JOBS_PER_ACCOUNT` (default 20)
  counts only them, under the same account lock (FR-043). Refused: `429` with `Retry-After`.
- `apps/api/src/jobs/kinds.ts` changes `CALLS_MODEL` into what each kind **needs**: the provider check needs any
  provider, the two new kinds need an embedding provider (FR-047).
- `RunOutcome`'s transient categories gain `storage_unavailable` (FR-013, M2 FR-020).
- `JobRecord` gains `threat_model_id` and `source_id`, so the Jobs page links an ingestion job to its source.

## 14. Retrying

**Decision**: the API offers and accepts a retry (FR-045) of a failed source, or a failed refresh, unless its category
is one the document causes (`unsupported_type`, `encrypted`, `damaged`, `no_text_found`, `too_large`,
`too_large_unpacked`); or it is `cap_reached` and neither of the operator's current caps is higher than the failed job's;
or it is `input_too_large` and the configured embedding model is the one that job used (read from its last usage
record). Every other outcome may be retried, including `unreadable`, `document_space_full`, `cancelled`, `timed_out` and
`worker_lost`. Each source record carries `retryable`, so the UI and the API agree.

## 15. The database image, and migration 017 repairs text indexes

**Decision**:

- Compose files, CI and the docs move from `postgres:16-alpine` to **`pgvector/pgvector:0.8.7-pg16-trixie`**, pinned by
  digest. pgvector publishes Debian images only.
- **Collation**: Alpine's image uses musl, whose collation is plain code-point order; Debian's uses glibc's, which sorts
  `en_US.utf8` text linguistically. An existing volume moved across keeps B-tree indexes on text in the old order, and
  they silently return wrong answers. Migration 017 therefore runs `REINDEX TABLE` on every Scrylux table that exists
  before it (a constant list in the file, `schema_migrations` first), inside its transaction. It cannot run before the
  image changes, because it needs the vector extension, which the old image lacks. So every install that applies 017
  has already moved, and the reindex is a harmless few seconds for those that did not change their C library.
- The Debian image's entry point re-owns `PGDATA` for its own `postgres` user (uid 999, Alpine's is 70) when it starts as
  root, as the official image's does. Nothing queries a text index before migrations run: the app and the worker migrate
  before seeding the admin or serving.
- **Upgrade check in CI**: `scripts/check-db-upgrade.sh`, a step of the `test` job, creates a volume with the old image,
  applies migrations up to 016 and data whose text sorts differently in the two collations, checks that 017 refuses
  there with its message, moves the volume to the new image, applies 017, and runs `amcheck`'s
  `bt_index_check(index, heapallindexed => true)` on every B-tree index, failing on any error, and compares row counts
  (SC-010). **A negative control** comes first: on the new image, before 017 is applied, the same check must *fail* on
  the indexes the collation change broke, so a clean result after 017 proves the reindex repaired them and not that
  nothing was broken.

## 16. The extension check, and messages a migration may print

**Decision**: 017 begins with a `DO` block: no `vector` row in `pg_available_extensions` → `RAISE EXCEPTION` with
SQLSTATE `SX001` and a fixed message ("This database does not have the pgvector extension, which Scrylux needs from
v0.2. See docs/install.md#upgrading-to-v02"); `CREATE EXTENSION IF NOT EXISTS vector` failing with
`insufficient_privilege` → `SX002` ("… the database has pgvector, but Scrylux's database user may not enable it. Run
CREATE EXTENSION vector as an administrator, then start Scrylux again"). The migration runner and the start-up of the
app and the worker print an error's message only when its SQLSTATE is in class `SX`, which only Scrylux's own migrations
raise with fixed text; every other failure still prints only "Migration failed" (FR-091).

## 17. The UI: a Sources tab

**Decision**: the threat model page gains a **Sources** tab (`/threat-models/:id/sources`) beside Threats and Diagram:
the notice, the add form (choose files, or paste a title and text), the list, and a source's page with its chunks, a page
of 50 at a time. It refetches every 2 s while a source on screen is waiting, processing or refreshing, and stops when
none is (FR-063). The notice and "no worker" use `GET /jobs/status`, which already reports each operation's provider and
whether it is hosted, and whether a worker is alive. Every name, text and chunk is a React text node (FR-066). The Jobs
page shows the new kinds with a link to their source.

## 18. The threat model update: constitution 1.16.0

**Decision**: a MINOR amendment (1.15.0 → 1.16.0) with its Sync Impact Report, and `docs/threat-model/` rebuilt by its
procedure (FR-080):

- **Assets, current**: sources, originals (on a local volume or in an S3-compatible bucket), chunks, embeddings; the
  S3 credentials, held by the app and the worker.
- **Processes**: the extraction child, holding no secret and reading untrusted files.
- **Entry points**: the eight source routes (list, upload, paste, read, chunks, retry, refresh, delete).
- **Boundaries**: the inbound one for untrusted document content becomes current; the outbound provider boundary now
  carries user content (chunks for embedding), and the disclosure item moves from "accepted for this milestone" to
  mitigated by the notice; storage, when S3, is a new outbound boundary.
- **Risks and handling**: a malicious file (#3–#5); confidential data that outlives its deletion or its need (#11);
  runaway embedding spend (caps, the ingestion limit, open until Phase 6); storage exhaustion (#12, one account can fill
  the space for all until Phase 6); prompt injection stored for later (untrusted, delimited by Milestone 4); a shared
  bucket (dedicated prefix, key pattern); the child's network egress (accepted, the operator's).

## 19. Dependencies, licences and the eval gate

**Decision**: new runtime dependencies of `apps/api`: `pdfjs-dist` (Apache-2.0), `busboy` (MIT), `yauzl` (MIT), `saxes`
(ISC), `@aws-sdk/client-s3` (Apache-2.0); dev: `@types/busboy`, `@types/yauzl`. `docs/install.md`'s licences section
says the image carries each dependency's licence in its `node_modules` folder. **The eval gate** (Principle II) does not
apply: this milestone adds no prompt and no generation, and the eval harness arrives in Milestone 7. The PR says so.

## 20. Testing

**Decision**:

- **Fixtures** are small committed files built by a script in `apps/api/test/fixtures/sources/` (a PDF with known text on
  known pages, one encrypted, one scanned, one with 2,001 pages, a `.docx` with headings and a table, a `.docm`, a
  `.docx` whose parts inflate past the limit, a damaged one, Markdown with CRLF and a BOM, non-UTF-8 text), plus one
  generated at test time at the largest default size (SC-002).
- **The worker** runs in-process against Milestone 1's `startStub` for embeddings and the S3 stub, with the real child
  process for extraction.
- **One Playwright spec** starts its own API, worker and stub provider (as Milestone 2's does), uploads a file, watches it
  become ready, opens its chunks, checks the notice, and deletes it. The rest of the browser suite runs unchanged (SC-001).
- **The canary** (SC-008) extends Milestone 2's: a fake document text, file name and key run through every outcome and
  are searched for in logs, job and usage rows and error answers.
