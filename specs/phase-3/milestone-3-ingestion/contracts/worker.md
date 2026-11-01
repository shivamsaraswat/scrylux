# Contract: the ingestion kinds and the extraction child

## `ingest_source`

Input `{ source_id }`. Needs an embedding provider (FR-047). Progress steps, in order:

1. **`extract`**: read the original from storage (`storage_unavailable`, transient, if it cannot be read); for `pdf` and
   `docx`, run the extraction child; for text types, decode in the worker. Every type is then normalized (line breaks,
   NUL removed, lone surrogates replaced, research #6). Text past `SOURCE_MAX_CHARS` code points → `too_large`/`chars`.
2. **`chunk`**: split into chunks of at most 2,000 characters (research #7). No request is made.
3. **`embed`**, with `done`/`total` chunks: 64 chunks per `llm.embed` request, each after `beforeRequest` (the gate and
   the caps) and followed by `record` (its usage).
4. **Commit** (in `finishRun`'s transaction, research #2): lock the source (gone → the outcome is `cancelled`), take the
   document-space lock, check the space (`document_space_full`), the fenced job update, then, only if it succeeded,
   insert the chunks in batches of 500 and set the source's ready facts and `original_key = NULL`.
5. After the commit: delete the original (a failure is left to the sweep).

Kinds' result (`jobs.result`): `{ "chunks": n, "pages_without_text": n | null }`: counts only (M2 FR-051).

## `refresh_embeddings`

Input `{ source_id }`. Steps `embed` (as above, over the stored chunks in order) and the commit, which replaces every
chunk's embedding and the source's `embedding_model`, `embedding_dimension` and `stored_bytes`, after the same locks and
space check. It never reads the original, which is gone (FR-057).

## The extraction child (`apps/api/src/extract/child.ts` → `dist/extract/child.js`)

Started by `extract/run.ts` with `child_process.fork`:

| Option | Value |
|---|---|
| `env` | `{}` |
| `execArgv` | `['--max-old-space-size=<¾ of EXTRACT_MEMORY_MB>']`, plus `['--import', 'tsx']` when running from source |
| `stdio` | `['ignore', 'ignore', 'ignore', 'ipc']` |
| `serialization` | `'advanced'` |

Messages:

- Worker → child, once: `{ type: 'pdf' | 'docx', bytes: Uint8Array, limits: { maxPages, unpackedBytes, memoryBytes } }`.
- Child → worker, once: `{ ok: true, blocks: Block[], pagesWithoutText: number | null }` where `Block` is `{ text,
  page?: number, isHeading?: boolean }` in reading order (as built: a heading block is marked, and its text is the heading); or `{ ok: false, category: 'unsupported_type' | 'encrypted' |
  'damaged' | 'no_text_found' | 'too_large' | 'too_large_unpacked' | 'unreadable', detail?: 'memory' | 'pages' }`. The
  child then exits.
- As built, a run that is stopped while the child reads (a cancel, the deadline, a lost job, a hand-back) rejects the read with an
  `ExtractAborted` that holds the stop reason, and the child is killed; `no_text_found` is decided by the worker from an answer with no
  text, not by the child.
- The worker `SIGKILL`s the child when `EXTRACT_TIME_LIMIT` passes (`unreadable`/`time`), when the run's signal aborts
  (the run's stop reason wins), or when the child sends a second message.
- An exit with no answer is read as:

  | Exit | Category |
  |---|---|
  | code 3 (the child's memory check) | `unreadable`/`memory` |
  | `SIGABRT` (V8 out of heap), or a `SIGKILL` the worker did not send (the kernel's out-of-memory killer) | `unreadable`/`memory` |
  | the worker's own `SIGKILL` at the time limit | `unreadable`/`time` |
  | anything else | `damaged` |

The child imports only `extract/pdf.ts`, `extract/docx.ts` and their libraries: no config, database, storage, provider or
logging module. Two import-graph tests, extending Milestone 2's: the child's graph has none of those modules, and the
API's (`server.ts`) has no `extract/` module and none of `pdfjs-dist`, `yauzl` or `saxes` (FR-010).

## Logs

Milestone 2's job lines, unchanged (ids, kind, state, totals). One sweep line (contracts/storage.md). No line holds a
name, text, chunk, key, path or bucket.
