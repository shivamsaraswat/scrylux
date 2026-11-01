# Data Model: Ingestion

Phase 1 of [plan.md](./plan.md). One forward-only migration, `packages/db/migrations/017_sources.sql`, adds two tables,
changes `jobs`, and enables pgvector. Kysely types in `packages/db/src/schema.ts`; API records in
`packages/core/src/schemas/source.ts`.

## Migration 017, in order

1. The extension check and `CREATE EXTENSION IF NOT EXISTS vector`, raising `SX001` or `SX002` (research #16).
2. `REINDEX TABLE` on every table that exists before 017, `schema_migrations` first (research #15).
3. `sources`, then `chunks`.
4. The changes to `jobs`.

## `sources`

| Column | Type | Rules |
|---|---|---|
| `id` | `UUID` PK | `gen_random_uuid()` |
| `threat_model_id` | `UUID` NOT NULL | FK `threat_models(id)` `ON DELETE CASCADE` (FR-054) |
| `name` | `TEXT` NOT NULL | 1–255 characters after trimming; the file's name or the pasted title (≤ 200). Display only (FR-008) |
| `type` | `TEXT` NOT NULL | `md`, `txt`, `pdf`, `docx`, `text` (pasted) |
| `size_bytes` | `INTEGER` NOT NULL | > 0; the bytes received |
| `digest` | `BYTEA` NOT NULL | SHA-256 of the bytes received, 32 bytes; `UNIQUE (threat_model_id, digest)` (FR-006) |
| `added_by` | `INTEGER` NOT NULL | FK `users(id)` `ON DELETE RESTRICT`, as for jobs |
| `added_at` | `TIMESTAMPTZ` NOT NULL | `now()` |
| `original_key` | `TEXT` NULL, UNIQUE | `sources/<uuid>`; set while not ready, `NULL` from the commit that makes it ready (FR-057) |
| `stored_bytes` | `BIGINT` NOT NULL | `size_bytes` until ready; then text UTF-8 bytes + `chunk_count × embedding_dimension × 4` (FR-009, research #12) |
| `ready_at` | `TIMESTAMPTZ` NULL | set by the commit that makes it ready; never cleared |
| `text_chars` | `INTEGER` NULL | ready only; length of the extracted text, in code points |
| `chunk_count` | `INTEGER` NULL | ready only; ≥ 1 |
| `pages_without_text` | `INTEGER` NULL | ready PDFs only; ≥ 0 (FR-014) |
| `embedding_model` | `TEXT` NULL | ready only; the model that produced every vector of the source (FR-031) |
| `embedding_dimension` | `SMALLINT` NULL | ready only; 1–16,000 |

Checks:

- `ready_at IS NULL` ⇔ `text_chars`, `chunk_count`, `embedding_model`, `embedding_dimension` all `NULL`.
- `ready_at IS NOT NULL` ⇒ `original_key IS NULL`. A source not yet ready has its original:
  `ready_at IS NULL` ⇒ `original_key IS NOT NULL`.
- `pages_without_text IS NOT NULL` ⇒ `type = 'pdf' AND ready_at IS NOT NULL`.

Indexes: `(threat_model_id, added_at, id)` for the list and the per-threat-model count; the two unique constraints. The
document-space total is `SUM(stored_bytes)` over the table (research #12).

## `chunks`

| Column | Type | Rules |
|---|---|---|
| `id` | `UUID` PK | `gen_random_uuid()`; never changes (FR-023) |
| `source_id` | `UUID` NOT NULL | FK `sources(id)` `ON DELETE CASCADE` |
| `position` | `INTEGER` NOT NULL | 0-based; `UNIQUE (source_id, position)` |
| `start_offset`, `end_offset` | `INTEGER` NOT NULL | in code points (research #6); `0 ≤ start < end`, `end − start ≤ 2000`; chunk *n+1* starts at chunk *n*'s end (FR-021) |
| `text` | `TEXT` NOT NULL | `char_length(text) = end_offset − start_offset` (code points in a UTF-8 database); no NUL, no lone surrogate |
| `page_first`, `page_last` | `INTEGER` NULL | PDF only; both or neither; `1 ≤ first ≤ last` |
| `line_first`, `line_last` | `INTEGER` NULL | text types only; both or neither; `1 ≤ first ≤ last` (FR-022) |
| `heading` | `TEXT` NULL | Markdown and `.docx`; ≤ 200 characters |
| `embedding` | `vector` NOT NULL | no fixed dimension (research #8); replaced only by a refresh |

No vector index (research #8). Contiguity across rows (no gap, no overlap, starting at 0, ending at `text_chars`) is
written by one statement group in the commit and checked by the tests, not by a constraint.

## Changes to `jobs`

- `threat_model_id UUID NULL` FK `threat_models(id)` `ON DELETE CASCADE`; `source_id UUID NULL` FK `sources(id)`
  `ON DELETE SET NULL`.
- `jobs_kind_check`: `provider_check`, `ingest_source`, `refresh_embeddings`.
- New check: `kind = 'provider_check'` ⇔ `threat_model_id IS NULL`. (`source_id` may become `NULL` when the source is
  deleted, so it is checked by the API when queueing, not by a constraint.)
- `jobs_failure_category_check` gains the categories below; `jobs_failure_detail_check` allows `time` and `memory`
  with `unreadable`, and `pages` and `chars` with `too_large`, so the message names the bound that was passed (FR-011).
- Index `jobs_source_idx (source_id, kind, queued_at DESC) WHERE source_id IS NOT NULL`: the latest job of each source.
- The input of the new kinds is `{ "source_id": "<uuid>" }`, nothing else (FR-041).

## Failure categories

Added to Milestone 2's, with a message and hint each in `apps/api/data/failures.yaml` ([contracts/data-files.md](./contracts/data-files.md)):

| Category | Raised by | Retried by the worker | Retry offered |
|---|---|---|---|
| `unsupported_type` | worker (`.docm`, missing main part of the wrong type) | no | no |
| `encrypted` | worker (PDF password) | no | no |
| `damaged` | worker (unreadable structure, a `<!DOCTYPE`, a child that crashed) | no | no |
| `no_text_found` | worker | no | no |
| `too_large` (detail `chars` or `pages`) | worker (text past `SOURCE_MAX_CHARS`, pages past `EXTRACT_MAX_PAGES`) | no | no |
| `too_large_unpacked` | worker | no | no |
| `unreadable` (detail `time` or `memory`) | worker | no | yes |
| `storage_unavailable` | worker (original cannot be read) | yes (transient) | yes |
| `document_space_full` | worker (commit) | no | yes |

A source whose latest ingestion job is `cancelled` shows the category `cancelled` (not a job category), retryable. The
retry rules for Milestone 1 and 2's categories are in research #14.

## Derived source status (research #1)

| Source | Latest `ingest_source` job | Status shown |
|---|---|---|
| `ready_at` set | any | `ready` |
| `ready_at` null | `queued` | `waiting` |
| `ready_at` null | `running` | `processing`, with the job's progress |
| `ready_at` null | `failed` | `failed`, with the job's category, message, hint, `retryable` |
| `ready_at` null | `cancelled` | `failed`, category `cancelled`, `retryable` |

For a ready source, the latest `refresh_embeddings` job, if `queued` or `running`, is shown as a refresh in progress; if
it `failed` or was `cancelled` after the source's latest successful refresh, as the last refresh failure. Embeddings
are **current** when `embedding_model` equals the configured embedding model, **out of date** when it differs, and
**unknown** (no provider configured) when none is configured (FR-033).

## Records in `@scrylux/core` (`schemas/source.ts`)

- `SourceRecord`: `id`, `threat_model_id`, `name`, `type`, `size_bytes`, `added_by` (`{ id, username }`), `added_at`,
  `status`, `progress` (when processing: `{ step: 'extract' | 'chunk' | 'embed', done?, total? }`), `failure`
  (`{ category, message, hint, retryable }` or null), `ready` (`{ at, text_chars, chunk_count, pages_without_text,
  embedding: { model, dimension, state: 'current' | 'out_of_date' | 'no_provider' } }` or null), `refresh` (`{ state:
  'queued' | 'running', progress }` or null), `refresh_failure` (as `failure`, or null), `refreshable` (bool).
- `SourceList`: `sources` (oldest first), `limits` (`{ max_bytes, per_threat_model, used_bytes, document_space_bytes }`).
- `ChunkRecord`: `id`, `position`, `start_offset`, `end_offset`, `text`, `pages` (`{ first, last }` or null), `lines`
  (`{ first, last }` or null), `heading` (or null).
- `ChunkPage`: `chunks`, `has_more`; query `ChunkPageQuery` (`offset` ≥ 0, `limit` 1–100, default 50).
- `SourceTextInput`: `{ title: string (1–200, trimmed), text: string (≥ 1 non-space character) }`, strict.
- `SourceFileName`: an upload's file name, checked at the boundary: 1–255 characters after trimming, no control
  character, extension `.md`, `.txt`, `.pdf` or `.docx` compared without case; its message never repeats the name.
- `JobKind` gains `ingest_source`, `refresh_embeddings`; `JobProgress.step` gains `extract`, `chunk`, `embed`;
  `JobFailureCategory` gains the categories above; `JobRecord` gains `threat_model_id` and `source_id` (nullable).
  `JobCreateInput` is unchanged (FR-045a).

## State transitions

```text
add ──► waiting ──claim──► processing ──commit (succeeded)──► ready ──refresh──► ready (refreshing) ──► ready
                    ▲            │                                                          │
                    │            ├─ transient (storage, provider, rate) and runs left ──► waiting (next run)
          retry ────┤            └─ failed / cancelled / lost (no runs left) / timed out ──► failed
                    └──────────── failed, if retryable
delete (any state) ──► gone: jobs cancelled, chunks removed, original removed now or by the sweep
```
