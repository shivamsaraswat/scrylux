# Contributing to Scrylux

Thanks for wanting to help. Scrylux is an open-source, self-hosted threat modeling platform, built
one phase at a time. This guide covers how to set up, what a good change looks like, and what the
project asks of you.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a
vulnerability, read [SECURITY.md](SECURITY.md) and **never** open a public issue for it.

## Before you start

- **Open an issue first** for anything larger than a small fix, so we can agree on the approach
  before you spend time on it. Use the bug report or feature request form.
- **Larger features are specified before they are built.** Each milestone has a folder under
  [`specs/`](specs/), grouped by roadmap phase (`specs/phase-<N>/milestone-<M>-<name>/`), with its
  spec, plan and tasks (for example `specs/phase-1/milestone-6-react-app-shell/`). Read a recent
  one to see the shape. A feature request is the place to start that conversation.
- **Stay within the current phase.** The roadmap is in [docs/roadmap.md](docs/roadmap.md).
  Scrylux is built phase by phase, and work on a later phase's features is not accepted while an
  earlier phase is in progress.

## Setup

You need Node.js 22 or newer, [Corepack](https://github.com/nodejs/corepack), and PostgreSQL 13 or
newer. Corepack comes with Node.js 22 and 24. From Node.js 25 it no longer does, so install it
first with `npm install -g corepack`. The simplest way to get a database is Docker Compose. A PostgreSQL of your own needs the [pgvector](https://github.com/pgvector/pgvector) extension installed, and a role that may run `CREATE EXTENSION vector` (the migrations enable it, and refuse to run without it), because documents store their embeddings there. The compose `db` service is pgvector's image, so it has both.

```sh
corepack enable                     # gives you the exact pnpm version this repo pins
docker compose up -d db             # only the database (it has the pgvector extension); or point DB_HOST at your own PostgreSQL 13+ that has it
pnpm install --frozen-lockfile
```

Create the gitignored `.env.test` at the repository root. `pnpm test` and `pnpm test:e2e` read it
locally (CI supplies the same values as job variables):

```sh
cp .env.example .env.test
```

Then edit `.env.test`: set `DB_PASSWORD=devpassword` (the database password in
`docker-compose.yml`), and replace the other `change-me` values with local-only values, for example
`JWT_SECRET=local-only-not-a-secret` and `ADMIN_PASSWORD=admin`. `DB_HOST=localhost` is already
right. Never commit this file.

[docs/development.md](docs/development.md) describes the workspace
layout and how to run the app while you work on it.

## Checks

Every pull request must pass these. They run in CI as required checks on `main`
(`typecheck`, `lint`, `test`, `docker-build`), and you can run each one locally:

```sh
pnpm typecheck
pnpm lint                                                       # ESLint, then the license check (see Dependencies)
pnpm test                                                       # needs the database from Setup
pnpm build
pnpm --filter @scrylux/web verify:build                         # the built page has no inline code or data: URIs
pnpm --filter @scrylux/web exec playwright install chromium     # once
pnpm test:e2e                                                   # browser tests, against the built app
docker build .
```

`main` only accepts pull requests, and **nobody can bypass these checks, repository admins
included**. [docs/ci.md](docs/ci.md) explains what each check does and how to reproduce a failure.

## How changes are made

The project's rules live in one place, the [constitution](.specify/memory/constitution.md). This is
a summary, and the constitution wins if they ever differ.

- **Test first** (Principle II). A new behavior gets a test that fails before the change and passes
  after. A bug fix starts with a test that reproduces the bug.
- **Principles I to VI.** The pull request template asks how your change meets each one, so skim
  them before you start. The ones that come up most are secure coding (parameterized queries,
  validated input, no secrets in logs) and simplicity (no new dependency or abstraction without a
  reason).
- **Call out security-relevant changes** in the pull request: authentication, validation, secrets
  or permissions.
- **Update the Threat Model** in the constitution in the same change if yours adds an asset, an
  entry point or a new trust boundary (Principle V).

## Threat rules

The threats Scrylux suggests come from rules kept as YAML files in
[`packages/threat-library/rules/`](packages/threat-library/rules/), not from code. You can add or
improve a rule without touching any TypeScript. The package's
[README](packages/threat-library/README.md) explains the format, how to choose an id, how to write the
examples and how to retire a rule. Rule changes are reviewed like code. The checks run with
`pnpm --filter @scrylux/threat-library test`, and they name the file, the rule and the problem.

Two rules are enforced in review, because the checks cannot see a rule's earlier version:

- A rule that describes a **different threat** (another element type, category or conditions) is
  retired and replaced under a **new id**, not edited. The id is recorded on every threat the rule
  produces.
- **Nothing is removed from `rules/ids.yaml`.** It lists every id ever issued.

A retired or changed rule shows up as a **stale** threat in [Scrylux's own threat model](docs/threat-model/),
and that fails the required check, so a retirement updates the model in the same pull request. A rule that
is only added makes the check **warn** that the model is behind, and does not fail it.

Write rule text yourself. Don't copy from other tools' templates or catalogs unless their license
allows it under Apache-2.0. Citing CWE and CAPEC numbers is fine.

## Scrylux's own threat model

Scrylux keeps a threat model of itself, built in Scrylux, in [`docs/threat-model/`](docs/threat-model/):
a Scrylux file and a Markdown report. The **Threat Model (STRIDE)** section of the
[constitution](.specify/memory/constitution.md) governs; the model is its structured counterpart.

- A change that adds an entry point, an asset or a trust boundary updates the constitution's section
  **and** the model **in the same change**.
- A change that retires or changes a threat-library rule updates the model in the same change, because
  the checks fail until it does. A change that only adds a rule gets a warning, and the model can follow.
- You change the model **in Scrylux**, never in the files: import the committed file, make the change,
  export both files again. [`docs/threat-model/README.md`](docs/threat-model/README.md) has the steps,
  the table for deciding a threat's status, and what the checks do. Every id in the Scrylux file changes
  on every update, so review the report's diff.
- If you find a vulnerability while modelling, follow [SECURITY.md](SECURITY.md) first.

## Changelog and releases

- **A change a user or an operator can see adds to [`CHANGELOG.md`](CHANGELOG.md) in the same pull
  request**: what they can now do, what they cannot, or what to know when upgrading. Group it by what
  a person does, not by commit. A required check fails if the changelog has no dated entry for the
  version the packages carry, or if its entry strays from the three headings.
- **A release is made by pushing one version tag**, and nothing else publishes anything. To prepare one,
  open a pull request that sets the version of every `package.json` and the default of
  `SCRYLUX_VERSION` in `docker-compose.release.yml` to the new version, and adds the dated changelog
  entry. Then follow [`docs/releasing.md`](docs/releasing.md). A check keeps the versions together.
- **The demo threat model** ([`docs/demo/`](docs/demo/)) is held like Scrylux's own: a retired or changed
  rule that leaves one of its threats stale fails the build, and a rule that would add a threat only warns.

## Commit messages

Use a short conventional prefix and say what changed. This project's history looks like:

```text
feat: React app shell with browser sessions (Phase 1 M6)
feat: REST API v1 and removal of the legacy tracker (Phase 1 M5)
feat: copy legacy threat entries into the domain model (Phase 1 M4)
```

Use `fix:`, `docs:`, `refactor:` and `test:` in the same way. Name the phase and milestone when the
change belongs to one.

## Dependencies

Dependencies that ship in the product must use an allowed license. The allowed list is in
[`scripts/license-policy.json`](scripts/license-policy.json): MIT, ISC, BSD-2-Clause,
BSD-3-Clause, Apache-2.0 and 0BSD. `pnpm lint` fails if a production dependency falls outside it.

If you need one that does not, say so in the issue first. An exception is a reviewed change to that
file: you verify the dependency's real license by hand and record the reason next to its name.
Development-only dependencies are not checked.

## License of your contributions

Scrylux is licensed under the [Apache License 2.0](LICENSE). By submitting a change, you license it
under Apache-2.0, as section 5 of that license provides. There is no Contributor License Agreement,
and commits do not need a sign-off.

## Security and conduct

- Found a vulnerability? Follow [SECURITY.md](SECURITY.md). Report it privately, never in a public
  issue, pull request or discussion.
- Unacceptable behavior can be reported as described in the [Code of Conduct](CODE_OF_CONDUCT.md).
