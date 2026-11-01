# Development

For people changing Scrylux. [CONTRIBUTING.md](../CONTRIBUTING.md) has the rules for a pull request; back to the [README](../README.md).

## Run from source

```sh
docker compose up --build
```

Then open <http://localhost:3000> and sign in with `admin` / `admin` (the compose defaults). Create a project, add a threat model to it, and add threats and mitigations. You stay signed in until you log out (or 30 days pass, or 7 days go by without use); **Sign out everywhere** ends every session of your account.

The API is there too: `GET /health` returns `200 {"status":"ok"}`, and [API.md](../API.md) walks through logging in and building a threat model with curl.

Override the defaults by exporting variables before `docker compose up` (or putting them in a `.env` file next to `docker-compose.yml`): `DB_PASSWORD`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `PORT`.

Compose starts three services: `db`, `app`, and a `worker` that runs background jobs from the same image: the provider check on the **Jobs** page and the reading of documents added to a threat model (which also needs an embedding provider). Nothing else needs the worker, so `docker compose up --build app db` is enough for everything except jobs and documents. From source, `pnpm --filter @scrylux/api worker` starts one; see [Running the worker](install.md#running-the-worker). `pnpm test` runs the job and document tests one file at a time (they share the database with whatever else is queued). The browser tests for jobs and for documents each start their own app, worker and stand-in provider, and `pnpm test:e2e` runs them after the other browser tests, one at a time, because a worker takes any job in the shared database; the documents one makes a certificate for its stand-in provider with `openssl`, which CI's runner has.

Data lives in the `pgdata` volume, and the originals of documents that are still being read in the `storage` volume. `docker compose down -v` wipes both.

If you're used to this project's pre-Phase-1 npm commands, here's the mapping:

| Old (npm, single package) | New (pnpm workspace) |
| --- | --- |
| `npm install` | `pnpm install` |
| `npm start` | `pnpm --filter @scrylux/api start` |
| `npm run migrate` | `pnpm --filter @scrylux/api migrate` |
| `npm test` | `pnpm run test` (whole workspace) or `pnpm --filter @scrylux/api test` (API only) |

## Workspace and tests

This is a pnpm workspace. The packages are:

| Package | What it holds |
| --- | --- |
| `apps/api` | The Express API. It also serves the built web app, and holds the browser-session endpoints |
| `apps/web` | The React web app: sign-in, projects, threat models, the data-flow diagram editor (React Flow), threats and mitigations. Built with Vite, tested with Vitest and Playwright |
| `packages/db` | The forward-only SQL migrations (the threat-model schema), the migration runner, and the tests that check the schema's integrity rules against a real Postgres |
| `packages/core` | The shared definitions of projects, threat models, elements, threats and mitigations (Zod schemas, value lists, risk scoring). It has no Node.js dependencies, so the web app can use it too |
| `packages/threat-library` | The STRIDE-per-element threat rules, as plain YAML files, and the code that checks them and works out which candidate threats apply to a diagram element. The rule engine reads it from Phase 2 Milestone 3. See its [README](../packages/threat-library/README.md) |
| `packages/llm` | How Scrylux asks a language model for a validated structured result or for embeddings, behind one interface and four provider adapters (Anthropic, OpenAI-compatible, Amazon Bedrock, Google Gemini), with the prices and prompts it needs as plain files. The worker sends the chunks of the documents added to a threat model through it, to make their embeddings; nothing else sends user content yet |

Workspace packages are read as TypeScript source by the type checker, the linter, the tests and
`tsx`, and as compiled JavaScript inside the Docker image. Running this takes no extra build step.

Requires Node.js 22+. Running with an unsupported Node version fails fast with a
clear engine-mismatch error before anything else runs.

```sh
corepack enable            # gives you the exact pnpm version this repo pins (packageManager)
docker compose up -d db    # only the database — the DB-backed tests below need it running
pnpm install
cp .env.example .env.test  # once, then edit it (see below)
pnpm run typecheck
pnpm run lint
pnpm run test
```

The tests, and the browser tests further down, read a gitignored `.env.test` at the repository root (CI supplies the same values as job variables instead). After copying `.env.example`, set the database password to the one in `docker-compose.yml` and replace the other `change-me` values with local-only values of your own. `DB_HOST=localhost` is already right. [CONTRIBUTING.md](../CONTRIBUTING.md) walks through the exact values and the full setup.

To run the web app while you work on it, start the API and Vite in two terminals. Vite proxies `/api` to the API, and serves the app on <http://localhost:5173>:

```sh
pnpm --filter @scrylux/api dev
pnpm --filter @scrylux/web dev
```

The Vite dev server does not apply the content security policy. That is only checked against the built app, by the browser tests:

```sh
pnpm run build
pnpm --filter @scrylux/web verify:build    # the built page has no inline code or data: URIs
pnpm --filter @scrylux/web exec playwright install chromium    # once
pnpm run test:e2e                          # Playwright, against the built app and a real database
```

Each of the four `pnpm run` commands above fans out to every workspace package
(`pnpm -r run <script>`), so this stays a single set of top-level commands even as more packages
are added later. `pnpm run test` migrates and seeds a fresh test database itself, so this works
even on a database volume that's never been started before.

The tests need a role that can create databases (the `postgres` user in `docker-compose.yml` and in
CI can). `packages/db`'s tests drop and recreate a database called `scrylux_db_test`, and create and
drop short-lived `scrylux_upgrade_*` databases, on the server `DB_HOST` points to, so never point
`pnpm test` at a server that holds anything that matters. `apps/api`'s own tests still use
`DB_NAME` itself, and insert rows into it on every run.

### CI

Every pull request to `main` runs the same four commands above, plus a container build, as
required checks (`typecheck`, `lint`, `test`, `docker-build`) — `main` only accepts pull requests,
and none of the four can be skipped or bypassed. Static analysis (CodeQL) and dependency updates
(Dependabot) run continuously but don't block merging. See [docs/ci.md](ci.md) for what each
check does, how to reproduce a failure locally, and how every repository setting behind this is
configured.
