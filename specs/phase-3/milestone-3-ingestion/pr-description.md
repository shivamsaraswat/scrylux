# Phase 3 Milestone 3: ingestion

A threat model can now hold the design documents it was built from. A person adds `.md`, `.txt`, `.pdf` and `.docx` files, or pastes text, on a new **Sources** tab. The worker reads each one in a child process that holds no secret, cuts the text into consecutive chunks of at most 2,000 characters, embeds every chunk and writes the chunks and their embeddings in one fenced transaction. The original is kept (on a local volume or in an S3-compatible bucket) only until the document is ready, then deleted, and no route ever returns it. Nothing is drafted from a document yet, and nothing sends one to a generation model: the text goes to the embedding provider and the database only.

## Security implications (Development Workflow: document ingestion, a new process, storage credentials, new routes)

- **Document ingestion.** Untrusted PDF and Word files are parsed by the worker. A file's type comes from its first bytes. The parse runs in a forked child with an empty environment and no standard streams (so no database password, provider key or storage credential, and nothing a library prints reaches the log), under a time, a memory, an unpacked-size and a page bound; nothing in a file is evaluated, fetched or run (pdf.js 6 has no evaluation option left, and a test fails if one returns; a test listens for a request from a file that points at an address and finds none). The API never loads a parser: `apps/api/test/worker/imports.test.ts` keeps `extract/`, `pdfjs-dist`, `yauzl` and `saxes` out of the server's import graph.
- **Eight authenticated routes** under `/api/v1`: `GET`/`POST /threat-models/{id}/sources`, `POST …/sources/text`, `GET /sources/{id}`, `GET /sources/{id}/chunks`, `POST /sources/{id}/retry`, `POST /sources/{id}/refresh`, `DELETE /sources/{id}`. Uploads are read in a bounded way, only a few at once, after authentication.
- **Broadening (FR-065, FR-080):** any signed-in account can read, retry, refresh and delete every document, and documents are confidential by nature. No roles exist before Phase 6; the constitution records it as a justified widening.
- **Storage credentials.** With `STORAGE_BACKEND=s3`, the S3 access key and secret (or the instance or task role) are held by **both** the app (it stores uploads) and the worker (it reads, lists and deletes). The documentation gives one least-privilege IAM policy per process. A key kept in the shared `DB_SECRET_ID` secret reaches the app as the provider keys already do. Either process refuses to start while an `AWS_ENDPOINT_URL`, `AWS_ENDPOINT_URL_*`, `AWS_S3_*`, dual-stack or FIPS variable is set (checked in the built image).
- **User content now reaches a provider** (a document's chunks, for embeddings). Principle VI's notice ships here: the Sources tab names the provider and says the text leaves the install, in the form before the submit control and again above the list, on every visit, and says the text stays when every provider is local.
- Constitution **1.16.0**; `docs/threat-model/` rebuilt by its procedure in a running Scrylux (59 elements, 373 threats), with 56 rule-derived threats decided for the document reader, document storage and records and seven data flows, seven threats of the model as a whole, and three earlier entries revised. **The model stays marked approved from Milestone 2; the Milestone 3 additions await your approval** (the README says so and its dates are unchanged).

## What changes for every install

- **The database image changes** from `postgres:16-alpine` to `pgvector/pgvector:0.8.7-pg16-trixie` (pinned by digest in the release file, CI and the upgrade script). pgvector publishes Debian images only, and Debian sorts text by different rules than Alpine, so an existing volume's text indexes would silently return wrong answers. **Migration 017 rebuilds the indexes of every earlier table** in its transaction. `scripts/check-db-upgrade.sh`, a new step of the required `test` job, proves it on a volume made by the old image: 017 first refuses there with its message and changes nothing; on the new image `amcheck` must then report broken indexes (the negative control; it reported three: `users_username_key`, `projects_name_key`, `threat_models_name_key`); after 017 every B-tree index passes `bt_index_check(index, true)` and no row is lost. The script stops with status 2 and asks you if the negative control ever finds nothing.
- **The vector extension is required.** On a managed database an administrator may have to run `CREATE EXTENSION vector;`. Without it Scrylux stops at start-up with one of two fixed messages and changes nothing. `docs/install.md#upgrading-to-v02` covers it.
- New `storage` volume in both compose files, eighteen new optional variables, a `Dockerfile` that creates `/app/apps/api/storage` owned by `node`.
- Adding a document needs an embedding provider; everything else works as before with none, and with no worker.

## Decisions to review

From clarification and planning (the spec carries them):

- **Embeddings are required** to add a document, so a document never exists without them. An out-of-date source can be refreshed without changing a chunk, and a source never holds two models' vectors.
- **Two storage backends**, local volume and S3-compatible, behind one small interface; the original is deleted when the document is ready, and a sweep (at worker start and every ten minutes, one hour of grace) removes what a failed removal left, so an original is gone within an hour and ten minutes of its deletion while a worker runs.
- **A separate per-account limit** for documents waiting or processing (`INGESTION_JOBS_PER_ACCOUNT`, 20), apart from Milestone 2's `JOBS_PER_ACCOUNT`, which does not count them; and **one install-wide `DOCUMENT_SPACE`** (2 GB), counting text and embeddings, checked when a document is added and again before it is made ready.
- A source's **status is derived** from its latest job, not stored. Lock order everywhere: the threat model or source row, then the account lock, then the document-space lock, then the job rows.
- **Chunks** are consecutive, at most 2,000 code points, with no overlap; `no_text_found` is decided by the worker, not the child.

From implementation:

- **`EXTRACT_MEMORY_MB` defaults to 1024, not 512.** Measured in the child: a 10 MB PDF needs about 640 MB however little text it holds, a Word file of a million characters about 320 MB. The configuration contract and the install table say so.
- pdf.js 6 has **no `isEvalSupported` option** (it no longer has the code path of CVE-2024-4367), so research #4's setting does not exist; `test/extract/pdfjs-no-eval.test.ts` fails if a version brings evaluation back.
- `JobDetail` gained an `ingestion` field (counts only) beside the provider check's `result`. `storage_unavailable` is a transient failure category, so a storage that is down is tried again.
- The storage is chosen once per process (`useStorage`, as the database pool is), not passed to `createApp`.
- **Playwright now has three projects**: the specs that start a worker of their own (`jobs`, `sources`) run after the rest, one after the other, because a worker takes any job in the shared database. The browser suite needs `openssl` (the new spec makes a certificate for its hosted-provider stand-in); CI's runner has it.
- The threat model's delete dialog now says it also deletes documents (one string, and the spec that asserts it).
- Two tests that were flaky once the suite grew were made deterministic: the ingestion step sampler is now a database trigger, and the extension test's scratch pools no longer raise an unhandled event when their database is dropped.
- **The eval gate does not apply**: no prompt, adapter or generation changed, and the harness arrives in Milestone 7.

## Verification

`pnpm run typecheck`, `pnpm run lint` (licence check: 206 shipped packages), `pnpm run build`, the built-UI check, `pnpm run test` (2,140 API, 811 web, 632 llm, 485 core, 362 db, 314 threat-library, 288 scripts), `pnpm run test:e2e` (63) and `scripts/check-db-upgrade.sh` pass; `docker build .` passes and the image was smoke-run from `docker-compose.release.yml` with no storage settings and no provider: app and worker healthy, no storage error in the worker's log, the sweep ran, and adding a document was refused with the embedding-provider `409`. The suites run against the pgvector image, as CI does. One run of the browser suite on a busy machine failed five of the 1,000-element performance specs on timing; they passed alone and in the next full run.

## Live runs (T093)

**2026-11-01, this development host (Apple silicon, Docker Desktop), the built image from `docker-compose.release.yml`, local Ollama, `nomic-embed-text`, declared local:**

- A four-page PDF (one page without text), a Word file with a heading and a table, and a pasted text each became ready in seconds; the chunks matched the documents (the PDF's chunk spans pages 1 to 4, the Word chunk carries its heading, the pasted one its lines); the volume held no original afterwards.
- The **largest default file** (a 10 MB PDF, 899,971 characters, 529 chunks) went from upload to ready in **21 seconds**, in 9 embedding requests of 293,333 input tokens, with the job's usage on the Jobs page.
- With the worker stopped, an added document left one original in the volume and the Jobs status said no worker was alive; deleting the document left none.
- In the built image, both processes refuse `AWS_ENDPOINT_URL_S3` with `STORAGE_BACKEND=s3`, naming it.
- `scripts/check-db-upgrade.sh` (quickstart §5): passed as described above.

**2026-11-01, hosted Gemini, `gemini-embedding-2`, the key given to the `worker` service only** (exported in the maintainer's shell, never written to a file; the built image from `docker-compose.release.yml`, an isolated compose project):

- The status the Sources tab reads reported the embedding provider as hosted; the key variable was in the worker container (1) and absent from the app container (0).
- A PDF, a Word file and a pasted text became ready, one chunk each. Each job made one request: 14, 20 and 28 input tokens, costing $0.000003, $0.000004 and $0.000006 (price list). No originals were left in storage afterwards, and no app, worker or database log line contained the key.

**2026-11-01, S3-compatible storage, `adobe/s3mock` (a real S3 server, path-style, over plain http on a private host), the built image, local Ollama:** `STORAGE_BACKEND=s3` with dummy keys on both services. With the worker stopped, two uploads put two objects in the bucket; deleting one removed its object; starting the worker made the other document ready (one chunk) and left the bucket empty; with the server stopped, an upload was refused with the fixed 503 message ("Document storage is unavailable…"), and no app or worker log line held the bucket, the endpoint or a key. So the AWS SDK's requests (put, get, delete, list) work against a real server and not only the in-process stub.

**2026-11-01, the IAM policies of `docs/install.md`, checked without an AWS account** (`apps/api/test/storage/iam-policies.test.ts`): the test reads the two policies out of the documentation, runs what the app does (put, delete) and what the worker does (get, list the prefix, delete) with the real AWS client against the S3 stub, and evaluates every request it made by IAM's rules (action, resource and the `s3:prefix` condition). Every request is allowed by its process's policy, each process uses every action its policy grants and no other, neither process can do what only the other needs, and neither reaches another prefix of a shared bucket. This shows the policies are sufficient and minimal for the requests Scrylux makes; it is not AWS evaluating them, so a bucket policy, a service control policy or a KMS key on the bucket can still refuse (the documentation now names the KMS permissions).

**2026-11-01, SC-002 on a t3.micro-like host** (the smallest the deployment guide names: 1 GiB, 2 vCPUs): one container limited to 900 MB running the app **and** the worker, the database in another container as RDS would be, local Ollama for the embeddings. The largest default file (a 10,285,838-byte PDF of 989,960 characters, 582 chunks) went from upload to ready in **24 s** with 2 CPUs and **28 s** with 0.4 CPUs (a t3.micro's baseline once its burst credits are gone). The container's peak memory was 206 and 212 MiB, it was never OOM-killed, and the app and worker stayed up. Two caveats: embeddings came from a local model, so a hosted provider's network time is added (the hosted Gemini run above took a few seconds for three tiny documents); and the test PDF is cheap to parse. The 1,024 MB default of `EXTRACT_MEMORY_MB` was set from a heavier file, so a real 10 MB PDF with many objects can need more than this one did, which is why the documentation says to plan memory for it.

**Not done:** AWS S3 itself and AWS evaluating the policies (no account here).
