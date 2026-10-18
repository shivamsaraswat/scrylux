# Scrylux

An open-source, self-hosted threat modeling platform, in early development.

The goal: give Scrylux the context of a project (design docs, a repository, Jira/Confluence) and get a threat model back, or build one by hand on a data-flow diagram. Both paths produce the same threat model, AI suggestions are always drafts with citations that a human accepts or rejects, and you bring your own LLM, including a fully local one, so nothing has to leave your network.

> **Current status: v0.1, the first release.** Phases 0 to 2 are built: Scrylux is a manual threat modeling tool you run yourself. Draw a system as a data-flow diagram, generate STRIDE threats from rules, work them to a decision, and take the result with you as a report, a Scrylux file, an OTM file, or into and out of Threat Dragon. Phases 3 onward (AI threat models from documents and code, integrations, enterprise features) are planned, not built. See the [changelog](CHANGELOG.md) for what v0.1 does and does not do, and the [releases](https://github.com/shivamsaraswat/scrylux/releases) page. The run instructions, environment variables and API documented here describe the app as it is.

## Screenshots

The fictional demo threat model ([`docs/demo/`](docs/demo/)), a small note-taking app, in Scrylux.

![The diagram editor: a fictional notes app with two nested trust boundaries, its data flows, and the number of open threats on every element](docs/images/diagram-editor.png)

![One element selected, the Notes API: its properties on the right, and under the diagram the threats of that element with their status, risk and source](docs/images/threats-for-element.png)

![The report: a risk summary and the data-flow diagram, ready to print or save as PDF](docs/images/report.png)

![Importing a threat model: the preview says what the file holds and that everything in it will be imported](docs/images/import-export.png)

<details>
<summary>Retaking the screenshots</summary>

They are pictures of the demo, taken by hand, and nothing checks that they are current: retake them when the interface changes.

1. Start Scrylux from a clone ([CONTRIBUTING.md](CONTRIBUTING.md) has the setup), sign in, create a project named `Scrylux demo (fictional)` and import [`docs/demo/notes-app.scrylux.json`](docs/demo/notes-app.scrylux.json) into it.
2. Use a browser window of **1400 × 900**. Crop each picture to the application area: no browser chrome, **no address bar, no account name** (crop below the page header), and nothing else on screen.
3. Take the four views and save them as PNG under `docs/images/` with these names:
   - `diagram-editor.png`: the threat model's **Diagram** tab after **Fit to view**, from the title down to the bottom of the canvas;
   - `threats-for-element.png`: select **Process: Notes API** in the elements list, then take from the top of the elements list down through the first few rows of the threat table;
   - `report.png`: download the HTML report, open the file, and take its top, through the diagram;
   - `import-export.png`: on the project's page, **Import threat model**, choose the demo file, and take the preview that says "Everything in this file will be imported."
4. Keep each file under **600 KB** and the folder under **3 MB** (optimise a PNG if you must); a check fails the build otherwise, and for a missing image or an empty description.

</details>

## Try the demo

A finished example, a **fictional** note-taking app, is attached to every release as `notes-app.scrylux.json` (and is in [`docs/demo/`](docs/demo/)).

1. Start Scrylux ([Quickstart](#quickstart)), sign in, and open a project (make one if you have none).
2. Choose **Import threat model** and pick `notes-app.scrylux.json`. The preview says what it holds; import it.
3. Look at the diagram and its two trust boundaries, filter the threats by element, and open the report.

[`docs/demo/`](docs/demo/) says what to look at. The demo describes no real system.

## Roadmap

Built one phase at a time; each phase ends with something usable.

| Phase | Goal | Release |
| --- | --- | --- |
| 0 ✅ | CRUD tracker for STRIDE threats, deployed to AWS | — |
| 1 ✅ | Re-platform to a TypeScript monorepo (React, Express, Postgres) with a real domain model: projects, threat models, diagram elements, threats, mitigations. Phase 0's learning data is dropped, not migrated | — |
| 2 ✅ | Manual threat modeling: data-flow-diagram editor with trust boundaries, rule-based STRIDE-per-element threat generation, threat lifecycle and risk scoring, reports, OTM and Threat Dragon import/export | v0.1 |
| 3 | AI threat models from uploaded docs or pasted text, with citations and human review. Bring your own LLM: Anthropic, OpenAI, Bedrock/Azure, or local models via Ollama/vLLM | v0.2 |
| 4 | Threat models from code repositories and IaC (Terraform, Kubernetes, compose), with drift detection as the code changes | v0.3 |
| 5 | Integrations: Jira/Confluence context, threats pushed as tickets, automatic design reviews on PRs and tickets, MCP server, CLI | v0.4 |
| 6 | Enterprise readiness: RBAC, SSO (OIDC/SAML), audit log, versioning and approvals, Helm chart | v1.0 |
| 7 | More methodologies and frameworks: LINDDUN, MAESTRO (agentic AI), attack trees, ATT&CK/CAPEC/CWE mapping, compliance mapping | v1.x |

## Limits

What v0.1 does not do, so that you can decide before you rely on it:

- **No roles.** Every account can read, change and delete every project and everything in it. Roles and single sign-on are planned for Phase 6.
- **No AI features.** Nothing reads documents or calls a language model yet; that is Phase 3.
- **One container with its database, and no TLS of its own.** Put a proxy that terminates TLS in front of it before anyone else can reach it.
- **The image is not signed**, and carries no build attestation or SBOM in this release; pin it by the digest on the release page. Verifiable release images are planned for Phase 6.
- **Open risks exist.** Scrylux keeps its own threat model, built in Scrylux, with what covers each risk and what is still open: [`docs/threat-model/`](docs/threat-model/).

More: the [changelog](CHANGELOG.md), the [releases](https://github.com/shivamsaraswat/scrylux/releases), the [demo threat model](docs/demo/), [Scrylux's own threat model](docs/threat-model/), the [contribution guide](CONTRIBUTING.md) and the [security policy](SECURITY.md).

## Quickstart

You need Docker with Compose. You do not need to clone this repository.

```sh
curl -fsSLO https://github.com/shivamsaraswat/scrylux/releases/download/v0.1.0/docker-compose.yml
docker compose up -d
```

(`…/releases/latest/download/docker-compose.yml` is the same file for the newest final release.)

Then open <http://localhost:3000> and sign in with `admin` / `admin`. Create a project, add a threat model, and draw your system, or
[try the demo](#try-the-demo) first.

- `docker compose down` stops it and **keeps** your data, which lives in the `pgdata` volume.
- `docker compose down -v` stops it and **wipes** your data.

**Choosing a version.** The file starts the version of the release it came from. To start another: `SCRYLUX_VERSION=0.1.0 docker compose up -d`.
A published version never changes. `latest` exists too, for those who ask for it by hand; the file never uses it for you.

**Upgrading.** Back up first: `docker compose exec db pg_dump -U postgres threats > backup.sql`. Then choose the next version and start it.
Migrations only move forward and run when the app starts; there is no downgrade. The [changelog](CHANGELOG.md) says what each release
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

## Run from source (contributors)

```sh
docker compose up --build
```

Then open <http://localhost:3000> and sign in with `admin` / `admin` (the compose defaults). Create a project, add a threat model to it, and add threats and mitigations. You stay signed in until you log out (or 30 days pass, or 7 days go by without use); **Sign out everywhere** ends every session of your account.

The API is there too: `GET /health` returns `200 {"status":"ok"}`, and [API.md](API.md) walks through logging in and building a threat model with curl.

Override the defaults by exporting variables before `docker compose up` (or putting them in a `.env` file next to `docker-compose.yml`): `DB_PASSWORD`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `PORT`.

Data lives in the `pgdata` volume. `docker compose down -v` wipes it.

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

If you're used to this project's pre-Phase-1 npm commands, here's the mapping:

| Old (npm, single package) | New (pnpm workspace) |
| --- | --- |
| `npm install` | `pnpm install` |
| `npm start` | `pnpm --filter @scrylux/api start` |
| `npm run migrate` | `pnpm --filter @scrylux/api migrate` |
| `npm test` | `pnpm run test` (whole workspace) or `pnpm --filter @scrylux/api test` (API only) |

## Development (contributing)

This is a pnpm workspace. The packages are:

| Package | What it holds |
| --- | --- |
| `apps/api` | The Express API. It also serves the built web app, and holds the browser-session endpoints |
| `apps/web` | The React web app: sign-in, projects, threat models, the data-flow diagram editor (React Flow), threats and mitigations. Built with Vite, tested with Vitest and Playwright |
| `packages/db` | The forward-only SQL migrations (the threat-model schema), the migration runner, and the tests that check the schema's integrity rules against a real Postgres |
| `packages/core` | The shared definitions of projects, threat models, elements, threats and mitigations (Zod schemas, value lists, risk scoring). It has no Node.js dependencies, so the web app can use it too |
| `packages/threat-library` | The STRIDE-per-element threat rules, as plain YAML files, and the code that checks them and works out which candidate threats apply to a diagram element. The rule engine reads it from Phase 2 Milestone 3. See its [README](packages/threat-library/README.md) |

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

The tests, and the browser tests further down, read a gitignored `.env.test` at the repository root (CI supplies the same values as job variables instead). After copying `.env.example`, set `DB_PASSWORD=devpassword` (the database password in `docker-compose.yml`) and replace the other `change-me` values with local-only values, for example `JWT_SECRET=local-only-not-a-secret` and `ADMIN_PASSWORD=admin`. `DB_HOST=localhost` is already right. [CONTRIBUTING.md](CONTRIBUTING.md) walks through the full setup.

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
(Dependabot) run continuously but don't block merging. See [docs/ci.md](docs/ci.md) for what each
check does, how to reproduce a failure locally, and how every repository setting behind this is
configured.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | no | `3000` | HTTP listen port |
| `DB_HOST` | yes | — | Postgres host |
| `DB_PORT` | no | `5432` | Postgres port |
| `DB_NAME` | yes | — | Database name |
| `DB_USER` | yes | — | Database user |
| `DB_PASSWORD` | yes | — | Database password |
| `DB_SECRET_ID` | no | — | Id of an AWS Secrets Manager secret to read at startup, using the instance or task role. Its JSON keys override the matching environment values: `host`, `port`, `dbname`, `username`, `password`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`. Unset, the app reads the environment only |
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

### Behind a load balancer or reverse proxy

Set `TRUST_PROXY` (`1` behind one ALB). Without it every client appears to come from the proxy's address, so the per-address sign-in limit applies to everyone at once, and the session cookie may miss `Secure`. Browser sign-in also checks that the request's `Origin` matches the host the app sees, so the proxy must forward the original host: keep `Host` (nginx: `proxy_set_header Host $host;`) or send `X-Forwarded-Host`, which is honoured only from a trusted proxy. A proxy that rewrites `Host` and sends nothing else makes every sign-in a 403. The AWS ALB keeps `Host` and needs nothing extra. Terminate TLS at the proxy: the session cookie is marked `Secure` when the page was loaded over HTTPS.

If `ADMIN_USERNAME`/`ADMIN_PASSWORD` are unset, no user is seeded and nobody can log in. Once logged in, any user can create more users (`POST /api/users`). There are no roles: any logged-in user can also read, change and delete every project and everything in it. There is no user edit or delete.

## API

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/health` | no | Liveness; does not touch the DB |
| POST | `/api/login` | no | `{username, password}` → `{token}` (for API clients). Failed attempts are throttled: `429` |
| POST | `/api/session` and `/api/session/{refresh,logout,logout-all}` | cookie | The browser's sign-in and session. Used by the web app, not meant for scripts. See [API.md](API.md) |
| POST | `/api/users` | Bearer | `{username, password}` → `{id, username}`; password 8–72 bytes |
| | `/api/v1/…` | Bearer | Projects, threat models, elements, threats and mitigations: create, read, update, delete and list, generating threats from a diagram, downloading a report of a threat model as Markdown or HTML, and exporting a threat model as a Scrylux or OTM file and importing a Scrylux, OTM or Threat Dragon file (32 operations) |
| GET | `/api/v1/openapi.json` | Bearer | The OpenAPI 3.1 document for v1 |

The v1 request bodies are validated, ids are UUIDs, and lists come oldest first. The original `/api/threats` endpoints are gone.

Send the token as `Authorization: Bearer <token>`. See [API.md](API.md) for every operation, the fields, curl examples and error codes, and [`apps/api/openapi.json`](apps/api/openapi.json) for the OpenAPI document. The file formats Scrylux exports and imports (its own lossless file, [Open Threat Model](https://github.com/iriusrisk/OpenThreatModel) and OWASP Threat Dragon) are described in [`docs/formats/`](docs/formats/), with the Scrylux file's JSON Schema.

## Deployment

- Config is entirely environment variables; nothing is read from local files.
- Logs go to stdout/stderr.
- Point the load balancer health check at `/health`.
- The compose defaults for `JWT_SECRET` and passwords are for local use only — set real values in any deployed environment.
- The app reads its secrets from AWS Secrets Manager when configured to (see `apps/api/src/config.ts`).
- **Memory:** give the host at least **2 GiB** if it will hold large threat models. Exporting or importing the largest one Scrylux allows (1,000 elements, about 15,000 threats) takes the API about 500 to 650 MB while it runs, on top of about 110 MB at rest, and two at once about 700 MB. A 1 GiB host (such as a `t3.micro`) is fine for ordinary use, but it is not promised to survive several large exports or imports at the same time. Lowering the 64 MiB import limit would not help: memory follows the number of records.

A reference deployment (ALB → private EC2 → RDS, Secrets Manager, CloudWatch) has been run against this app on AWS; a generic public write-up isn't published yet.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, and note that everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

To report a vulnerability, follow [SECURITY.md](SECURITY.md). Report it privately, never in a public issue.

Scrylux's own threat model, built in Scrylux, is in [`docs/threat-model/`](docs/threat-model/); [start with the report](docs/threat-model/report.md).

## License

Scrylux is licensed under the [Apache License 2.0](LICENSE). In short, you may use, modify and distribute it, including commercially. In return you keep the license and copyright notices and state your changes, and the license includes an express patent grant from contributors.

The container image also carries the license notices of the web app's bundled dependencies, at `apps/web/dist/.vite/license.md`.
