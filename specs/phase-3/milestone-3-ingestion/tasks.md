---

description: "Task list for Ingestion (Phase 3 / Milestone 3)"
---

# Tasks: Ingestion

**Input**: Design documents from `/specs/phase-3/milestone-3-ingestion/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/http-api.md, contracts/configuration.md,
contracts/storage.md, contracts/worker.md, contracts/data-files.md, contracts/ui.md, quickstart.md

**Tests**: Required. Constitution Principle II requires a failing test before each new behaviour, and the spec's Success
Criteria SC-001 to SC-013 are checked by tests (quickstart §1). In every phase the test tasks come first and **MUST be
run and seen failing** before the implementation tasks that follow them. Three tasks are **guard tests** and are exempt:
T040 (import graphs), T088 (the canary) and T063 (the browser flow). Each checks, across several modules, behaviour that
earlier test-first tasks already built, so it is written after that code and must pass when written.

**Organization**: by user story, in the spec's priority order: US1 → US2 → US3 → US4 (P1), then US5 → US6 → US7 → US8
(P2). Pulled into Foundational because every story needs them: the dependencies and database image (Setup), migration
017 and its types, the shared schemas, the storage abstraction, the settings, the failure messages and the `SX`
migration messages.

**Scope guard**:

- The only new dependencies are `pdfjs-dist`, `yauzl`, `saxes`, `busboy`, `@aws-sdk/client-s3`, `@types/busboy` and
  `@types/yauzl` (research #19). `@napi-rs/canvas` must not be installed.
- No task adds a vector index, a similarity query, context selection, OCR, re-extraction of a ready source, a download
  of originals, sources in exports or reports, a project-wide document library, an ingestion cooldown or a parsing
  service (plan.md, Constitution Check III).
- No task changes a prompt, a provider adapter or the price list.
- If a task seems to need one, stop and ask.

**Git**: no task commits, pushes, tags or opens a pull request. The maintainer does that. Undo a test's temporary
change to a tracked file with `git restore --source=HEAD -- <file>`, never `git checkout --`.

**Paths**: relative to the repository root. `API` means `apps/api`, `WEB` means `apps/web`, `DB` means `packages/db`,
`CORE` means `packages/core`, `SPEC` means `specs/phase-3/milestone-3-ingestion`.

**SQL**: every statement is parameterized (`pg` placeholders, Kysely or `sql` templates), never string-built
(Principle I). The only identifiers built into SQL are the constant table names of migration 017's reindex. Every time
is the database's `now()`.

**Lock order** (research #2), everywhere: the source row(s) `FOR UPDATE ORDER BY id`, then Milestone 2's account lock,
then the document-space lock, then job rows.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story the task belongs to (US1–US8)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: the dependencies, a database with pgvector for every test, the test groups and the fixture builders.

- [X] T001 Add the dependencies of research #19 to `API/package.json`: `pdfjs-dist@6.4.299`, `yauzl@3.4.0`,
  `saxes@6.0.0`, `busboy@1.6.0`, `@aws-sdk/client-s3@^3.1161.0` (raise `@aws-sdk/client-secrets-manager` to the same
  `^3.1161.0` if the lockfile otherwise resolves two `@smithy` trees); dev `@types/busboy@1.5.5`, `@types/yauzl@3.4.0`. Add `ignoredOptionalDependencies:
  ['@napi-rs/canvas']` to `pnpm-workspace.yaml` beside `allowBuilds`, with a comment (research #4). Raise `engines.node`
  to `>=22.13` in `package.json` and `API/package.json`. Run `pnpm install`, then check that `pnpm-lock.yaml` has no
  `@napi-rs/canvas` entry and that `pnpm --filter=@scrylux/api deploy --prod /tmp/x` leaves it out; check that the
  licence check in `pnpm lint` accepts Apache-2.0, MIT and ISC; check that the `node:22-alpine` digest pinned in
  `Dockerfile` is Node ≥ 22.13 (`docker run --rm <image> node -v`), and if not, stop and ask.
- [X] T002 Move the development and CI database to pgvector: in `docker-compose.yml` set the `db` image to
  `pgvector/pgvector:0.8.7-pg16-trixie`; in `.github/workflows/ci.yml` set the `postgres` service image to the same tag
  pinned by digest (resolve it with `docker buildx imagetools inspect pgvector/pgvector:0.8.7-pg16-trixie`), with a
  comment naming research #15. Recreate the local `db` container and volume (`docker compose down -v db` only after
  saying so to the maintainer: it drops local dev data) or migrate it as in quickstart §5.
- [X] T003 In `API/vitest.config.ts`, add `'test/contract/v1/sources*.test.ts'`, `'test/sources/store*.test.ts'` and
  `'test/sources/ingest*.test.ts'` to `JOBS` (they queue jobs a worker may claim), and extend the comment. Each such file
  starts with `TRUNCATE jobs, job_usage, workers, sources CASCADE`. In `API/test/env.setup.ts`, set `STORAGE_DIR` to a
  fresh temporary directory per test process, so no test writes into the working tree. Add `apps/api/storage/` to
  `.gitignore` and `.dockerignore`, with a comment: a development run's originals are confidential documents.
- [X] T004 [P] Add test fixture builders in `API/test/fixtures/sources/`: `zip.ts`, a minimal ZIP writer (stored and
  deflated entries, `zlib.crc32`, an option to declare a smaller uncompressed size than the real one) that builds
  `.docx`, `.docm` and bomb archives at test time; `pdf.ts`, a minimal PDF writer (uncompressed content streams,
  Helvetica `Tj` text per page, pages with no text, a NUL in a text string, any page count, computed `xref`); and one
  password-protected PDF written by `pdf({ userPassword })` (the standard security handler, RC4-40, checked against
  `pdfjs-dist`), with `README.md` saying how the fixtures are made. No binary is committed: `qpdf` is not a project
  dependency, so the encrypted file is built at test time too.
- [X] T005 Baseline: with the pgvector database, `pnpm run test` is green before any other change.

**Checkpoint**: the dependencies install without native canvas code; every test database has pgvector.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: migration 017, the records, storage, settings, failure messages, and migration messages a person can act
on.

### Tests for Foundational

- [X] T006 [P] `DB/test/sources-schema.test.ts`: after migrations, the tables and checks of `SPEC/data-model.md`,
  quoting each rule as its test name: `name` "1–255 characters after trimming"; `type` "`md`, `txt`, `pdf`, `docx`,
  `text`"; `size_bytes` "> 0"; `digest` "SHA-256 … 32 bytes; `UNIQUE (threat_model_id, digest)`"; "`ready_at IS NULL` ⇔
  `text_chars`, `chunk_count`, `embedding_model`, `embedding_dimension` all `NULL`"; "`ready_at IS NOT NULL` ⇒
  `original_key IS NULL`" and "`ready_at IS NULL` ⇒ `original_key IS NOT NULL`"; "`pages_without_text IS NOT NULL` ⇒
  `type = 'pdf' AND ready_at IS NOT NULL`"; `embedding_dimension` "1–16,000"; chunks "`0 ≤ start < end`, `end − start ≤
  2000`", "`char_length(text) = end_offset − start_offset`" (with an astral character), pages and lines "both or
  neither; `1 ≤ first ≤ last`", `heading` "≤ 200 characters", `UNIQUE (source_id, position)`, `embedding` accepts vectors
  of dimensions 3 and 3,072 in one table; `jobs` accepts the two new kinds, "`kind = 'provider_check'` ⇔
  `threat_model_id IS NULL`", the new categories, `unreadable` with `time`/`memory` and `too_large` with `pages`/`chars`
  only; cascades: deleting a threat model removes its sources, chunks, jobs and usage; deleting a source sets its jobs'
  `source_id` to null; `added_by` is `RESTRICT`. Extends `DB/test/jobs-schema.test.ts` where it already covers `jobs`.
- [X] T007 [P] `DB/test/sources-extension.test.ts`: in a scratch database where `vector` is not yet created, run the
  migrations as a role without the right to create it, and check they stop with SQLSTATE `SX002` and research #16's
  text, and that no table of 017 exists afterwards (the file's transaction rolled back). Check that `migrate()`'s error
  for `SX001`/`SX002` carries the fixed message and that any other failure still carries none (FR-091).
- [X] T008 [P] `CORE/test/source.test.ts`: `SourceFileName` (accepts 1 and 255 characters after trimming and each
  supported extension in any case; refuses empty, whitespace only, 256 characters, a control character, no extension,
  `.doc`, `.docm`, and its message never holds the name), `SourceRecord`, `SourceList`, `ChunkRecord`, `ChunkPage`, `ChunkPageQuery`
  ("`offset` ≥ 0, `limit` 1–100, default 50"), `SourceTextInput` ("`title`: 1–200, trimmed; `text`: ≥ 1 non-space
  character", strict), and the `job.ts` additions; `JobCreateInput` still accepts only `{ kind: 'provider_check' }` (FR-045a).
- [X] T009 [P] `API/test/storage/storage.test.ts`, one suite run against both backends: the local one in a temporary
  directory, the S3 one against `API/test/storage/s3-stub.ts`, an in-process stub (path-style `PutObject`, `GetObject`,
  `DeleteObject`, `ListObjectsV2`) written in this task. Put/get round trip; delete of a missing key succeeds; `list()`
  returns only keys matching the `OriginalKey` pattern and ignores others under the prefix; a key that is not an
  `OriginalKey` cannot be made from a string; the local backend never leaves a partial file at a key (write to `tmp/`,
  rename); `StorageUnavailable` messages hold no path, bucket, key or address.
- [X] T010 [P] `API/test/storage/config.test.ts`: every row of `SPEC/contracts/configuration.md`'s storage table,
  refused when missing or malformed with a message that names the variable and not its value; both or neither keys;
  with `s3`, refusal while `AWS_ENDPOINT_URL`, an `AWS_ENDPOINT_URL_*`, an `AWS_S3_*`, `AWS_USE_DUALSTACK_ENDPOINT` or
  `AWS_USE_FIPS_ENDPOINT` is set; and, like `packages/llm/test/sdk-env.test.ts`, a test that reads the installed
  `@aws-sdk/client-s3` and its `@aws-sdk`/`@smithy` dependencies for the environment variables they read and fails if
  one is neither refused nor in `AWS_EXEMPT_VARIABLES` (research #10).
- [X] T011 [P] `API/test/sources/config.test.ts`: every row of the sources and extraction tables of
  `SPEC/contracts/configuration.md` with its default and bounds; `DOCUMENT_SPACE` parses `MB`/`GB`; zero, negative or
  malformed values refused, naming the variable (FR-009, FR-043, FR-052).
- [X] T012 [P] Extend `API/test/jobs/failures.test.ts`: every category of `SPEC/data-model.md#failure-categories` has a
  message and hint; `details` for `unreadable.time`, `unreadable.memory`, `too_large.pages`, `too_large.chars`; `kinds`
  for `ingest_source.input_too_large` and `refresh_embeddings.input_too_large`; `sources.cancelled`; an unknown category,
  kind or detail in the file is refused at load; no message names a path or holds `{`-placeholders other than those the
  loader fills.
