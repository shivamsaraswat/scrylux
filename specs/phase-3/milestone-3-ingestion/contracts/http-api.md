# Contract: the source routes

Eight operations under `/api/v1`, defined with `defineOperation` (the two adds with the new `upload` form, research #9),
so the router and the generated OpenAPI document describe the same routes. Every one needs sign-in (an `/api/login`
token or a browser access token), answers errors as `{ "error": string }` with fixed text, and is open to every signed-in
account (FR-065). Records are those of [data-model.md](../data-model.md#records-in-scryluxcore-schemassourcets).

Statuses common to all: `401` (not signed in), `404` (no such threat model or source), `500`. A source's name, text and
chunks appear only in `SourceRecord.name` and `ChunkRecord.text`; no error answer holds them (SC-008).

## `GET /threat-models/{id}/sources`

`200 SourceList`: the threat model's sources, oldest first, and the limits the add form shows. No paging: at most
`SOURCES_PER_THREAT_MODEL` rows.

## `POST /threat-models/{id}/sources`: upload a file

`multipart/form-data` with exactly one part, `file`, whose filename gives the source's name and extension. `201
SourceRecord`, status `waiting`; its `ingest_source` job is queued.

| Status | When | `error` (fixed text, numbers from settings) |
|---|---|---|
| `400` | no `file` part, another part, a file name refused by `SourceFileName` (empty, over 255 characters, a control character, no supported extension), an empty file, text not UTF-8 or holding a NUL | e.g. "This text file is not UTF-8. Save it as UTF-8 and upload it again." |
| `409` | no embedding provider configured | "Adding documents needs an embedding provider. Ask the operator to set EMBEDDING_PROVIDER." |
| `409` | same content already a source of this threat model | "This document is already a source of this threat model: <name of that source>." |
| `409` | the threat model already has `SOURCES_PER_THREAT_MODEL` sources | "This threat model already has 20 sources, the most allowed." |
| `413` | larger than `SOURCE_MAX_MB` (checked from `Content-Length` before reading, and while reading) | "The file is larger than 10 MB, the most allowed." |
| `415` | first bytes are not those of the extension's type; `.doc`; an OLE container under `.docx` | "This file is not a PDF." / "This is an encrypted Word file or an older .doc. Upload an unprotected .docx." |
| `429` | the account has `INGESTION_JOBS_PER_ACCOUNT` ingestion jobs queued or running; `Retry-After` | "You already have 20 documents being processed. Wait for one to finish." |
| `503` | 4 uploads are already being read by this process; `Retry-After: 5` | "Scrylux is busy reading other uploads. Try again in a few seconds." |
| `507` | the document space would be passed | "The document space of this install is full. Delete sources, or ask the operator to raise DOCUMENT_SPACE." |

The `409` for a duplicate names the existing source: it is a name the person can already see on the same threat model.
When that source has failed, the answer adds "Delete it first to add this document again." A non-retryable failure would
otherwise leave the same bytes impossible to add.

## `POST /threat-models/{id}/sources/text`: paste text

JSON `SourceTextInput` (`{ title, text }`), body limit twice `SOURCE_MAX_MB`. `201 SourceRecord` of type `text`. The same
refusals as the upload, except `415`; `413` when the text's UTF-8 size passes the limit.

## `GET /sources/{id}`

`200 SourceRecord`.

## `GET /sources/{id}/chunks?offset=&limit=`

`200 ChunkPage`: the chunks in position order, `limit` 1–100 (default 50). `409` "This source is not ready yet." while it
is not ready, so no part of a set is ever served (FR-024).

## `POST /sources/{id}/retry`

No body. Queues a new `ingest_source` job for a failed source, or a new `refresh_embeddings` job for a ready source whose
last refresh failed, with fresh caps. `200 SourceRecord`. `409` when the source is not failed and has no failed refresh,
when its failure is not retryable (research #14: "This failure comes from the document itself. Fix the document and add
it again." / "Retrying would reach the same cap. Ask the operator to raise JOB_TOKEN_CAP or JOB_COST_CAP." / "This
embedding model does not accept Scrylux's chunk size. Ask the operator to choose another."), or when no embedding
provider is configured; `429`, `507` as for the upload.

## `POST /sources/{id}/refresh`

No body. Queues a `refresh_embeddings` job for a ready source whose embeddings are out of date (FR-034). `200
SourceRecord`. `409` when the source is not ready, its embeddings are current, a refresh is already queued or running, or
no embedding provider is configured; `429` as for the upload.

## `DELETE /sources/{id}`

`204`. In one transaction: lock the source, cancel its queued or running jobs (Milestone 2's cancel, recorded as by the
signed-in account), delete it with its chunks. Then remove its original, if it still has one; a failure there is left to
the sweep (FR-055). Deleting a threat model (`DELETE /threat-models/{id}`) or a project (`DELETE /projects/{id}`),
both unchanged routes, gains the same: lock the sources they reach `FOR UPDATE ORDER BY id`, collect their original
keys, delete, then remove the originals (research #2).

## Changes to existing routes

- `POST /jobs`: unchanged schema, so `ingest_source` and `refresh_embeddings` are refused with its `400` (FR-045a).
- `GET /jobs`, `GET /jobs/{id}`: `JobRecord` gains `threat_model_id` and `source_id`.
- Milestone 2's limit of active jobs per account no longer counts the two new kinds (FR-043).

## Write log

Every add, retry, refresh and delete writes one line: `{ "event": "source", "action": "add" | "retry" | "refresh" |
"delete", "account": <id>, "source": "<uuid>", "threat_model": "<uuid>", "type": "pdf", "size_bytes": 123 }`. No name,
no text (FR-061).
