# Contract: settings

Every variable this milestone adds, all documented in `docs/install.md`'s table (FR-081). Each process checks the ones it
reads when it starts, and refuses to start with a message that names the variable and never its value (FR-052). Read by
`parseSourceConfig` (`apps/api/src/sources/config.ts`) and `parseStorageConfig` (`apps/api/src/storage/config.ts`).

## Sources and the document space

| Variable | Default | Allowed | Read by |
|---|---|---|---|
| `SOURCE_MAX_MB` | `10` | whole number, 1–100 | app |
| `SOURCES_PER_THREAT_MODEL` | `20` | whole number, 1–200 | app |
| `INGESTION_JOBS_PER_ACCOUNT` | `20` | whole number, 1–1,000 | app |
| `DOCUMENT_SPACE` | `2GB` | whole number and `MB` or `GB`, 100 MB to 10,000 GB | app and worker |
| `SOURCE_MAX_CHARS` | `1000000` | whole number, 1,000–10,000,000 | worker |

## Extraction (worker)

| Variable | Default | Allowed |
|---|---|---|
| `EXTRACT_TIME_LIMIT` | `120s` | whole number and `s` or `m`, 10 s to 30 m |
| `EXTRACT_MEMORY_MB` | `1024` | whole number, 128–8,192. Measured: a 10 MB PDF needs about 640 MB however little text it holds, a Word file of a million characters about 320 MB |
| `EXTRACT_UNPACKED_MB` | `50` | whole number, 1–1,000 |
| `EXTRACT_MAX_PAGES` | `2000` | whole number, 1–100,000 |

## Storage (app and worker, the same values)

| Variable | Default | Rules |
|---|---|---|
| `STORAGE_BACKEND` | `local` | `local` or `s3` |
| `STORAGE_DIR` | `storage` | local only; a directory, relative to the working directory or absolute; must be writable |
| `STORAGE_S3_BUCKET` | — | required with `s3`; a bucket name |
| `STORAGE_S3_PREFIX` | `scrylux/` | `s3` only; ends with `/`; letters, digits, `-`, `_`, `/` |
| `STORAGE_S3_REGION` | — | required with `s3` |
| `STORAGE_S3_ENDPOINT` | — | `s3` only; an `https://` address, or `http://` for a host on a private network (as `LLM_BASE_URL`) |
| `STORAGE_S3_FORCE_PATH_STYLE` | `false` | `true` or `false` |
| `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | — | **secrets**; both or neither; also read from the `DB_SECRET_ID` secret; without them, the SDK's default chain (the instance or task role) |

With `STORAGE_BACKEND=s3`, a process refuses to start while `AWS_ENDPOINT_URL`, any `AWS_ENDPOINT_URL_*`, any `AWS_S3_*`,
`AWS_USE_DUALSTACK_ENDPOINT` or `AWS_USE_FIPS_ENDPOINT` is set (research #10). Neither process contacts storage when it
starts.

## Which process gets what (added to the table in `docs/install.md`)

| Variables | app | worker |
|---|---|---|
| `SOURCE_MAX_MB`, `SOURCES_PER_THREAT_MODEL`, `INGESTION_JOBS_PER_ACCOUNT` | yes | — |
| `DOCUMENT_SPACE` | yes | yes |
| `SOURCE_MAX_CHARS`, `EXTRACT_*` | — | yes |
| `STORAGE_*` | yes | yes |
| **`STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`** | **yes** (it stores uploads) | **yes** |

## Compose files

Both gain a named volume `storage` mounted at `/app/apps/api/storage` in `app` and `worker`, and pass the variables above
with their defaults. The `db` service's image becomes `pgvector/pgvector:0.8.7-pg16-trixie` (pinned by digest in the
release file and in CI).
