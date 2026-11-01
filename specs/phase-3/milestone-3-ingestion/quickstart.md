# Quickstart: validating ingestion

How to prove the milestone works. §1 runs in CI with no provider and no secret (FR-083); §2–§5 are by hand.

## Prerequisites

- The dev database on the new image: `docker compose up -d db` (now `pgvector/pgvector:0.8.7-pg16-trixie`). An existing
  dev volume from the old image is migrated as in §5.
- `pnpm install` (it skips `@napi-rs/canvas`, research #4).

## 1. Automated suites

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e`, plus the upgrade check (§5) in CI's `test`
job. What each part proves:

| Area | Test location | Proves |
|---|---|---|
| Migration 017 | `packages/db/test/` | tables and checks of [data-model.md](./data-model.md); `SX001`/`SX002` messages (FR-091) |
| Settings | `apps/api/test/sources/config.test.ts`, `test/storage/config.test.ts` | every variable of [contracts/configuration.md](./contracts/configuration.md) refused when bad, named not echoed (FR-052); the AWS variable guard and its `sdk-env`-style list |
| Storage | `apps/api/test/storage/` | one suite run on the local backend and on the S3 stub; key pattern; the sweep's rule and its 1-hour grace (FR-055, SC-005) |
| Type checks at upload | `apps/api/test/sources/sniff.test.ts` | first-byte checks, UTF-8, OLE container (FR-003) |
| Extraction | `apps/api/test/extract/` | each fixture's text, pages, headings, `pages_without_text`; `.docm`, encrypted, scanned, damaged, `<!DOCTYPE`, unpack bomb, page limit, time and memory bounds (the memory check, a V8 abort and an outside kill) through the real child; a text layer with NUL; the child's empty environment and import graph; the API's import graph free of `extract/` and the parsers (FR-010–FR-014, SC-004) |
| Chunking | `apps/api/test/sources/chunk.test.ts` | ≤ 2,000 code points, contiguity, exact reconstruction, an astral character and a lone surrogate, lines counted on CRLF/BOM input, headings (FR-020–FR-022, SC-003) |
| Kinds | `apps/api/test/sources/ingest.test.ts`, `ingest-failures.test.ts`, `ingest-delete.test.ts`, `ingest-refresh.test.ts` | progress steps; caps fit at the largest default size (SC-002, timed); `cap_reached`; `input_too_large` hint; `document_space_full` at commit; lost run and retry write each chunk once (SC-006); delete during a run; cancel from the Jobs page; refresh keeps ids and text (FR-034, SC-007) |
| Routes | `apps/api/test/contract/v1/sources*.test.ts` | every status of [contracts/http-api.md](./contracts/http-api.md); `POST /jobs` refuses the new kinds; retry rules (SC-012), two retries at once queue one job; document space (SC-013); 4-upload guard; a non-ASCII file name; threat model and project deletion remove originals; write-log lines |
| Sweep and start-up | `apps/api/test/worker/sweep.test.ts`, `apps/api/test/startup-process.test.ts`, `apps/api/test/worker/startup.test.ts` | the worker sweeps at start and at an interval; each process refuses a bad source or storage setting by name, never by value (FR-052, FR-055) |
| IAM policies | `apps/api/test/storage/iam-policies.test.ts` | the two policies of `docs/install.md` allow every request the app and the worker make, and no other (research #10) |
| Canary | `apps/api/test/worker/canary.test.ts` (extended) | fake text, name and key absent everywhere but the source's own record and chunks (SC-008) |
| Web | `apps/web/src/pages/SourcesTab.test.tsx`, `SourcePage.test.tsx` | notice wording per configuration, no form without embeddings, one-at-a-time uploads, refetch only while active, text rendered as text |
| Browser | `apps/web/e2e/sources.spec.ts` | upload → ready → chunks → delete with its own API, worker and stub; the notice on screen before submit (SC-009) |
| Regression | the existing suites | v0.1 and Milestone 2 flows with no worker and no provider (SC-001) |

## 2. A local install end to end

```sh
docker compose up -d                      # db, app, worker, with the storage volume
# .env: EMBEDDING_PROVIDER=openai-compatible, EMBEDDING_BASE_URL=http://host.docker.internal:11434/v1,
#       EMBEDDING_MODEL=nomic-embed-text, EMBEDDING_LOCAL=true   (Ollama on the host)
```

Sign in, open a threat model's **Sources** tab, check the notice says the text stays in the install, upload a PDF and a
`.docx`, and paste a text. Each becomes ready within a few minutes; open one and compare its chunks with the document.
Delete one and check `docker compose exec app ls storage/sources` no longer lists its original (the ready ones are
already gone).

## 3. A hosted provider

Set `EMBEDDING_PROVIDER=openai-compatible`, `EMBEDDING_BASE_URL=https://api.openai.com/v1`, `EMBEDDING_MODEL=
text-embedding-3-small` and the key on the worker. Check the notice names the provider and says the text leaves the
install. Ingest a document; the Jobs page shows the job's usage and cost.

## 4. S3-compatible storage

Run MinIO (`docker run -p 9000:9000 minio/minio server /data`), create a bucket, and set `STORAGE_BACKEND=s3`,
`STORAGE_S3_BUCKET`, `STORAGE_S3_REGION=us-east-1`, `STORAGE_S3_ENDPOINT=http://host.docker.internal:9000`,
`STORAGE_S3_FORCE_PATH_STYLE=true` and the two keys on both services. Ingest and delete a document and watch the bucket.
Set `AWS_ENDPOINT_URL_S3` and check that both services refuse to start, naming it.

## 5. Upgrading a v0.1 database volume

`scripts/check-db-upgrade.sh` does this in CI. By hand: stop the stack with the v0.1 release file, change the `db`
image to the new one, start `db`, then the app. Check the app's log shows the migrations applied, the threat models are
all there, and:

```sql
CREATE EXTENSION IF NOT EXISTS amcheck;
SELECT bt_index_check(c.oid, true) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_am a ON a.oid = c.relam WHERE a.amname = 'btree' AND c.relnamespace = 'public'::regnamespace;
```

returns without error. Against the old image, the app must stop with the `SX001` message instead. The script also runs
the same check on the new image *before* 017 and expects it to fail on the broken indexes (the negative control,
research #15).