- [X] T013 [P] Extend `API/test/config.test.ts`: `STORAGE_S3_ACCESS_KEY_ID` and `STORAGE_S3_SECRET_ACCESS_KEY` are read
  from the `DB_SECRET_ID` secret and override the environment, as `LLM_API_KEY` is.

### Implementation for Foundational

- [X] T014 Write `DB/migrations/017_sources.sql` in `SPEC/data-model.md`'s order, with a header comment like 016's:
  (1) the `DO` block of research #16 raising `SX001` and `SX002` with their exact texts; (2) `REINDEX TABLE` on every
  table that exists after 016, as a constant list with `schema_migrations` first (list them from `\dt` at 016, in a
  comment naming research #15); (3) `sources` and `chunks` with every column, check, unique constraint, FK and index of
  the data model, constraint names in the 016 style; (4) the `jobs` changes, replacing `jobs_kind_check`,
  `jobs_failure_category_check` and `jobs_failure_detail_check` and adding the new columns, check and index. Make
  T006 and T007 pass.
- [X] T015 Add `SourcesTable`, `ChunksTable` and the new `JobsTable` columns to `DB/src/schema.ts`. The `embedding`
  column is typed as `string` (pgvector's text form, `'[1,2,3]'`); a comment says it is always written as a bound
  parameter.
- [X] T016 Add `CORE/src/schemas/source.ts` with the records of `SPEC/data-model.md#records-in-scryluxcore-schemassourcets`,
  export it from `CORE/src/index.ts`, and change `CORE/src/schemas/job.ts`: `JOB_KINDS` gains `ingest_source`,
  `refresh_embeddings`; `JobProgress.step` gains `extract`, `chunk`, `embed`; `JOB_FAILURE_CATEGORIES` gains
  `unsupported_type`, `encrypted`, `damaged`, `no_text_found`, `too_large`, `too_large_unpacked`, `unreadable`,
  `storage_unavailable`, `document_space_full`; `JobRecord` gains `threat_model_id` and `source_id` (nullable UUIDs);
  `JobCreateInput` unchanged. `source.ts` also exports `SourceFileName`, the boundary schema of an upload's file name
  (Principle I): "1–255 characters after trimming" (`sources.name`, `SPEC/data-model.md`), no control character, and an
  extension, compared without case, of `.md`, `.txt`, `.pdf` or `.docx`; its error message is fixed text that does not
  repeat the name. Make T008 pass.
- [X] T017 Write `API/src/storage/index.ts` (`Storage`, `OriginalKey`, `newOriginalKey()`, `parseOriginalKey()`,
  `StorageUnavailable`, `createStorage(config)`), `local.ts` and `s3.ts` per `SPEC/contracts/storage.md` and research #10
  (the S3 client built with explicit region, endpoint, `forcePathStyle`, credentials when given,
  `ignoreConfiguredEndpointUrls: true`, `requestChecksumCalculation` and `responseChecksumValidation` `'WHEN_REQUIRED'`).
  Make T009 pass.
- [X] T018 Write `API/src/storage/config.ts` (`parseStorageConfig(env)`) with the AWS variable guard. Make T010 pass.
- [X] T019 Write `API/src/sources/config.ts` (`parseSourceConfig(env)`) for the sources and extraction variables. Make
  T011 pass.
- [X] T020 Extend `API/data/failures.yaml` and `API/src/jobs/failures.ts` per `SPEC/contracts/data-files.md`
  (`details`, `kinds`, `sources.cancelled`; texts from `SPEC/contracts/http-api.md` and data-files.md). Make T012 pass.
- [X] T021 Print `SX`-class migration messages: in `DB/src/migrate.ts` keep an error's message only when its SQLSTATE
  starts with `SX`; in `API/src/migrate.ts`, `API/src/server.ts` and `API/src/worker.ts` print that message instead of
  the generic "Migration failed"/"Startup failed" line, and nothing else from the error (research #16).
- [X] T022 Add `STORAGE_S3_ACCESS_KEY_ID` and `STORAGE_S3_SECRET_ACCESS_KEY` to `API/src/config.ts`'s secret keys and its
  comment's key list. Make T013 pass.
- [X] T023 (as built, the storage is chosen once per process with `useStorage()` and read with `storage()`, as the database pool is, not passed to `createApp`) Wire settings and storage into both processes: `API/src/server.ts` and `API/src/worker.ts` call
  `parseSourceConfig` and `parseStorageConfig` at start, refusing to start with the variable's name as for the job
  settings, and create the `Storage` they pass on (to `createApp` and the worker's deps). `createApp`'s new `storage`
  option is optional and defaults to a local backend on `STORAGE_DIR`, so every existing contract helper keeps working
  unchanged. Neither process contacts storage at start.

**Checkpoint**: migration 017 applies; records, storage, settings and messages exist; the suite is green.

---

## Phase 3: User Story 1 - Add a design document to a threat model (Priority: P1) 🎯 MVP

**Goal**: upload a file or paste text; it is checked, stored, ingested by the worker into chunks with embeddings, and
shown as ready on the Sources tab without a reload.

**Independent Test**: the spec's US1 Independent Test.

### Tests for User Story 1

- [X] T024 [P] [US1] `API/test/sources/sniff.test.ts`: `%PDF-` within the first 1,024 bytes; ZIP signature at 0 for
  `.docx`; `D0 CF 11 E0` under `.docx` refused with the encrypted-or-`.doc` text; `.doc` and unknown extensions refused;
  a type that disagrees with its extension refused; text types valid UTF-8 with no NUL; empty input refused (FR-003).
- [X] T025 [P] [US1] `API/test/sources/text.test.ts`: BOM removed; CRLF, CR and LF each become one LF and line numbers
  match the input's; NUL removed; a lone surrogate becomes U+FFFD; lengths counted in code points (an emoji counts 1);
  Markdown ATX and setext headings found, not inside fenced code (research #6).
- [X] T026 [P] [US1] `API/test/sources/chunk.test.ts`: every chunk ≤ 2,000 code points and never whitespace only;
  consecutive offsets from 0 to the text's length; concatenation equals the text exactly (SC-003); boundaries prefer
  page break, heading, blank line, line end, sentence end, space, in that order; a 5,000-character run without spaces is
  cut at 2,000 code points; pages (PDF blocks), lines (text) and the nearest heading (≤ 200) per chunk (FR-020–FR-022).
- [X] T027 [P] [US1] `API/test/extract/read.test.ts`, through the real child (`extract/run.ts`): a 3-page PDF from
  `fixtures/sources/pdf.ts` gives one block per page with its text and page number; a `.docx` from `zip.ts` with two
  headings, a table and a line break gives its text in order, table cells tab-separated, and headings found by the style
  names in `styles.xml`; `pages_without_text` counted. The isolation, as behaviour: a test child
  (`API/test/extract/children/env.ts`, never built) started through `run.ts`'s injectable entry, with the test
  process's environment holding a fake `DB_PASSWORD` and `LLM_API_KEY`, reports that `Object.keys(process.env)` is
  empty; a test child that writes a canary to stdout and stderr leaves no trace in the worker's output.
- [X] T028 [P] [US1] `API/test/sources/store.test.ts`: `addSource` under the lock order: refuses a duplicate digest
  (naming the existing source), the 21st source, a document space that would be passed, the 21st active ingestion job
  of an account, and an unconfigured embedding provider; Milestone 2's limit of 3 does not count ingestion jobs and
  ingestion's limit does not count provider checks (FR-043); on success the source row and its job (`threat_model_id`,
  `source_id`, input `{ source_id }` only) exist together; two adds of the same bytes at once give one source and one
  `409`; the derived status of `SPEC/data-model.md` for each job state.
- [X] T029 [P] [US1] Extend `API/test/jobs/store.test.ts` for `finishRun` with a commit: the commit's `lock` runs before
  the fenced update and `write` only when the update returned `succeeded`; a cancel asked turns it into `cancelled` and
  nothing is written; a lost claim writes nothing; a `check` failure ends the job as `failed` with that category and
  writes nothing.
- [X] T030 [P] [US1] `API/test/sources/ingest.test.ts`, the worker in-process against `startStub` and the S3 stub:
  progress `extract` → `chunk` → `embed` with done/total; 64 chunks per request; each chunk written once with its
  embedding, the source ready with `text_chars`, `chunk_count`, `embedding_model` equal to the configured
  `EMBEDDING_MODEL`, `embedding_dimension`, `stored_bytes` (text bytes + chunks × dimension × 4); the original removed
  from storage after the commit (FR-057); a 10 MB PDF with 1,000,000 characters becomes ready under the default caps
  within 5 minutes (SC-002, timed, against the stub answering at once, with an explicit test timeout of 300,000 ms); a stub that returns two dimensions, or a NaN,
  fails as `rejected` with no chunk written; a commit that would pass `DOCUMENT_SPACE` fails as `document_space_full`
  with no chunk written; a lost run followed by a second run writes each chunk once (SC-006).
- [X] T031 [P] [US1] `API/test/contract/v1/sources.test.ts`: `GET` list and `POST` upload and paste with every status
  of `SPEC/contracts/http-api.md` except those of retry, refresh, chunks and delete: `400` (no file part, extra part,
  empty, not UTF-8, a file name of 256 characters, one with a control character, one without a supported extension:
  none stored and none answering `500`), `409` (embeddings off, with generation configured and with nothing configured;
  duplicate; count), `413` from `Content-Length` and from the stream, `415`,
  `429` with `Retry-After`, `503` with `Retry-After: 5` when 4 uploads are held open, for an upload and for a paste;
  `507`; the `409` for embeddings off and the `404` for an unknown threat model answered without reading the body (a
  body that never ends still gets them); nothing in storage after any refusal; a non-ASCII file name kept; `POST /jobs` with `ingest_source` or `refresh_embeddings` → `400` (SC-012);
  `GET /jobs` rows carry `threat_model_id` and `source_id`; one write-log line per add with no name; the OpenAPI
  document (`openapi.test.ts`) describes the upload as `multipart/form-data` with a binary `file`, and no source
  operation answers with any media type but `application/json` (or no body), so no route returns an original (FR-068).
- [X] T032 [P] [US1] `WEB/src/pages/SourcesTab.test.tsx`: the list with name, type, size, adder, time and status;
  several files chosen are sent one at a time in order, each with its own result; a file over the limit refused in the
  browser; the server's `{ error }` text shown for `409`, `503` and `507`; refetching every 2 s only while a source is
  waiting or processing; no form and the embedding-provider text when embeddings are off, including when generation is
  configured (FR-030); "No worker is processing
  documents" when a source waits and no worker is alive; names rendered as text.
- [X] T033 [P] [US1] `WEB/src/pages/JobsPage.test.tsx` and `JobPage.test.tsx`: the new kinds' labels ("Process a
  document", "Refresh embeddings"); a link to the source when `source_id` is set, "The document was deleted" otherwise.

### Implementation for User Story 1

- [X] T034 [P] [US1] Write `API/src/sources/sniff.ts`. Make T024 pass.
- [X] T035 [P] [US1] Write `API/src/sources/text.ts` (normalization, line map, Markdown headings, code-point helpers).
  Make T025 pass.
- [X] T036 [US1] Write `API/src/sources/chunk.ts` on `text.ts`. Make T026 pass.
- [X] T037 [P] [US1] Write `API/src/extract/pdf.ts` with the `getDocument` options of research #4 exactly (CMaps and
  standard fonts as local paths resolved from the installed package).
- [X] T038 [P] [US1] Write `API/src/extract/docx.ts`: `yauzl.fromBuffer` with `validateEntrySizes: true`, only the three
  parts of research #5, `saxes` parsing, text, tables and headings as research #5 says. Bounds and failure categories
  come in T068.
- [X] T039 [US1] Write `API/src/extract/child.ts` (reads one IPC message, calls `pdf.ts` or `docx.ts`, answers, exits)
  and `API/src/extract/run.ts` (`fork` with `env: {}`, `stdio: ['ignore','ignore','ignore','ipc']`, `serialization:
  'advanced'`, `--max-old-space-size` at ¾ of `EXTRACT_MEMORY_MB`, `--import tsx` when the entry ends in `.ts`;
  `SIGKILL` on `EXTRACT_TIME_LIMIT` and on the run's abort signal). The child's entry is an option of `run.ts`
  (`entry?: URL`), defaulting to the shipped `child.js`/`child.ts` beside it, so the tests can start the children under
  `API/test/extract/children/`; the worker never passes it. Add `src/extract/child.ts` to the API build so it emits
  `dist/extract/child.js`. Make T027 pass.
- [X] T040 [US1] Guard test: extend `API/test/worker/imports.test.ts` so that `server.ts`'s import graph holds no
  `extract/` module and none of `pdfjs-dist`, `yauzl`, `saxes`, and `extract/child.ts`'s graph holds no config,
  database, storage, `@scrylux/llm` or logging module (FR-010). Written now that T039 exists; it must pass when written.
- [X] T041 [US1] In `API/src/jobs/kinds.ts` replace `CALLS_MODEL` with `NEEDS: Record<JobKind, 'any' | 'embedding'>`
  and update `v1/jobs.ts`; in `API/src/jobs/store.ts` add `enqueueIngestion(trx, …)` (counts only the two new kinds
  against `INGESTION_JOBS_PER_ACCOUNT`, sets `threat_model_id` and `source_id`), make `enqueue`'s count exclude them, and
  add the two fields to `JobRecord` reads.
- [X] T042 [US1] Add `KindOutcome.commit` (`lock`, `check`, `write`) in `API/src/worker/kinds.ts`, pass it from
  `API/src/worker/run.ts`, and run it inside a transaction in `finishRun` (`API/src/jobs/store.ts`) in research #2's
  order. Make T029 pass.
- [X] T043 [US1] Write `API/src/worker/ingest.ts` (`ingest_source`, steps of `SPEC/contracts/worker.md`) and register it
  in `API/src/worker/kinds.ts`; it reads the original through the worker's `Storage`, writes chunks in batches of 500
  in its commit, and deletes the original after the commit. Make T030 pass.
- [X] T044 [US1] Write `API/src/sources/store.ts`: `addSource` (research #9's transaction with the lock order and the
  checks), `listSources`, `getSource` with the derived status, `failure` and `retryable`, `documentSpace`. Make T028 pass.
- [X] T045 [US1] Write `API/src/sources/upload.ts`: a per-process limiter of 4 bodies being read, as middleware that
  answers `503` with `Retry-After: 5` before any body is read and releases its slot when the response ends; and the
  multipart reader (busboy with research #9's limits and `defParamCharset: 'utf8'`). In `API/src/v1/operation.ts` add
  the `upload` form and an operation option `deferBody: true`: for such an operation the router does not read the body
  before the handler, and the handler gets `readBody()` (multipart for `upload`, JSON with the operation's `bodyLimit`
  and schema for `body`), which it calls after its own checks. In `API/src/v1/router.ts` mount the limiter before the
  reader on every operation marked `limitConcurrentBodies: true`; in `API/src/v1/openapi.ts` describe `upload` as
  `multipart/form-data` with a binary `file`.
- [X] T046 [US1] Write `API/src/v1/sources.ts` with list, upload and paste, both adds with `deferBody` and
  `limitConcurrentBodies`, so the threat model's existence and the `409` for embeddings off are answered before the body
  is read (research #9's order). The upload validates the part's file name with `CORE`'s `SourceFileName` before
  anything else of the part is used, answering `400` with the schema's fixed message (Principle I); register it, regenerate `API/openapi.json`, and add the write-log line of
  `SPEC/contracts/http-api.md` in `API/src/v1/write-log.ts`. Make T031 pass.
- [X] T047 [US1] Add the source queries and mutations to `WEB/src/api/queries.ts` (list with `refetchInterval` 2,000 ms
  while any source is waiting or processing, upload as `FormData`, paste), and check that the request helper surfaces
  the server's `{ error }` for `503` and `507`.
- [X] T048 [US1] Write `WEB/src/pages/SourcesTab.tsx` (add form, list, no-worker notice) per `SPEC/contracts/ui.md`,
  add the **Sources** tab to `WEB/src/pages/ThreatModelPage.tsx` and the route `/threat-models/:id/sources` to
  `WEB/src/App.tsx`. Make T032 pass.
- [X] T049 [US1] Label the new kinds and link a job to its source in `WEB/src/components/job-format.ts`,
  `WEB/src/pages/JobsPage.tsx` and `WEB/src/pages/JobPage.tsx`. Make T033 pass.

**Checkpoint**: a document added on the Sources tab becomes ready with its chunks and embeddings.

---

## Phase 4: User Story 2 - Know before uploading that data leaves the install (Priority: P1)

**Goal**: the notice of FR-070 to FR-072 on the add form and the list.

**Independent Test**: the spec's US2 Independent Test.

- [X] T050 [P] [US2] `WEB/src/components/SourcesNotice.test.tsx`: for hosted embeddings, the text naming the provider and
  that the text leaves the install; for hosted generation, the later-features sentence; for only local providers, the
  stays-in-the-install text; the notice comes before the submit control in document order, inside the form, and again
  above the list while a hosted provider is configured (`SPEC/contracts/ui.md` §1).
- [X] T051 [US2] Write `WEB/src/components/SourcesNotice.tsx` from `GET /jobs/status` and place it in
  `WEB/src/pages/SourcesTab.tsx` as the contract says. Make T050 pass.

**Checkpoint**: no one can submit a document without having had the notice on screen.

---

## Phase 5: User Story 3 - Review what Scrylux read from a document (Priority: P1)

**Goal**: a ready source's chunks, in order, with their pages, lines and headings, shown as text.

**Independent Test**: the spec's US3 Independent Test.

- [X] T052 [P] [US3] `API/test/contract/v1/sources-chunks.test.ts`: `GET /sources/{id}` and `GET /sources/{id}/chunks`
  page by `offset` and `limit` (1–100, default 50) in position order with `has_more`; `409` "This source is not ready
  yet." while waiting, processing or failed (FR-024); the same ids and text on two reads (FR-023); `404` for an unknown
  id.
- [X] T053 [P] [US3] `WEB/src/pages/SourcePage.test.tsx`: facts, pages without text, embedding state; chunks with
  position, pages or lines and heading; "Show more" loads the next 50; text with `<script>`, HTML and Markdown rendered as
  text with its line breaks (FR-066).
- [X] T054 [US3] Add `getChunks` to `API/src/sources/store.ts` and the two `GET` operations to `API/src/v1/sources.ts`;
  regenerate `API/openapi.json`. Make T052 pass.
- [X] T055 [US3] Write `WEB/src/pages/SourcePage.tsx` and its route `/threat-models/:id/sources/:sourceId` in
  `WEB/src/App.tsx`, linked from each ready source on the tab. Make T053 pass.

**Checkpoint**: a reviewer can read exactly what each chunk holds and where it came from.

---

## Phase 6: User Story 4 - Remove a document (Priority: P1)

**Goal**: deleting a source, a threat model or a project removes originals, text, chunks and embeddings, and stops any
ingestion; the sweep removes what was missed.

**Independent Test**: the spec's US4 Independent Test.

- [X] T056 [P] [US4] `API/test/contract/v1/sources-delete.test.ts`: `DELETE /sources/{id}` → `204`; its chunks gone, its
  queued job `cancelled`, its running job `cancel_requested`, its original removed; deleting a threat model and a project
  whose threat models have sources removes every original; a storage stub that fails on delete leaves the deletion
  successful and the original for the sweep; one write-log line per delete.
- [X] T057 [P] [US4] `API/test/storage/sweep.test.ts`, on both backends: deletes keys older than 1 hour that no waiting,
  processing or failed source needs, keeps a needed key and a key younger than an hour, never touches keys outside the
  `OriginalKey` pattern, removes stale `tmp/` files on the local backend, is safe when two run at once, and logs one
  line of counts only (FR-055, SC-005).
- [X] T058 [P] [US4] `API/test/sources/ingest-delete.test.ts`: a source deleted while its job embeds ends the job
  `cancelled` with no chunk written; a delete and a commit started together, many times over, never deadlock and leave
  either a deleted source or a ready-then-deleted one with no chunks and no original (research #2).
- [X] T059 [US4] Add `deleteSource` to `API/src/sources/store.ts` (lock the source, cancel its jobs with Milestone 2's
  cancel, delete, then remove the original) and the `DELETE` operation to `API/src/v1/sources.ts`; regenerate
  `API/openapi.json`. Make T056's source cases pass.
- [X] T060 [US4] In `API/src/v1/threat-models.ts` and `API/src/v1/projects.ts`, delete inside a transaction that first
  locks the sources reached `FOR UPDATE ORDER BY id` and collects their `original_key`s, then removes those originals
  after the commit. Make T056 pass.
- [X] T061 [US4] Write `API/src/storage/sweep.ts` and run it from `API/src/worker/loop.ts` at start and every 10 minutes
  (an interval in `worker/timing.ts`, shortened in tests). Make T057 and T058 pass.
- [X] T062 [US4] Add **Delete** with `ConfirmDialog` to `WEB/src/pages/SourcesTab.tsx` and `SourcePage.tsx`, with a test
  in `SourcesTab.test.tsx`.
- [X] T063 [US4] Guard test: `WEB/e2e/sources.spec.ts` starts its own API, worker and stub embedding provider (as
  `jobs.spec.ts` does), sharing a temporary `STORAGE_DIR`, with the embedding provider declared hosted: checks the notice is on screen before the submit
  control (SC-009), uploads a Markdown file, sees it become ready without a reload, opens its chunks, deletes it, and
  sees it gone. The rest of `pnpm test:e2e` runs with no worker and no provider (SC-001).

**Checkpoint**: US1–US4 together are the MVP: add, be told where text goes, review, remove.

---

## Phase 7: User Story 5 - Ingestion fails cleanly and can be retried (Priority: P2)

**Goal**: every unreadable file fails with its own category within the bounds; retry where retrying can help.

**Independent Test**: the spec's US5 Independent Test.

- [X] T064 [P] [US5] `API/test/extract/failures.test.ts`, through the real child: `encrypted.pdf` → `encrypted`; a PDF
  with no text → an answer with no blocks and every page counted as without text (as built, the worker decides `no_text_found`,
  `ingest-failures`/`ingest.test.ts` cover it); 2,001 pages with `EXTRACT_MAX_PAGES` default → `too_large`/`pages`; truncated bytes →
  `damaged`; a `.docm` → `unsupported_type`; a `.docx` without its main part → `damaged`; a part with `<!DOCTYPE` →
  `damaged`; a part whose real size passes its declared size, and parts whose declared sizes pass `EXTRACT_UNPACKED_MB`,
  → `too_large_unpacked`; a test child entry that loops forever → `unreadable`/`time` within the limit; one that grows its
  memory past the check → `unreadable`/`memory` (exit 3); one that exhausts its heap → `unreadable`/`memory` (SIGABRT);
  one killed from outside with `SIGKILL` → `unreadable`/`memory`; in each case the worker's other job still finishes
  (FR-011, SC-004). Test child entries live under `API/test/extract/children/` and are never built. And FR-012, with a
  local HTTP server listening during each read: a PDF with a JavaScript `OpenAction`, a `URI` link action and a font
  referenced by URL, and a `.docx` whose relationships include an external `TargetMode="External"` image and hyperlink
  pointing at that server, each still give their text, and the server receives no request.
- [X] T065 [P] [US5] `API/test/sources/ingest-failures.test.ts`: an original that cannot be read →
  `storage_unavailable`, run again, then ready once storage answers; an embedding stub unavailable on every attempt →
  `provider_unavailable` after the runs, no chunks, then a retry becomes ready with each chunk once; text past
  `SOURCE_MAX_CHARS` → `too_large`/`chars`; a stub refusing a chunk as too large → `input_too_large` with the
  `kinds.ingest_source` hint; cancelling the job through `POST /jobs/{id}/cancel` leaves the source failed with category
  `cancelled` and retryable (FR-044); with a `JOB_TOKEN_CAP` smaller than the source needs, the job fails as
  `cap_reached`, writes no chunk, the stub receives no embedding request after the one whose worst case would pass the
  cap, every request it did receive was preceded by the gate, and the job's usage records stay stored (FR-042).
- [X] T066 [P] [US5] `API/test/contract/v1/sources-retry.test.ts`: `POST /sources/{id}/retry` queues a job with the
  current caps for each retryable outcome of research #14 and refuses with its `409` text for the document's categories,
  for `cap_reached` until a cap is raised, for `input_too_large` until the model changes, for a source that is ready or
  active, and with embeddings off; two retries at once queue one job; the duplicate refusal of a failed source adds
  "Delete it first to add this document again." (SC-012); one write-log line per retry with no name (FR-061).
- [X] T067 [P] [US5] Extend `WEB/src/pages/SourcesTab.test.tsx`: a failed source shows its message and hint, **Retry**
  only when `failure.retryable`, and the retry's refusal text.
- [X] T068 [US5] Add the bounds and categories of research #3–#5 and `SPEC/contracts/worker.md` to
  `API/src/extract/pdf.ts`, `docx.ts`, `child.ts` (memory check between pages and parts, exit 3) and `run.ts` (exit and
  signal mapping table). Make T064 pass.
- [X] T069 [US5] Make `storage_unavailable` transient: `JOB_TRANSIENT_CATEGORIES` in `CORE/src/schemas/job.ts`,
  `RunOutcome` in `API/src/jobs/store.ts`, the transient branch in `API/src/worker/run.ts`; and the `too_large`/`chars`
  check and the `input_too_large` mapping in `API/src/worker/ingest.ts`. Make T065 pass.
- [X] T070 [US5] Add `retrySource` to `API/src/sources/store.ts` (lock order; research #14's rules, the configured
  embedding model compared with the failed job's last usage record) and the `retry` operation to
  `API/src/v1/sources.ts` with its write-log line; add the failed-source wording to the duplicate refusal; regenerate
  `API/openapi.json`. Make T066 pass.
- [X] T071 [US5] Add **Retry** to `WEB/src/pages/SourcesTab.tsx`. Make T067 pass.

**Checkpoint**: messy documents fail with a reason a person can act on, and retrying never repeats a certain failure.

---

## Phase 8: User Story 6 - Keep embeddings in step with the configured model (Priority: P2)

**Goal**: out-of-date embeddings are shown and refreshed without changing a chunk; no provider leaves sources readable.

**Independent Test**: the spec's US6 Independent Test.

- [X] T072 [P] [US6] `API/test/sources/ingest-refresh.test.ts`: after the configured model changes, the source's
  embeddings are `out_of_date`; `refresh_embeddings` replaces every chunk's embedding in its commit, keeps every id and
  text, sets the new model, dimension and `stored_bytes`; a refresh to a larger dimension that would pass
  `DOCUMENT_SPACE` fails as `document_space_full` and the old embeddings stay; a cancelled or failed refresh leaves the
  source ready with its earlier embeddings and a `refresh_failure`; and SC-007, checked in SQL after each of those
  cases: every chunk's `vector_dims(embedding)` equals its source's `embedding_dimension`, and the source's
  `embedding_model` is the model of the job that wrote all of them, so no source holds two models' or dimensions'
  vectors.
- [X] T073 [P] [US6] `API/test/contract/v1/sources-refresh.test.ts`: `POST /sources/{id}/refresh` → `200` for an
  out-of-date ready source; `409` when not ready, current, already refreshing, or embeddings off; with no embedding
  provider configured, `GET` still lists and serves chunks and reports `no_provider`; one write-log line per refresh
  with no name (FR-061).
- [X] T074 [P] [US6] Extend `WEB/src/pages/SourcesTab.test.tsx` and `SourcePage.test.tsx`: the embedding state, **Refresh
  embeddings** only when `refreshable`, the refresh in progress refetched, the last refresh failure with **Retry**.
- [X] T075 [US6] Write `API/src/worker/refresh.ts` (`refresh_embeddings` per `SPEC/contracts/worker.md`) and register it.
  Make T072 pass.
- [X] T076 [US6] Add `refreshSource` to `API/src/sources/store.ts` (lock order) and the `refresh` operation to
  `API/src/v1/sources.ts` with its write-log line; report `embedding.state` and `refreshable`; regenerate `API/openapi.json`. Make T073 pass.
- [X] T077 [US6] Add the embedding state and **Refresh embeddings** to `WEB/src/pages/SourcesTab.tsx` and
  `SourcePage.tsx`. Make T074 pass.

**Checkpoint**: changing the embedding model never mixes two models' vectors and never changes a chunk.

---

## Phase 9: User Story 7 - An operator upgrades to this release (Priority: P2)

**Goal**: the released files, the image and the documentation take an operator from v0.1 or Milestone 2 to this
release with their data intact.

**Independent Test**: the spec's US7 Independent Test.

- [X] T078 [P] [US7] Extend `API/test/worker/startup.test.ts` and the API's start-up test: a missing or malformed storage
  or source setting, or an AWS variable of T010 with `s3`, stops each process with the variable's name and no value; with
  no storage settings both start on the default local backend.
- [X] T079 [US7] Write `scripts/check-db-upgrade.sh` (POSIX `sh`, `set -eu`) per research #15: a volume on
  `postgres:16-alpine` at its pinned digest, migrations to 016 and rows whose text sorts differently under musl and glibc
  (users, projects, threat models with mixed case and accents), the `SX001` refusal of 017 there (after which
  `schema_migrations` has no 017 row and no `sources` table exists: SC-010's "changes 0 tables"), the move to the
  pgvector image, the **negative control** (`bt_index_check(…, true)` must report a broken index before 017), 017
  applied, every B-tree index passing `bt_index_check(…, true)`, row counts unchanged; it cleans up its containers and
  volume. If the negative control finds no broken index, do not tune the data until it does: print the database's
  `datlocprovider`, `datcollate` and `datctype` on both images, stop, and ask the maintainer, because the reindex would
  then rest on a wrong premise (research #15). Add it as a step of the `test` job in `.github/workflows/ci.yml` after
  the unit tests (SC-010). In `docs/ci.md`, replace `postgres:16-alpine` with the pgvector service image and its digest,
  say why (research #15), and describe the new upgrade-check step and how to run it locally.
- [X] T080 [US7] In `docker-compose.release.yml` set the `db` image to the pgvector tag pinned by digest; in both compose
  files add the named volume `storage` mounted at `/app/apps/api/storage` in `app` and `worker` and the variables of
  `SPEC/contracts/configuration.md` with their defaults; in `Dockerfile`, create `/app/apps/api/storage` owned by `node`
  before `USER node`, and check that `dist/extract/child.js` and pdfjs-dist's `cmaps/` and `standard_fonts/` are in the
  image. Smoke-check the built image: `docker build .`, start `db`, `app` and `worker` from the release file with no
  storage settings and no provider, and check that both are healthy, that the worker's log shows no storage error, and
  that adding a source is refused with the embedding-provider `409` (US1 scenario 7).
- [X] T081 [P] [US7] Add every new variable to `.env.example`, the two S3 keys commented as secrets.
- [X] T082 [US7] Update `docs/install.md`: the variable table rows and the "which process gets what" table of
  `SPEC/contracts/configuration.md`; a **Storage** section (local volume, S3-compatible with a dedicated bucket or
  prefix, the per-process IAM policies of research #10, bucket encryption at rest, the 1 h 10 min removal bound); the
  document space with research #12's figures; the extraction bounds and that container memory limits remain the last
  line; an **Upgrading to v0.2** section with the anchor `#upgrading-to-v02` (the new image, keeping the volume, the
  automatic reindex, the uid change handled by the image, managed databases and `CREATE EXTENSION vector` by an
  administrator, the two `SX` messages); the licences section saying each dependency's licence is in the image's
  `node_modules`.
- [X] T083 [P] [US7] Update `docs/ai-providers.md`: adding documents needs an embedding provider; chunks of 2,000
  characters and the 2,048-token minimum; Ollama's context at 2,048 or more; dense scripts reach `JOB_TOKEN_CAP` sooner;
  where a document's text goes (embeddings now, generation from Milestone 4).
- [X] T084 [P] [US7] In `docs/formats/`, say that exports and imports do not carry sources, their text or their chunks
  (FR-067), and in the report's documentation that reports do not either.

**Checkpoint**: an operator can upgrade by the notes, and CI proves the volume survives.

---

## Phase 10: User Story 8 - Ingestion is in Scrylux's own threat model (Priority: P2)

**Goal**: the constitution's Threat Model section and `docs/threat-model/` record everything of FR-080.

**Independent Test**: the spec's US8 Independent Test; `pnpm --filter @scrylux/api exec vitest run test/dogfood` passes.

- [X] T085 [US8] Amend `.specify/memory/constitution.md` to **1.16.0** (MINOR): a new Sync Impact Report at the top, the
  1.15.0 one summarised below it; `Last Amended` the day of the change; Threat Model changes per research #18: assets
  current (sources, originals and where kept, chunks, embeddings, the S3 credentials held by the app and the worker);
  the extraction child as a process holding no secret; the eight source routes as entry points, open to every signed-in
  account (FR-065, a broadening until Phase 6); the inbound document boundary current; the outbound provider boundary
  carrying user content, the disclosure item moved from accepted to mitigated by the notice; S3 as an outbound boundary;
  and each risk with its handling and test file (malicious files: `test/extract/failures.test.ts`; data outliving
  deletion or need: `test/storage/sweep.test.ts`, `sources-delete.test.ts`; spend and storage exhaustion: the caps,
  `INGESTION_JOBS_PER_ACCOUNT`, `DOCUMENT_SPACE`, open across many accounts until Phase 6; stored prompt injection,
  untrusted until Milestone 4; a shared bucket; the child's network egress, accepted). Principle VI's sentence on the
  notice says it shipped here.
- [X] T086 [US8] Update `docs/threat-model/` by its README's "Updating the model", in a running Scrylux, never by
  editing the files by hand: import the model; add the process `Document reader` (the child) inside the worker's
  boundary, the data store `Document storage` (local volume or S3), the flows `Uploaded documents` (browser → API →
  storage), `Original for reading` (storage → worker → reader), `Chunks and embeddings` (worker → database) and
  `Document text for embeddings` (worker → embedding provider), flagged sensitive; add the source routes to the API's
  description; **Generate threats** and decide each by the README's status table using T085's bullets; add any FR-080
  risk the rules did not derive as a model-level threat; download the Scrylux file and the report back to back and
  replace the committed files; run the dogfood test until it passes.
- [X] T087 [US8] In `docs/threat-model/README.md`: the model covers the system through Phase 3 Milestone 3; leave the
  approval paragraph's dates unchanged and say the Milestone 3 additions await the maintainer's approval.

**Checkpoint**: Principle V is satisfied in the same change.

---

## Phase 11: Polish & Cross-Cutting Concerns

- [X] T088 Guard test: extend `API/test/worker/canary.test.ts` (SC-008): a fake document text, a fake file name and a
  fake S3 secret key, run through add, ready, every failure category, a failing commit, retry, refresh and delete, appear
  in no log line, `jobs` or `job_usage` row, failure message or error answer, apart from the duplicate refusal's name;
  the text and name appear only in `sources`, `chunks` and the two `GET` answers that show them.
- [X] T089 [P] In `plan.md` and `docs/roadmap.md`: Phase 3 Milestone 3 as built (embeddings required, two storage
  backends, originals deleted once read); Milestone 4 gains "for small inputs, skip retrieval and send the full context"
  and "adds the vector index it queries" (research #8).
- [X] T090 [P] Add an Unreleased entry to `CHANGELOG.md` for operators: the Sources tab, the database image change and
  its automatic reindex, the vector extension now required, the storage volume or S3, the new variables, that adding
  documents needs an embedding provider, and the notice.
- [X] T091 [P] If `README.md`'s quickstart or features list names what Scrylux reads, add documents in one sentence,
  linking `docs/install.md#upgrading-to-v02` for existing installs.
- [X] T092 Full verification: `pnpm run typecheck`, `pnpm run lint` (licence check included), `pnpm run test` (with the
  pgvector Postgres, as CI), `pnpm run build`, `pnpm run test:e2e`, `scripts/check-db-upgrade.sh`, `docker build .`. Fix
  anything red. No `TODO`, no commented-out code, no unused export.
- [X] T093 (done without an AWS account: S3 against adobe/s3mock, the IAM policies by `iam-policies.test.ts`, and the smallest host emulated by container limits; see pr-description.md) Run quickstart §2–§5 by hand (Ollama local; one hosted embedding provider with its key on the worker only;
  MinIO for S3 and the `AWS_ENDPOINT_URL_S3` refusal; a v0.1 volume upgraded). On the smallest host the deployment guide
  names, time the largest test PDF of T030 from upload to ready against the stub provider (SC-002's manual half).
  Record the date, host, providers, models, outcomes and timings for the PR description. The maintainer supplies any hosted key: never write it to a file.
- [X] T094 Write `SPEC/pr-description.md` in the style of earlier milestones'. It must call out: the security
  implications (document ingestion, a new process, storage credentials, new routes; Development Workflow); the database
  image change and the reindex for every install; the vector extension now required; the broadening of FR-065; the S3
  credentials given to the app and the worker; the spec decisions of clarification and planning; the constitution
  amendment to 1.16.0; that the eval gate does not apply (no prompt, no generation; the harness is Milestone 7); and the
  record from T093. No AI attribution, no co-author line. Do not commit, push or open the PR.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: none. T002 before any test that touches the database.
- **Foundational (Phase 2)**: needs Setup. Blocks every story. T014 before T015; T016 before T020; T017 before T018;
  T023 needs T017–T019.
- **US1 (Phase 3)**: needs Foundational. T036 needs T035; T039 needs T037, T038; T043 needs T036, T039, T041, T042;
  T044 needs T041; T046 needs T044, T045; T048 needs T047; T040 right after T039.
- **US2 (Phase 4)**: needs T048.
- **US3 (Phase 5)**: needs US1 (a ready source).
- **US4 (Phase 6)**: needs US1. T060 needs T059. T063 needs US1–US4.
- **US5 (Phase 7)**: needs US1. T068 needs T039; T070 needs T044.
- **US6 (Phase 8)**: needs US1 and T042. T076 needs T070 (the shared lock-ordered queueing of a job for a source).
- **US7 (Phase 9)**: needs Foundational (settings) and US1 (the image must carry the child). T080 before T082.
- **US8 (Phase 10)**: after US1–US7 (it describes them). T086 after T085.
- **Polish (Phase 11)**: needs all stories. T088 needs US5 and US6; T093 needs T092; T094 needs T093.

### Within each phase

- Tests are written and **seen failing** first; implementation follows.
- Files edited by more than one task, never by two at once: `API/src/jobs/store.ts` (T041, T042, T069);
  `API/src/sources/store.ts` (T044, T054, T059, T070, T076); `API/src/v1/sources.ts` (T046, T054, T059, T070, T076);
  `API/openapi.json` (T046, T054, T059, T070, T076); `API/src/worker/kinds.ts` (T042, T043, T075);
  `API/src/worker/ingest.ts` (T043, T069); `API/src/extract/*.ts` (T037–T039, T068); `WEB/src/pages/SourcesTab.tsx`
  (T048, T051, T062, T071, T077) and its test (T032, T062, T067, T074); `WEB/src/pages/SourcePage.tsx` (T055, T062,
  T077); `WEB/src/App.tsx` (T048, T055); `API/src/server.ts` and `API/src/worker.ts` (T021, T023);
  `.github/workflows/ci.yml` (T002, T079); compose files (T002, T080).

## Parallel Opportunities

- **Setup**: T004 alongside T001–T003.
- **Foundational tests**: T006–T013 together. **Foundational implementation**: T016, T017, T019, T021, T022 together
  after T014–T015; then T018, T020, T023.
- **US1 tests**: T024–T033 together. Then T034, T035, T037, T038 together; T041 alongside them.
- **US2–US6 tests** within each story together (T050; T052–T053; T056–T058; T064–T067; T072–T074).
- **US7**: T081, T083, T084 together, alongside T079.
- **Polish**: T089, T090, T091 together.

### Example: the US1 tests at once

```text
T024 [US1] API/test/sources/sniff.test.ts            first-byte checks
T025 [US1] API/test/sources/text.test.ts             normalization, lines, headings
T026 [US1] API/test/sources/chunk.test.ts            chunk boundaries and reconstruction
T027 [US1] API/test/extract/read.test.ts             PDF and .docx through the real child
T028 [US1] API/test/sources/store.test.ts            add, checks, locks, derived status
T029 [US1] API/test/jobs/store.test.ts               finishRun with a commit
T030 [US1] API/test/sources/ingest.test.ts           the kind end to end
T031 [US1] API/test/contract/v1/sources.test.ts      the add and list routes
T032 [US1] WEB/src/pages/SourcesTab.test.tsx         the tab
T033 [US1] WEB/src/pages/JobsPage.test.tsx, JobPage.test.tsx
→ then T034–T039 (sniff, text, chunk, readers, child), T041–T046 (jobs, kind, store, upload, routes), T047–T049 (web)
```

## Implementation Strategy

### MVP first (User Stories 1–4)

Setup, Foundational, then US1–US4: a document is added with the notice on screen, read into chunks with embeddings,
reviewed, and removed with its original. Stop and check the four independent tests and T063.

### Incremental delivery

1. **US5**: the bounded failure categories and retry.
2. **US6**: out-of-date embeddings and refresh.
3. **US7**: the released files, the image, the upgrade check and the documentation.
4. **US8**: the constitution and the threat model.
5. **Polish**: the canary, `plan.md` and the roadmap, the changelog, full verification, live runs, PR description.

Each step leaves `pnpm run test` green.

---

## Phase 12: Convergence

Found by `/speckit-converge` after the implementation: what the code does not yet match in the spec, plan, contracts and tasks.

- [X] T095 Make the job page's "Open the document" link go to the source's own page, `/threat-models/:threatModelId/sources/:sourceId`, not to the Sources tab, in `WEB/src/pages/JobPage.tsx`, and change the link assertions in `WEB/src/pages/JobPage.test.tsx` per `SPEC/contracts/ui.md` ("Jobs page": the job's page links to its source; "The document was deleted" otherwise) (partial)
- [X] T096 Show the limits of `SourceList.limits` on the add form in `WEB/src/pages/SourcesTab.tsx`: the largest file, how many of the threat model's sources are used, and how full the document space is (`used_bytes` of `document_space_bytes`), with a test in `WEB/src/pages/SourcesTab.test.tsx`, per `SPEC/contracts/ui.md` §2, FR-004, FR-005 and FR-009 (partial)
- [X] T097 Say in `CONTRIBUTING.md` (Setup) that a PostgreSQL of your own needs the pgvector extension, as the compose `db` service has it, because the migrations and the tests need it, per FR-083 and FR-090 (partial)
- [X] T098 Decide the Retry button on `WEB/src/pages/SourcePage.tsx`: `SPEC/contracts/ui.md` and T055/T062/T077 name Delete and Refresh embeddings there, not Retry. Either add Retry to the contract's source-page section or remove the button and its test in `WEB/src/pages/SourcePage.test.tsx` per `SPEC/contracts/ui.md` (unrequested)
- [X] T099 Un-export, or give a use outside tests to, the exports of this milestone's files that nothing outside their own file and the tests uses, so that T092's "no unused export" holds: `API/src/sources/log.ts` `SourceAction`; `API/src/sources/config.ts` `SourceConfigError`, `SourceConfigCheck`; `API/src/storage/config.ts` `StorageConfigError`, `StorageConfigCheck`, `AWS_S3_EXEMPT_VARIABLES`, `refusesS3Variable`; `API/src/storage/sweep.ts` `SWEEP_GRACE_MS`, `SweepResult`; `API/src/sources/upload.ts` `MAX_CONCURRENT_BODIES`, `UploadedFile`; `API/src/sources/commit.ts` `vectorText`, `WorkSource`, `IngestResult`, `RefreshResult`; `API/src/sources/store.ts` `AddSourceInput`; `API/src/sources/sniff.ts` `SniffResult`; `API/src/extract/run.ts` `ExtractInput`; `API/src/worker/embed-all.ts` `EmbedOutcome` (keep one only where a test needs it and say so in a comment) per T092 (partial)

---

## Phase 13: Convergence

Found by a second `/speckit-converge`, after Phase 12 was done: the tests that `SPEC/quickstart.md` and the edge cases promise and that do not exist yet.

- [X] T100 Add a lost-run test to `API/test/sources/ingest-failures.test.ts` (or `ingest-delete.test.ts`): start a worker, hold the embedding request, `abandon()` the worker so its lease runs out, start a second worker, and check the source ends ready with each chunk once, no chunk of the lost run, and the same chunk ids on a second read, per SC-006 and `SPEC/quickstart.md` §1 ("lost run and retry write each chunk once") (partial)
- [X] T101 Add to `API/test/sources/ingest-refresh.test.ts` a refresh that the new model refuses as too large: the stub answers `context_length_exceeded`, the job fails as `input_too_large`, the source stays ready with its earlier embeddings and state `out_of_date`, its `refresh_failure` carries the hint for documents' chunk size and is not retryable until `EMBEDDING_MODEL` changes (then `POST /sources/{id}/retry` queues a refresh), and SC-007's SQL check holds, per the edge case "A new embedding model with a smaller input limit", FR-034 and FR-045 (partial)
- [X] T102 Add to `API/test/sources/ingest.test.ts` the files whose text is only whitespace: a `.md`, a `.txt` and a pasted-text source of spaces and newlines are accepted at upload (the paste is refused by its schema), the worker fails the files as `no_text_found` with one run and the original kept, and no chunk is written, per the edge case "An empty file, or a file whose text is only whitespace" and FR-013 (partial)
- [X] T103 Correct the test paths in `SPEC/quickstart.md` §1 and `SPEC/plan.md`'s file tree: the ingestion tests are `API/test/sources/ingest*.test.ts` (`ingest`, `ingest-failures`, `ingest-delete`, `ingest-refresh`), not `API/test/worker/ingest.test.ts`, and the new `API/test/worker/sweep.test.ts`, `API/test/storage/iam-policies.test.ts` and `API/test/startup-process.test.ts` belong in the table (partial)

---

## Phase 14: Convergence

Found by a third `/speckit-converge`, after Phase 13 was done: the database image changed, and two places that keep it current still describe the old one.

- [X] T104 Make Dependabot's rule for the database image match the image now in the compose files: `.github/dependabot.yml`'s `docker-compose` entry ignores major updates of `postgres`, which neither compose file uses any more, so a bump of `pgvector/pgvector` (a new pgvector version, or another PostgreSQL major in its tag, `pg16` to `pg17`) is no longer held back for a human, as `docs/ci.md` ("Dependabot", docker-compose) says it is. Add an `ignore` entry for `pgvector/pgvector` for major updates, say in `docs/ci.md` that a change of the PostgreSQL major in the tag is a data migration and is refused by hand if Dependabot proposes it, and keep `scripts/workflows.test.ts` or `scripts/compose.test.ts` green (or extend one to hold the rule) per FR-092 and research #15 (partial)
- [X] T105 Update the PostgreSQL bullet of "Refreshing the pins" in `docs/releasing.md`: the pin is now the pgvector image, `pgvector/pgvector:0.8.7-pg16-trixie@sha256:…`, kept in three places that must agree (`docker-compose.release.yml`, the `test` job's service container in `.github/workflows/ci.yml`, and `NEW_IMAGE` in `scripts/check-db-upgrade.sh`, which `scripts/compose.test.ts` checks), with how to find the new digest; and say that the Alpine image pinned as `OLD_IMAGE` in that script is v0.1's and is never refreshed, because the check exists to prove an upgrade from it per FR-092 and research #15 (partial)

---

## Phase 15: Convergence

Found by a fourth `/speckit-converge`, after Phase 14 was done: one place where the constitution's rule for SQL identifiers is not followed to the letter, and one test leftover.

- [X] T106 CRITICAL (a MUST of the constitution, with no practical risk): replace `sql.raw(kind === 'ingest_source' ? 'ing' : 'ref')` in `jobFacts` in `API/src/sources/store.ts`, the one place in this milestone's server code that puts an identifier into SQL unescaped, with `sql.id(...)` (Kysely's identifier escaping) of the same two constants, or with a form that needs no dynamic identifier at all (the two joins written out), so that Principle I's rule holds that an identifier built into a statement, even from a fixed list, passes through the driver's identifier escaping; keep `API/test/sources/store.test.ts` green per Constitution I (contradicts)
- [X] T107 Remove the temporary storage directory that `API/test/env.setup.ts` makes for each test process (`scrylux-storage-*`, 236 of them were left in the system temp directory by earlier runs), when that process ends, and only a directory the setup made itself, never one the shell chose through `STORAGE_DIR`; originals of documents are confidential by nature, and a test that leaves one in the temp directory leaves it there, per T005 and FR-050 (partial)

---

## Phase 16: Convergence

Found by a fifth `/speckit-converge`, after Phase 15 was done: statements about what Scrylux does that this milestone made untrue.

- [X] T108 Correct the documents that still say no user content reaches a provider or that only the provider check uses the worker, now that a document's chunks are sent for embedding by the worker: `packages/llm/README.md` ("Nothing in Scrylux sends user content through it yet… the worker, ingestion and the prompts come in later Phase 3 milestones"), the `packages/llm` row of the table in `docs/development.md` ("Nothing sends user content through it yet"), and the compose paragraph of `docs/development.md` (the worker runs "the provider check on the Jobs page"; "`docker compose up --build app db` is enough for everything except jobs" is also untrue for documents, which need the worker and an embedding provider; "the browser test for jobs" is now two, `jobs` and `sources`, which run after the others, one at a time, and the second needs `openssl`) per FR-081 and Principle VI (partial)
- [X] T109 Settle the note in `packages/llm/src/client.ts` ("A guard against an accidental unbounded call; Milestone 3 may change it when it knows its chunk counts"): Milestone 3 sends 64 chunks per request, far under the guard, so say that and keep the limit as it is, or remove the note, in a comment that no longer defers to a milestone that has shipped, per T092 (partial)

---

## Phase 17: Convergence

Found by a sixth `/speckit-converge`, after Phase 16 was done: the install guide's two sections for people who do not use the compose files still describe v0.1.

- [X] T110 Update the two places in `docs/install.md` that serve an install without the compose files: "Run without Docker" (it says "a reachable PostgreSQL 13 or newer" with no mention that the database needs the pgvector extension and a role that may enable it, that the worker is a second process to start, `pnpm --filter @scrylux/api worker`, or that a directory for the originals, `STORAGE_DIR`, must be writable by both) and the first bullet of "Deployment" ("nothing is read from local files", which is not true of the local storage backend; add that app and worker must share the storage, so more than one host needs `STORAGE_BACKEND=s3`, and that the worker needs memory for reading files), linking [Documents and storage](#documents-and-storage) and [Upgrading to v0.2](#upgrading-to-v02), per FR-081 and FR-082 (partial)
