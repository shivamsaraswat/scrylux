# Install and run

The [README](../README.md) has the two commands that start Scrylux. This page has the rest.

## Quickstart, in full

You need Docker with Compose. You do not need to clone this repository.

```sh
curl -fsSLO https://github.com/shivamsaraswat/scrylux/releases/download/v0.1.0/docker-compose.yml
docker compose up -d
```

(`…/releases/latest/download/docker-compose.yml` is the same file for the newest final release.)

Then open <http://localhost:3000> and sign in with `admin` / `admin`. Create a project, add a threat model, and draw your system, or
[try the demo](demo/) first.

- `docker compose down` stops it and **keeps** your data, which lives in the `pgdata` volume.
- `docker compose down -v` stops it and **wipes** your data.

**Choosing a version.** The file starts the version of the release it came from. To start another: `SCRYLUX_VERSION=0.1.0 docker compose up -d`.
A published version never changes. `latest` exists too, for those who ask for it by hand; the file never uses it for you.

**Upgrading.** Back up first: `docker compose exec db pg_dump -U postgres threats > backup.sql`. Then choose the next version and start it.
Migrations only move forward and run when the app starts; there is no downgrade. The [changelog](../CHANGELOG.md) says what each release
changes. **Going from v0.1 or from a build before v0.2 to v0.2 changes the database image:** read [Upgrading to v0.2](#upgrading-to-v02) first.

> **Before you expose this anywhere else**
>
> The defaults above are for trying Scrylux on your own machine.
>
> - Set `DB_PASSWORD`, `JWT_SECRET`, `ADMIN_USERNAME` and `ADMIN_PASSWORD` (export them, or put them in a `.env` file next to
>   `docker-compose.yml`). Anyone who knows `JWT_SECRET` can forge a login token, and `admin` / `admin` is public knowledge.
> - Scrylux does **not** terminate TLS. Put a proxy that does in front of it, and set `TRUST_PROXY` (see
>   [Behind a load balancer or reverse proxy](#behind-a-load-balancer-or-reverse-proxy)). The [Deployment](#deployment) section lists what a deployed install needs.
> - The app is published on `127.0.0.1` only, so only your machine can reach it. To change that on purpose, edit the `ports:` line of
>   the app service, and do it only after the steps above. The database publishes no port and should keep publishing none.

## Run without Docker

Requires Node 22+, pnpm, and a reachable PostgreSQL **13 or newer** (CI and `docker compose` use 16) that has the **pgvector** extension, which documents store their embeddings in. The migrations enable it (`CREATE EXTENSION vector`), so the database user needs the right to, or an administrator runs that once; without it Scrylux stops at start-up and says so ([Upgrading to v0.2](#upgrading-to-v02)).

```sh
pnpm install
cp .env.example .env   # edit values, then export them into your shell
pnpm --filter @scrylux/api start
```

The app does not read `.env` itself — export the variables (e.g. `set -a; source .env; set +a`) or set them in your process manager.

On startup the app applies any pending SQL files from `packages/db/migrations/` (tracked in a `schema_migrations` table) and creates/updates the admin user. `pnpm --filter @scrylux/api migrate` runs only the migrations. Background jobs and the reading of documents are done by a second process, which you start yourself: `pnpm --filter @scrylux/api worker` ([Running the worker](#running-the-worker)). With the default `STORAGE_BACKEND=local`, both processes must be able to write the directory `STORAGE_DIR` (default `storage`, relative to the directory they run in) and must see the same one; see [Documents and storage](#documents-and-storage). `pnpm run test` runs the whole workspace's test suite.

The original threat tracker was removed in Phase 1 Milestone 5. On the first start after upgrading, a migration drops its entries (the `threat_entries` table) and the `legacy_threat_links` table, and deletes the "Imported" project that an earlier version created from those entries, with everything inside it. Nothing is exported first: those entries were throwaway data. User accounts, and any project that did not come from that import, are untouched.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | no | `3000` | HTTP listen port |
| `DB_HOST` | yes | — | Postgres host |
| `DB_PORT` | no | `5432` | Postgres port |
| `DB_NAME` | yes | — | Database name |
| `DB_USER` | yes | — | Database user |
| `DB_PASSWORD` | yes | — | Database password |
| `DB_SECRET_ID` | no | — | Id of an AWS Secrets Manager secret to read at startup, using the instance or task role. Its JSON keys override the matching environment values: `host`, `port`, `dbname`, `username`, `password`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `LLM_API_KEY`, `EMBEDDING_API_KEY`. Unset, the app reads the environment only |
| `JWT_SECRET` | yes | — | Secret for signing login tokens; app refuses to start without it |
| `JWT_EXPIRES_IN` | no | `8h` | Lifetime of a token from `POST /api/login` (API clients). Browser sessions use `SESSION_MAX_LIFETIME` instead |
| `ADMIN_USERNAME` | no | — | Login user, created/updated on startup |
| `ADMIN_PASSWORD` | no | — | Password for that user. Changing it ends that user's browser sessions; restarting with the same password does not |
| `SESSION_MAX_LIFETIME` | no | `30d` | The longest a browser session lasts from sign-in. Format: a whole number and one of `s`, `m`, `h`, `d` |
| `SESSION_IDLE_TIMEOUT` | no | `7d` | A browser session unused for this long ends. Same format; must not exceed `SESSION_MAX_LIFETIME` |
| `SIGN_IN_FAILURES_PER_ACCOUNT` | no | `5` | Failed sign-ins for one username from one address before that pair is slowed down |
| `SIGN_IN_FAILURES_PER_ADDRESS` | no | `50` | Failed sign-ins from one address (any usernames) before it is slowed down. An IPv6 address counts as its /64 |
| `SIGN_IN_BASE_WAIT` | no | `30s` | The first wait after the threshold; it doubles with each further failure |
| `SIGN_IN_MAX_WAIT` | no | `15m` | The longest wait, and how long failures are remembered |
| `TRUST_PROXY` | no | — (trust none) | Behind a load balancer or reverse proxy, set this, or sign-in throttling sees every client as the proxy. `1` trusts one proxy hop (a single ALB); a comma-separated list of addresses or CIDR ranges also works. `true` is refused |

| `LLM_PROVIDER` | no | — (AI off) | Which provider writes text for the AI features: `anthropic`, `openai-compatible` (OpenAI, Azure OpenAI, Ollama, vLLM), `bedrock` or `gemini`. Unset, there is no AI feature and Scrylux never connects to a model provider. See [AI providers](ai-providers.md) |
| `LLM_MODEL` | with `LLM_PROVIDER` | — | The provider's model id. For Azure OpenAI, the name of your deployment |
| `LLM_BASE_URL` | with `openai-compatible` | — | The provider's address, for example `https://api.openai.com/v1`, `https://<resource>.openai.azure.com/openai/v1/` or `http://ollama:11434/v1`. It must be `https` unless `LLM_LOCAL=true`. Not accepted for the other providers |
| `LLM_API_KEY` | with `anthropic` or `gemini`, for the worker; optional with `openai-compatible` | — | The provider's API key. **Give it to the worker only**: the app does not use it and starts without it. Also read from the `DB_SECRET_ID` secret, which both processes read (see [Which process gets what](#which-process-gets-what)). Not accepted for `bedrock`, which uses the AWS credentials of the host |
| `LLM_LOCAL` | no | `false` | `true` says the `openai-compatible` provider runs on your own hardware, so data sent to it stays in your install. Scrylux cannot check this, so it is your statement. Any other provider is always hosted, and `true` for it stops Scrylux from starting |
| `LLM_REGION` | with `bedrock` | — | The AWS region, for example `us-east-1`. Bedrock's credentials come from the instance or task role, or the usual `AWS_*` variables |
| `EMBEDDING_PROVIDER` | no | — (embeddings off) | Which provider turns text into embeddings: `openai-compatible`, `bedrock` or `gemini`. Optional even when `LLM_PROVIDER` is set |
| `EMBEDDING_MODEL` | with `EMBEDDING_PROVIDER` | — | For example `text-embedding-3-small`, `nomic-embed-text`, `amazon.titan-embed-text-v2:0` or `gemini-embedding-001` |
| `EMBEDDING_BASE_URL` | with `openai-compatible` | — | As `LLM_BASE_URL` |
| `EMBEDDING_API_KEY` | as `LLM_API_KEY` | the `LLM_API_KEY` | Used for the same provider at the same address when unset. Also read from the `DB_SECRET_ID` secret |
| `EMBEDDING_LOCAL` | no | `false` | As `LLM_LOCAL` |
| `EMBEDDING_REGION` | with `bedrock` | — | As `LLM_REGION` |
| `LLM_TIMEOUT` | no | `300s` | The longest one request to a provider may take, for generation and embeddings alike: a whole number and `s` or `m`, from `10s` to `60m` |
| `LLM_PRICE_INPUT` | no | — | US dollars per million input tokens, to cost a model that Scrylux's price list does not know, or to override it. Set it with `LLM_PRICE_OUTPUT` |
| `LLM_PRICE_OUTPUT` | no | — | US dollars per million output tokens |
| `EMBEDDING_PRICE_INPUT` | no | — | US dollars per million input tokens for the embedding model |
| `JOB_TOKEN_CAP` | no | `500000` | The most tokens one background job may use, over all its runs, from 1 to 1,000,000,000. Each job gets a copy when it is queued; a job stops before any request that could take it past the cap. See [Background jobs](#running-the-worker) |
| `JOB_COST_CAP` | no | `5` | The most one job may cost, in US dollars (above 0, at most 10,000, up to 6 decimals). The cap cannot be applied to a request whose model has no known price; the token cap still is |
| `JOB_MAX_RUNS` | no | `3` | How many times a job runs at most, from 1 to 5. A job runs again after a failure that may pass (the provider is unavailable or limiting requests) or when its worker is lost |
| `JOB_TIME_LIMIT` | no | `60m` | The longest a job lives once it first starts, runs and waits together: a whole number and `s`, `m` or `h`, from `1m` to `24h` |
| `JOBS_PER_ACCOUNT` | no | `3` | How many jobs one account may have queued or running at once, from 1 to 100 |
| `PROVIDER_CHECK_COOLDOWN` | no | `5m` | How long an account must wait between provider checks, counted from when the last one was queued, even if it was cancelled: `0` turns it off, otherwise a whole number and `s`, `m` or `h`, up to `24h` |
| `WORKER_CONCURRENCY` | no | `1` | How many jobs one worker runs at once, from 1 to 32 (the worker reads it) |
| `WORKER_HEALTH_PORT` | no | `3001` | The port of the worker's `/health` (the worker reads it). The compose files check port 3001: change both together |
| `SOURCE_MAX_MB` | no | `10` | The largest file that may be added as a document, from 1 to 100 MB. See [Documents and storage](#documents-and-storage) |
| `SOURCES_PER_THREAT_MODEL` | no | `20` | How many documents one threat model may hold, from 1 to 200 |
| `INGESTION_JOBS_PER_ACCOUNT` | no | `20` | How many documents one account may have waiting or being processed at once, from 1 to 1,000. It is separate from `JOBS_PER_ACCOUNT`, which does not count them |
| `DOCUMENT_SPACE` | no | `2GB` | What every document may take together, text and embeddings counted, as a whole number and `MB` or `GB`: from `100MB` to `10000GB`. The app refuses a document that would pass it, and the worker refuses to make one ready that would |
| `SOURCE_MAX_CHARS` | no | `1000000` | The most text one document may hold once read, from 1,000 to 10,000,000 characters (the worker reads it). A longer one fails as too large; no part of it is kept |
| `EXTRACT_TIME_LIMIT` | no | `120s` | The longest reading one PDF or Word file may take: a whole number and `s` or `m`, from `10s` to `30m` (the worker reads it) |
| `EXTRACT_MEMORY_MB` | no | `1024` | The most memory reading one file may use, from 128 to 8,192. A 10 MB PDF needs about 640 MB however little text it holds, and a Word file of a million characters about 320 MB (the worker reads it) |
| `EXTRACT_UNPACKED_MB` | no | `50` | The most the parts of a Word file that are read may unpack to, from 1 to 1,000 MB (the worker reads it) |
| `EXTRACT_MAX_PAGES` | no | `2000` | The most pages of one PDF, from 1 to 100,000 (the worker reads it) |
| `STORAGE_BACKEND` | no | `local` | Where the files that are being processed are kept: `local` (a directory) or `s3` (an S3-compatible service). Both processes need the same value |
| `STORAGE_DIR` | no | `storage` | `local` only: a directory, relative to the working directory (`/app/apps/api/storage` in the image) or absolute. Both processes must be able to write it, which the `storage` volume of the compose files does |
| `STORAGE_S3_BUCKET` | with `s3` | — | The bucket. Give Scrylux a bucket of its own, or a prefix of its own in one: it deletes what it finds under its prefix that has the shape of its files |
| `STORAGE_S3_PREFIX` | no | `scrylux/` | `s3` only: ends with `/`, letters, digits, `-`, `_` and `/` |
| `STORAGE_S3_REGION` | with `s3` | — | The bucket's region |
| `STORAGE_S3_ENDPOINT` | no | — | `s3` only: the address of a service other than AWS S3 (MinIO, Ceph, R2…): `https://`, or `http://` for a host on a private network |
| `STORAGE_S3_FORCE_PATH_STYLE` | no | `false` | `s3` only: `true` for services that need `host/bucket/key` addresses |
| `STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY` | no | — | **Secrets**, `s3` only, both or neither. Also read from the `DB_SECRET_ID` secret. Without them the AWS SDK's default chain is used: the instance or task role. Both processes use them |

Scrylux refuses to start with a bad AI, job, document or storage setting, and says which variable, never its value. The worker also needs the provider key that the provider takes; the app starts without it. It also refuses while a provider is configured and a variable that the provider libraries read on their own is set (for example `OPENAI_API_KEY`); [AI providers](ai-providers.md) lists them.

### Behind a load balancer or reverse proxy

Set `TRUST_PROXY` (`1` behind one ALB). Without it every client appears to come from the proxy's address, so the per-address sign-in limit applies to everyone at once, and the session cookie may miss `Secure`. Browser sign-in also checks that the request's `Origin` matches the host the app sees, so the proxy must forward the original host: keep `Host` (nginx: `proxy_set_header Host $host;`) or send `X-Forwarded-Host`, which is honoured only from a trusted proxy. A proxy that rewrites `Host` and sends nothing else makes every sign-in a 403. The AWS ALB keeps `Host` and needs nothing extra. Terminate TLS at the proxy: the session cookie is marked `Secure` when the page was loaded over HTTPS.

If `ADMIN_USERNAME`/`ADMIN_PASSWORD` are unset, no user is seeded and nobody can log in. Once logged in, any user can create more users (`POST /api/users`). There are no roles: any logged-in user can also read, change and delete every project and everything in it. There is no user edit or delete.

## Running the worker

The worker runs jobs off the request path, such as the provider check on the **Jobs** page, so that nothing waits on a model while a page is open. It is a second process started from the **same image** as the app, with another command:

```sh
node dist/worker.js                      # in the image (WORKDIR /app/apps/api)
pnpm --filter @scrylux/api worker        # from source
```

Both compose files already run it as a `worker` service next to `app`. To run more of them, scale the service: `docker compose up -d --scale worker=2`. Any number can run against one database: each job is run by one worker at a time, a worker that stops hands its jobs back, and a job held by a worker that crashed comes back to the queue within a minute or so. Each worker runs `WORKER_CONCURRENCY` jobs at once.

- **No worker, no problem for the rest.** Manual threat modeling, reports and imports never use the worker. Without one, jobs wait in the queue; the Jobs page says that no worker is processing jobs.
- **Health check:** the worker answers `GET /health` with 200 on `WORKER_HEALTH_PORT` (default 3001) while the process is up. It needs no authentication and touches neither the database nor a provider, like the app's. Nothing else is served on it, and the compose files do not publish it.
- **Caps:** `JOB_TOKEN_CAP` and `JOB_COST_CAP` bound one job, not your spend over time. A person can start a provider check every `PROVIDER_CHECK_COOLDOWN`, and any account can create more accounts, so set a spending limit on the provider account too.
- **Stopping:** on `SIGTERM` the worker takes no new job, lets running jobs go on for up to 30 seconds, then hands back the ones still running; they run again on another worker. A second signal stops it at once.
- **Logs** go to stdout, one JSON line per event, with ids and counts and never content, a prompt, a key or an address.
- **Records:** every job and every request it made are kept in the database, with its tokens and cost, until you delete them yourself. They are small, and the cooldown limits how quickly provider checks add to them.

### Which process gets what

| Setting | App | Worker |
| --- | --- | --- |
| `DB_*`, `DB_SECRET_ID` | yes | yes |
| `JWT_SECRET`, `ADMIN_*`, `TRUST_PROXY`, `PORT`, session and sign-in settings | yes | no |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL`, `LLM_LOCAL`, `LLM_REGION` and the `EMBEDDING_` ones, `LLM_TIMEOUT`, the prices | yes, to report them | yes |
| **`LLM_API_KEY`, `EMBEDDING_API_KEY`** | **no** | **yes** |
| `JOB_*`, `JOBS_PER_ACCOUNT`, `PROVIDER_CHECK_COOLDOWN` | yes: it copies the caps, runs and time limit onto each job and checks the limits | yes: it checks them |
| `WORKER_CONCURRENCY`, `WORKER_HEALTH_PORT` | checked | used |
| `SOURCE_MAX_MB`, `SOURCES_PER_THREAT_MODEL`, `INGESTION_JOBS_PER_ACCOUNT` | yes: it checks the limits when a document is added | no |
| `DOCUMENT_SPACE` | yes | yes |
| `SOURCE_MAX_CHARS`, `EXTRACT_*` | no | yes |
| `STORAGE_*` | yes: it stores the uploads | yes: it reads them and removes them |
| **`STORAGE_S3_ACCESS_KEY_ID`, `STORAGE_S3_SECRET_ACCESS_KEY`** | **yes** (it stores uploads) | **yes** |

The worker is the only process that sends a request to a provider, so it is the only one that needs a key. Give the keys to the `worker` service alone, as both compose files do. A key kept in the secret named by `DB_SECRET_ID` is the exception: both processes read that secret for the database credentials, so a key in it reaches the app as well, though the app never uses it. To keep a key from the app, set it in the worker's environment instead.

With the keys on the worker, `docker compose exec app node dist/llm-check.js` reports a missing key, which is expected. Run the operator's check in the worker's container: `docker compose exec worker node dist/llm-check.js` ([AI providers](ai-providers.md)).

## Documents and storage

From v0.2 a threat model can hold **documents**: design documents, as `.md`, `.txt`, `.pdf` and `.docx` files or pasted text. Scrylux reads each one, cuts its text into chunks of at most 2,000 characters and gives each chunk an embedding, which later releases search. **Adding documents needs an embedding provider** (`EMBEDDING_PROVIDER`, [AI providers](ai-providers.md)) and a running worker; without them, everything else works as before and the Sources tab says what is missing.

### Storage

A file is stored only while it is being processed. The worker deletes it as soon as the document is ready, and the text and chunks stay in the database; a person can never download the original. What is kept until then is where `STORAGE_BACKEND` points.

- **`local`** (the default) keeps files in `STORAGE_DIR`. The app and the worker must both write it, so they must share a host or a filesystem. The compose files mount the named volume `storage` at `/app/apps/api/storage` in both, and the image creates that directory owned by the `node` user.
- **`s3`** keeps them in an S3-compatible service: AWS S3, MinIO, Ceph, R2 and others. Give Scrylux **a bucket of its own, or a prefix of its own** (`STORAGE_S3_PREFIX`): the worker lists that prefix and deletes the objects it finds there that have the shape of Scrylux's files (`<prefix>sources/<uuid>`), and nothing else. Neither process contacts the service when it starts, and each refuses to start while a variable the AWS client would read on its own (`AWS_ENDPOINT_URL`, `AWS_ENDPOINT_URL_*`, `AWS_S3_*`, `AWS_USE_DUALSTACK_ENDPOINT`, `AWS_USE_FIPS_ENDPOINT`) is set, so that no environment variable can send a document somewhere you did not choose.

Give each process the least access that its job needs. For a bucket `my-bucket` and the default prefix, the app needs

```json
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": ["s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::my-bucket/scrylux/sources/*" }]
}
```

and the worker needs

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::my-bucket/scrylux/sources/*" },
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::my-bucket", "Condition": { "StringLike": { "s3:prefix": "scrylux/sources/*" } } }
  ]
}
```

Turn on the bucket's encryption at rest (AWS S3 does by default); Scrylux adds none of its own. If the bucket uses a customer-managed KMS key, the app also needs `kms:GenerateDataKey` and the worker `kms:Decrypt` on that key; the policies above do not grant them. Deleting removes the current object only: a bucket with **versioning**, or a snapshot of the volume, keeps older copies by design, so keep versioning off for this prefix or expire old versions. Both processes also hold the bucket's credentials when you give them as `STORAGE_S3_ACCESS_KEY_ID` and `STORAGE_S3_SECRET_ACCESS_KEY`; with an instance or task role they hold none.

**Deleting.** Deleting a document, a threat model or a project removes its originals at once. If storage is down at that moment, the deletion still succeeds, and the worker's sweep, which runs when it starts and every 10 minutes, removes anything older than an hour that no document needs. So a file is gone at most **1 hour 10 minutes** after its deletion, provided a worker is running.

### The document space

`DOCUMENT_SPACE` bounds what every document takes in the database, text and embeddings together. A chunk takes its text (about 1.5 KB for a full one) plus 4 bytes for each dimension of its embedding, so the default `2GB` holds about 400 MB of text at 1,536 dimensions, about 220 MB at 3,072 dimensions, and about 670 MB at 768. Raise it only with the database's disk in mind; Scrylux counts what it stores, not what Postgres uses on disk.

### Reading files safely

The worker reads each PDF or Word file in a child process of its own, started with no environment, so it holds no database password, provider key or storage credential, and a flaw in a parser has none to lose. The child is stopped when it passes `EXTRACT_TIME_LIMIT`, `EXTRACT_MEMORY_MB`, `EXTRACT_UNPACKED_MB` (the parts of a Word file are checked against what their headers declare, and against what they really unpack to) or `EXTRACT_MAX_PAGES`; the document fails with the bound it passed, and the worker's other jobs go on. Nothing a file points at is fetched or run: not a link, an external image, a font, a macro or a script.

- **Memory.** Plan for the worker to need `EXTRACT_MEMORY_MB` (1 GiB by default) for each file being read, on top of about 110 MB for the worker itself, and `WORKER_CONCURRENCY` files can be read at once. The bounds are Scrylux's own; **a memory limit on the container remains the last line**.
- **Network.** The child still has the worker's network access, because Node offers no sandbox for it. If that matters, limit the worker's egress to your embedding provider and your storage with a container network policy.
- **Order of work.** A document takes minutes at most: the largest default (10 MB) is ready within five minutes on a small host, most in seconds, and `JOB_TOKEN_CAP` bounds what its embeddings may use. Text in scripts that take many tokens per character (Chinese, Japanese, Korean) reaches that cap sooner, so a large document in one of them may need a higher `JOB_TOKEN_CAP`.

## Upgrading to v0.2

v0.2 stores embeddings in PostgreSQL with the **pgvector** extension, and pgvector's only published image is Debian-based, where v0.1 and Milestone 2 ran on `postgres:16-alpine`. Moving the same data volume from one to the other is supported, with these things to know:

1. **Back up first**: `docker compose exec db pg_dump -U postgres threats > backup.sql`. There is no downgrade.
2. **Keep the volume.** Do not use `docker compose down -v`. Download the new `docker-compose.yml`, whose `db` service uses the pgvector image, and `docker compose up -d`. The image re-owns the data directory for its own `postgres` user when it starts as root, which is the official image's behavior, so nothing needs changing by hand. The file also adds the `storage` volume for [documents](#documents-and-storage).
3. **The first start rebuilds every index.** Debian sorts text by its own rules and Alpine by another, so the indexes of a moved volume are in the wrong order and would silently return wrong answers. Migration `017_sources.sql` rebuilds the indexes of every table that exists before it, inside its own transaction: a few seconds for an ordinary install. The app and the worker migrate before they seed the admin user or serve anything, and CI proves on a volume made by the old image that every index is repaired and no row is lost ([how](ci.md#the-database-upgrade-check)).
4. **A database you manage yourself** (RDS, Cloud SQL, your own server) needs the `vector` extension. Run `CREATE EXTENSION vector;` in the Scrylux database **as an administrator** before starting v0.2, if the user Scrylux connects as may not do it. Check that your service offers pgvector. Without it, Scrylux stops at start-up with one of two messages and changes nothing:
   - `This database does not have the pgvector extension, which Scrylux needs from v0.2. See docs/install.md#upgrading-to-v02` — the server has no pgvector installed.
   - `This database has the pgvector extension, but the database user Scrylux connects as may not enable it. Run CREATE EXTENSION vector; in this database as an administrator, then start Scrylux again. See docs/install.md#upgrading-to-v02` — it is installed, and an administrator has to enable it once.
5. **PostgreSQL 13 or newer** is still enough, with pgvector installed.

The first start with documents adds new variables, all optional ([Environment variables](#environment-variables)); an install that sets none of them runs as before, on the local volume, and only needs an embedding provider to add documents.

## Deployment

- Config is entirely environment variables; nothing is read from local files. The one thing Scrylux keeps on disk is the originals of documents that are still being read, with `STORAGE_BACKEND=local`, in `STORAGE_DIR`. The app and the worker must share it, so on more than one host (an app and a worker on separate instances or tasks) set `STORAGE_BACKEND=s3` instead ([Documents and storage](#documents-and-storage)). Give the worker memory for reading files: 1 GiB for each at the default `EXTRACT_MEMORY_MB`.
- Logs go to stdout/stderr.
- Point the load balancer health check at `/health`. A worker has its own, on `WORKER_HEALTH_PORT` (see [Running the worker](#running-the-worker)).
- The compose defaults for `JWT_SECRET` and passwords are for local use only — set real values in any deployed environment.
- The app reads its secrets from AWS Secrets Manager when configured to (see `apps/api/src/config.ts`).
- **Memory:** give the host at least **2 GiB** if it will hold large threat models. Exporting or importing the largest one Scrylux allows (1,000 elements, about 15,000 threats) takes the API about 500 to 650 MB while it runs, on top of about 110 MB at rest, and two at once about 700 MB. A 1 GiB host (such as a `t3.micro`) is fine for ordinary use, but it is not promised to survive several large exports or imports at the same time. Lowering the 64 MiB import limit would not help: memory follows the number of records.

A reference deployment (ALB → private EC2 → RDS, Secrets Manager, CloudWatch) has been run against this app on AWS; a generic public write-up isn't published yet.

## Licenses in the image

The container image carries the license notices of the web app's bundled dependencies, at `apps/web/dist/.vite/license.md`, and each dependency of the API and the worker keeps its own license file in its folder under `node_modules` in the image (for example `node_modules/pdfjs-dist/LICENSE`, Apache-2.0). The libraries v0.2 adds to read documents and talk to storage are pdf.js (Apache-2.0), yauzl (MIT), saxes (ISC), busboy (MIT) and the AWS SDK for S3 (Apache-2.0). Scrylux itself is under the [Apache License 2.0](../LICENSE).
