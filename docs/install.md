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
changes.

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

Requires Node 22+, pnpm, and a reachable PostgreSQL **13 or newer** (CI and `docker compose` use 16).

```sh
pnpm install
cp .env.example .env   # edit values, then export them into your shell
pnpm --filter @scrylux/api start
```

The app does not read `.env` itself — export the variables (e.g. `set -a; source .env; set +a`) or set them in your process manager.

On startup the app applies any pending SQL files from `packages/db/migrations/` (tracked in a `schema_migrations` table) and creates/updates the admin user. `pnpm --filter @scrylux/api migrate` runs only the migrations. `pnpm run test` runs the whole workspace's test suite.

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
| `LLM_API_KEY` | with `anthropic` or `gemini`; optional with `openai-compatible` | — | The provider's API key. Also read from the `DB_SECRET_ID` secret. Not accepted for `bedrock`, which uses the AWS credentials of the host |
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

Scrylux refuses to start with a bad AI setting, and says which variable. It also refuses while a provider is configured and a variable that the provider libraries read on their own is set (for example `OPENAI_API_KEY`); [AI providers](ai-providers.md) lists them.

### Behind a load balancer or reverse proxy

Set `TRUST_PROXY` (`1` behind one ALB). Without it every client appears to come from the proxy's address, so the per-address sign-in limit applies to everyone at once, and the session cookie may miss `Secure`. Browser sign-in also checks that the request's `Origin` matches the host the app sees, so the proxy must forward the original host: keep `Host` (nginx: `proxy_set_header Host $host;`) or send `X-Forwarded-Host`, which is honoured only from a trusted proxy. A proxy that rewrites `Host` and sends nothing else makes every sign-in a 403. The AWS ALB keeps `Host` and needs nothing extra. Terminate TLS at the proxy: the session cookie is marked `Secure` when the page was loaded over HTTPS.

If `ADMIN_USERNAME`/`ADMIN_PASSWORD` are unset, no user is seeded and nobody can log in. Once logged in, any user can create more users (`POST /api/users`). There are no roles: any logged-in user can also read, change and delete every project and everything in it. There is no user edit or delete.

## Deployment

- Config is entirely environment variables; nothing is read from local files.
- Logs go to stdout/stderr.
- Point the load balancer health check at `/health`.
- The compose defaults for `JWT_SECRET` and passwords are for local use only — set real values in any deployed environment.
- The app reads its secrets from AWS Secrets Manager when configured to (see `apps/api/src/config.ts`).
- **Memory:** give the host at least **2 GiB** if it will hold large threat models. Exporting or importing the largest one Scrylux allows (1,000 elements, about 15,000 threats) takes the API about 500 to 650 MB while it runs, on top of about 110 MB at rest, and two at once about 700 MB. A 1 GiB host (such as a `t3.micro`) is fine for ordinary use, but it is not promised to survive several large exports or imports at the same time. Lowering the 64 MiB import limit would not help: memory follows the number of records.

A reference deployment (ALB → private EC2 → RDS, Secrets Manager, CloudWatch) has been run against this app on AWS; a generic public write-up isn't published yet.

## Licenses in the image

The container image carries the license notices of the web app's bundled dependencies, at `apps/web/dist/.vite/license.md`. Scrylux itself is under the [Apache License 2.0](../LICENSE).
