# Implementation Plan: Ingestion

**Branch**: not yet created (spec directory `phase-3/milestone-3-ingestion`; work is on `feat/phase-3`; the setup script
inferred `milestone-3-ingestion` as the branch name, but no branch by that name was created) |
**Date**: 2026-11-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/phase-3/milestone-3-ingestion/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Phase 3 / Milestone 3 lets a signed-in person add design documents to a threat model: upload a `.md`, `.txt`, `.pdf` or
`.docx`, or paste text. The API checks the upload's first bytes, stores the original on a local volume or in an
S3-compatible bucket, and queues an `ingest_source` job. The worker reads the file in a child process that holds no
secret, splits its text into consecutive chunks of at most 2,000 characters, embeds them through `@scrylux/llm` under
the job's caps, and writes every chunk with its embedding in the one fenced transaction that ends the job. The original is then
deleted. A new Sources tab shows the notice that data leaves the install, the sources, their progress and their chunks.
The database moves to the pgvector image, and its migration repairs text indexes for the C-library change.

At planning the maintainer chose one thing and the plan settled four (spec Clarifications, session 2026-11-01, during
planning):

- **The document space counts what a source stores**, text and embeddings, and the worker checks it again at the
  commit, so ready sources never pass the cap (FR-009, research #12).
- **The API reads only a file's first bytes**; `.docm` is the worker's `unsupported_type` (FR-003, research #5).
- **Chunks are consecutive with offsets**, no overlap (FR-021, research #7).
- **At most 4 uploads are read at once per API process**, and the UI sends files one at a time (FR-004, research #9).

**1. Database** (`packages/db/migrations/017_sources.sql`): pgvector, the reindex, `sources`, `chunks`, and `jobs`'
new columns, kinds and categories ([data-model.md](./data-model.md); research #13, #15, #16).

**2. Storage** (`apps/api/src/storage/`): the interface, local and S3 backends, settings with the AWS variable guard,
the sweep ([contracts/storage.md](./contracts/storage.md); research #10, #11).

**3. Extraction** (`apps/api/src/extract/`): the child process, the PDF reader, the `.docx` reader
([contracts/worker.md](./contracts/worker.md); research #3–#5).

**4. Sources** (`apps/api/src/sources/`): settings, first-byte checks, text normalization, chunking, the store with
derived status, document space and retry rules (research #1, #6, #7, #12, #14).

**5. Jobs and the worker**: the commit hook in `finishRun` with its lock order, the two kinds, the separate per-account
limit, `storage_unavailable` as transient, the sweep timer (research #2, #8, #13).

**6. The API**: the `upload` operation form, eight routes, threat-model and project deletion removing originals, migration messages
of class `SX` ([contracts/http-api.md](./contracts/http-api.md); research #9, #16).

**7. The web app**: the Sources tab and source page, the Jobs page's new kinds ([contracts/ui.md](./contracts/ui.md)).

**8. Packaging, docs and the threat model**: the image, compose files and CI, the upgrade check script,
`docs/install.md` (variables, upgrade notes, storage, licences), `docs/ai-providers.md`, `CHANGELOG.md`, constitution
1.16.0 and `docs/threat-model/` rebuilt (research #15, #18, #19).

## Technical Context

**Language/Version**: TypeScript 6.0.x, strict, on Node 22 (floor raised to 22.13 for pdfjs-dist 6). SQL for the
migration, YAML for `failures.yaml`, a POSIX shell script for the upgrade check.

**Primary Dependencies**: added to `apps/api`: `pdfjs-dist` 6.4 (PDF text), `yauzl` 3.4 and `saxes` 6 (`.docx`),
`busboy` 1.6 (multipart), `@aws-sdk/client-s3` 3.x (S3-compatible storage); dev `@types/busboy`, `@types/yauzl`.
`@napi-rs/canvas` excluded. pgvector 0.8.7 in the database image. No Kysely plugin: vectors are written as pgvector's
text form through parameterized SQL.

**Storage**: PostgreSQL 16 with pgvector. One migration. Per ready source: a row, about 1,500 characters and one
`vector` per chunk, bounded install-wide by `DOCUMENT_SPACE`. Originals in storage only until ready.

**Testing**:

- **Vitest** with the Postgres service container, now the pgvector image: `packages/db/test/`, `apps/api/test/storage/`,
  `test/extract/`, `test/sources/`, `test/worker/`, `test/contract/`, and web unit tests.
- **Real isolation in tests**: the extraction child is started from source with `tsx` (research #3).
- **Stubs**: Milestone 1's `startStub` for embeddings, an in-process S3 stub (research #10).
- **One Playwright spec** with its own API, worker and stub; the rest of the browser suite unchanged (SC-001).
- **Upgrade check** in CI's `test` job (`scripts/check-db-upgrade.sh`, research #15).
- **No secret, no provider network** (FR-083). §2–§5 of [quickstart.md](./quickstart.md) are by hand.

**Target Platform**: the published image on Node 22, two processes (`dist/server.js`, `dist/worker.js`), plus one
short-lived child per PDF or `.docx` extraction (`dist/extract/child.js`).

**Project Type**: the existing web service (`apps/api`, `apps/web`) and its packages.

**Performance Goals**:

- A source at the largest default size (10 MB, 1,000,000 characters) ready within 5 minutes against simulated responses
  (SC-002): extraction is bounded at 120 s, chunking is linear, about 11 embedding requests.
- UI updates within 5 s while a source is active: refetch every 2 s (FR-063).
- Cancel within 10 s (M2): the child is killed at once on abort.
- Originals removed at once after ready or delete; at most 1 h 10 min after anything that failed (FR-055).

**Constraints**:

- The API never parses a file's structure; the worker's child holds no secret and prints nothing (FR-010, SC-008).
- Every chunk write is inside the fenced commit; the source row is locked before the job row everywhere (research #2).
- No content, name, key, path or bucket in a log line, job row, usage row or error answer, except the duplicate refusal's
  name (SC-008).
- Every v0.1 and Milestone 2 flow works with no worker and no provider (FR-093).

**Scale/Scope**:

- About 20 new source files in `apps/api/src` (`storage/` 5, `extract/` 4, `sources/` 6, `v1/sources.ts`, the two kinds,
  the sweep), about 10 changed (`jobs/store.ts`, `jobs/kinds.ts`, `worker/run.ts`, `worker/loop.ts`, `v1/operation.ts`,
  `router.ts`, `openapi.ts`, `threat-models.ts`, `config.ts`, `server.ts`, `worker.ts`).
- One migration and its types; one schema file in `packages/core` and changes to `job.ts`.
- One tab, one page and their queries in `apps/web`, and the Jobs page's labels.
- About 15 test files and the fixtures. The image, compose files, CI, a script, docs, the constitution and the threat
  model.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| **I. Secure coding** | Parameterized SQL only; identifiers only from constants; secrets from env or the secrets manager, never logged, stored or sent to the browser; input validated; consistent errors. | ✅ All source and chunk SQL goes through Kysely or parameterized `sql` templates; vectors are bound parameters. The reindex lists its tables as constants in the migration file (no identifier from a query). The S3 credentials come from env or `DB_SECRET_ID`, never logged or stored (FR-052), and a refusal names variables, never values. The upload is checked at the boundary: size before reading, first bytes, UTF-8; the paste with the shared zod schema. Every error is fixed `{ error }` text ([contracts/http-api.md](./contracts/http-api.md)). |
| **II. Test-first** | A failing test before each behavior; the suite green; eval gate. | ✅ Every FR maps to a test in [quickstart §1](./quickstart.md#1-automated-suites), written first, including the real child process and both storage backends. **The eval gate does not apply**: no prompt, no generation, no extraction pipeline in Principle II's sense (that is Milestone 4's system extraction), and the harness arrives in Milestone 7. The PR says so (research #19). |
| **III. Simplicity / YAGNI** | No later phase's scope; no premature dependencies; no dead code; layout. | ✅ **Not added**: a vector index or any similarity query (Milestone 4, FR-035), context selection, OCR, re-extraction, downloading originals, exporting sources, a project-wide document library, a cooldown, a parsing service. **Dependencies**: five, each needed by a requirement of this milestone (research #19). The `.docx` reader is ours, about 200 lines, because the usual library cannot bound decompression (research #5). No new workspace package. |
| **IV. Maintainability** | Env-only config, documented; stdout logs without payloads; forward-only migrations; stateless processes; `/health`; storage abstraction; data files. | ✅ Eighteen variables, all in `docs/install.md` ([contracts/configuration.md](./contracts/configuration.md)). JSON log lines with ids and counts only. One forward-only migration; nothing creates tables at start. Originals go through the storage abstraction; `STORAGE_DIR` is the operator's setting, not a path in code, and S3 lets the app and worker run on separate hosts. Both processes stay stateless: the original is in storage, the rest in Postgres. Failure messages are data (`failures.yaml`). `/health` unchanged. |
| **V. Least privilege / threat-aware** | Threat Model updated for new assets, entry points and boundaries in the same change; broader grants called out. | ✅ **The section changes (FR-080)**: the assets, the child process, eight routes, the inbound document boundary now current, user content on the outbound provider boundary, S3 as an outbound boundary, and the risks of research #18. Constitution 1.16.0; `docs/threat-model/` rebuilt. **Least privilege**: the extraction child holds nothing; the S3 policy is limited to the prefix; originals are kept only while needed. **Called out as broadening (FR-065)**: any signed-in account can add, read and delete every source and make the embedding provider spend, bounded by the caps, the ingestion limit, the source limit and the document space. |
| **VI. AI output is a draft** | Provider-agnostic; output validated; untrusted input delimited; no tool calls; local model supported; hosted disclosure. | ✅ Embeddings go only through `@scrylux/llm`, from the worker. No model output enters the threat model: vectors are stored, not shown or acted on. Documents are untrusted input, read in an isolated child, never executed, rendered as text; they reach no generation prompt in this milestone (Milestone 4 delimits them). A local embedding model is fully supported. **Hosted disclosure**: this milestone ships the notice, on the add form and the list, for embeddings now and generation later (FR-070–FR-072). |

**Post-design re-check (after Phase 1)**: still passing.

- The design adds eight authenticated routes, two tables, a changed `jobs` table, eighteen variables, a child process and
  an optional outbound boundary to S3. Each is in the threat model update (research #18).
- The contracts expose no key, path, bucket or provider text; a name appears only in source records and the duplicate
  refusal; chunks are served only from a ready source.
- The PR must call out: the database image change and its reindex, for every install; the new required database
  extension; the broadening of FR-065; the S3 credentials given to the app as well as the worker; the eval gate not
  applying; and the planning clarifications above.

## Project Structure

### Documentation (this feature)

```text
specs/phase-3/milestone-3-ingestion/
├── plan.md              # This file
├── research.md          # Phase 0: decisions 1–20
├── data-model.md        # Phase 1: migration 017, records, derived status, transitions
├── quickstart.md        # Phase 1: automated suites and manual runs
├── contracts/
│   ├── http-api.md      # the eight source routes and changes to the job routes
│   ├── configuration.md # the eighteen variables, and which process gets what
│   ├── storage.md       # the storage interface, its backends and the sweep
│   ├── worker.md        # the two kinds and the extraction child
│   ├── data-files.md    # failures.yaml's additions; pdfjs data files
│   └── ui.md            # the Sources tab and the source page
├── checklists/
│   └── requirements.md  # spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
packages/db/
├── migrations/017_sources.sql       # new: pgvector, reindex, sources, chunks, jobs changes
├── src/migrate.ts                   # prints SX-class messages
└── src/schema.ts                    # + SourcesTable, ChunksTable; JobsTable's new columns

packages/core/src/schemas/
├── source.ts                        # new: SourceRecord, SourceList, ChunkRecord, ChunkPage, SourceTextInput
└── job.ts                           # + kinds, steps, categories, JobRecord fields

apps/api/
├── data/failures.yaml               # + categories, details, per-kind hints, sources.cancelled
├── package.json                     # + five dependencies; engines >=22.13
└── src/
    ├── storage/
    │   ├── index.ts                 # Storage, OriginalKey, StorageUnavailable, createStorage
    │   ├── local.ts, s3.ts          # the two backends
    │   ├── config.ts                # parseStorageConfig, the AWS variable guard
    │   └── sweep.ts                 # the reconcile sweep
    ├── extract/
    │   ├── child.ts                 # the child's entry point → dist/extract/child.js
    │   ├── run.ts                   # fork, limits, kill, answer → outcome
    │   ├── pdf.ts                   # pdfjs-dist reader
    │   └── docx.ts                  # yauzl + saxes reader
    ├── sources/
    │   ├── config.ts                # parseSourceConfig
    │   ├── sniff.ts                 # first-byte type checks, UTF-8
    │   ├── text.ts                  # normalization, line numbers, Markdown headings
    │   ├── chunk.ts                 # consecutive chunks ≤ 2,000 characters
    │   ├── store.ts                 # add, list, read, chunks, delete, derived status, space, retry rules
    │   └── upload.ts                # the multipart reader and the 4-upload guard
    ├── worker/
    │   ├── kinds.ts                 # + ingest_source, refresh_embeddings
    │   ├── ingest.ts, refresh.ts    # new: the two kinds' work and commits
    │   ├── run.ts                   # passes the commit to finishRun
    │   └── loop.ts                  # + the sweep timer
    ├── jobs/
    │   ├── store.ts                 # finishRun with commit; enqueue with the ingestion limit; JobRecord fields
    │   ├── kinds.ts                 # CALLS_MODEL → NEEDS
    │   └── failures.ts              # details, kinds, sources.cancelled
    ├── v1/
    │   ├── sources.ts               # new: the eight operations
    │   ├── operation.ts, router.ts, openapi.ts   # the upload form
    │   └── threat-models.ts, projects.ts   # delete locks the sources reached and removes their originals
    ├── config.ts                    # DB_SECRET_ID keys + STORAGE_S3_*
    ├── server.ts, worker.ts         # settings checks; SX messages
    └── migrate.ts                   # SX messages

apps/api/test/
├── fixtures/sources/                # committed small files and the script that makes them
├── storage/                         # one suite on both backends, the sweep, the documented IAM policies (iam-policies.test.ts)
├── extract/, sources/               # sources/ingest.test.ts, ingest-failures, ingest-delete, ingest-refresh: the worker's kinds, end to end
├── worker/sweep.test.ts, canary.test.ts (extended), startup.test.ts (extended)
├── startup-process.test.ts          # each process, started for real with a bad setting
└── contract/v1/sources*.test.ts     # sources, -chunks, -delete, -retry, -refresh

apps/web/src/
├── App.tsx                          # + /threat-models/:id/sources, /threat-models/:id/sources/:sourceId
├── pages/ThreatModelPage.tsx        # + Sources tab
├── pages/SourcesTab.tsx, SourcePage.tsx   # new, with tests
├── pages/JobsPage.tsx, JobPage.tsx, components/job-format.ts   # new kinds, link to source
└── api/queries.ts                   # + source queries and mutations
apps/web/e2e/sources.spec.ts         # new

scripts/check-db-upgrade.sh          # new: the upgrade check
Dockerfile                           # + storage directory owned by node
pnpm-workspace.yaml                  # ignoredOptionalDependencies: @napi-rs/canvas
package.json                         # engines >=22.13
docker-compose.yml, docker-compose.release.yml   # pgvector image, storage volume, variables
.github/workflows/ci.yml             # pgvector service image; upgrade check step
.env.example
docs/install.md, docs/ai-providers.md, docs/formats/ (sources not exported), CHANGELOG.md
plan.md, docs/roadmap.md             # M3 as built; M4 gains "skip retrieval for small inputs" and its vector index
.specify/memory/constitution.md      # 1.16.0
docs/threat-model/                   # rebuilt
```

**Structure Decision**: the existing monorepo. Storage, extraction and sources are modules of `apps/api`, shared by its
two entry points, as the job storage is (Milestone 2, research #2). The extraction child is a third entry point of the
same package and image. No new workspace package.

## Complexity Tracking

| Departure | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| A child process per extraction | Bounds memory, including decompressed buffers, and keeps credentials away from untrusted parsers (FR-010, FR-011, research #3) | Worker threads share the environment and do not bound `ArrayBuffer` memory; parsing in the worker's process lets one file take every job down |
| Our own `.docx` reader instead of a library | Decompression bounded by validated entry sizes, and the headings FR-022 needs (research #5) | `mammoth` inflates whole entries with no bound and its raw text drops headings |
| A reindex in migration 017 for every install | The only image with pgvector uses glibc, and an existing Alpine volume's text indexes would silently be wrong (research #15) | A manual step in the upgrade notes would be missed, and nothing would tell the operator |
| `KindOutcome.commit` in Milestone 2's `finishRun` | All chunks at once, fenced, with no duplicate after a lost run (FR-024, research #2) | Writing chunks during the run leaves partial sets every reader must filter |
