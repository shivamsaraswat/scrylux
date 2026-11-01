# Continuous Integration

This documents the CI pipeline added in Phase 1 / Milestone 2 of `plan.md`
(`specs/phase-1/milestone-2-ci-pipeline/`): the four required checks, static analysis, dependency updates, and
every repository setting that isn't a file in this repo.

## Checks

| Check (job) | What it runs | Local equivalent | Timeout |
| --- | --- | --- | --- |
| `typecheck` | `pnpm typecheck` (`tsc --noEmit` in every package and in `scripts/`) | `pnpm typecheck` | 10 min |
| `lint` | `pnpm lint` (ESLint in every package and in `scripts/`, then the [license check](#license-check)), then the [lockfile-format guard](#lockfile-format) | `pnpm lint` | 10 min |
| `test` | `pnpm test` (Vitest in every package and in `scripts/`; a `globalSetup` migrates the database and seeds the admin user) against a real service container of the pgvector image, `pgvector/pgvector:0.8.7-pg16-trixie` pinned by digest (the image `docker-compose.yml` uses, [why](#the-database-upgrade-check)), then the [database upgrade check](#the-database-upgrade-check), then the `Threat model warnings` step (two test files, Scrylux's own threat model and the demo's, run alone as one project so that their annotations attach, [below](#scryluxs-own-threat-model)), then `pnpm build`, the built-output check (`pnpm --filter @scrylux/web verify:build`: no inline script or style, no `data:` URIs), and the Playwright browser tests against the built app (`pnpm test:e2e`, Chromium) | `docker compose up -d db && pnpm test && scripts/check-db-upgrade.sh && pnpm build && pnpm --filter @scrylux/web verify:build && pnpm test:e2e` (once: `pnpm --filter @scrylux/web exec playwright install chromium`) | 25 min |
| `docker-build` | `docker build --pull .` (never pushed anywhere) | `docker build .` | 15 min |

All four run on every pull request to `main`, on every push to `main`, and on demand
(`workflow_dispatch`). They're defined in `.github/workflows/ci.yml`; the Node/pnpm setup steps
shared across `typecheck`, `lint`, `test` and the `audit` job live in
`.github/actions/setup-workspace`.

Two other workflows run but are **not required checks**, and a third publishes a release and is started by nothing else than a version tag:

| Workflow (job) | Trigger | Blocks merging? |
| --- | --- | --- |
| CodeQL (`analyze`) | PR, push to `main`, weekly, on demand | No — see [CodeQL](#codeql) |
| Audit (`audit`) | Daily, on demand | No — see [Audit](#audit) |
| Release (`gate` … `release`) | The push of a `v*` tag, and nothing else | Not a check: it publishes — see [Release pipeline](#release-pipeline) |

## Scrylux's own threat model

Part of the `test` check holds [Scrylux's own threat model](../docs/threat-model/) to account
(Phase 2 / Milestone 7, `specs/phase-2/milestone-7-dogfood/`). The tests are in `apps/api/test/dogfood/`
and run with the rest of the API's tests, against the same database. They load the two committed files
through the real import, export, generate and report operations, and nothing about them needs a new job
or a secret.

- **They fail the build** when a committed file is not what Scrylux writes, the model does not import
  and export back to the same content, two records could only be ordered by their ids, a STRIDE category
  or a status reason is missing, the folder holds another file, a file holds something that looks like a
  credential, or "Generate threats" flags a threat of the model as **stale** (a rule was retired or
  changed). The report must be the one Scrylux builds for the file.
- **They only warn** when "Generate threats" would **add** threats because a rule was added: the warning
  is a `::warning` annotation on the test file (Vitest's `github-actions` reporter, which it turns on by
  itself under `GITHUB_ACTIONS`), and the check passes. It comes from a step of its own, **Threat model
  warnings**, which runs only `apps/api/test/dogfood/threat-model.test.ts` and `apps/api/test/demo/demo.test.ts`. `pnpm test` runs five packages
  at once, and pnpm then puts the package name in front of every line of their output; GitHub reads a
  `::warning` command only at the start of a line, so a warning raised there is printed in the log and
  never becomes an annotation. Run alone, as one project, the test's output is not prefixed. The step runs
  even when `pnpm test` failed, so a failure is annotated on the file too.
- To reproduce a failure locally: `pnpm --filter @scrylux/api exec vitest run test/dogfood`. The message
  names the file, the check and the fix; [the folder's README](../docs/threat-model/README.md) has the
  procedure.
- **The demo model** ([`docs/demo/`](demo/), Phase 2 / Milestone 8) is held the same way by `apps/api/test/demo/`:
  valid, imports with nothing left out, no stale threat, and the shape the spec lists. A stale threat fails the build; a threat
  a new rule would add is a warning. The *Threat model warnings* step runs **both** test files, each as one project, so that
  both files' `::warning` lines become annotations.

## The database upgrade check

Until v0.1 and Phase 3 Milestone 2, Scrylux's database ran on `postgres:16-alpine`. From v0.2 it runs on
`pgvector/pgvector:0.8.7-pg16-trixie`, because the vector extension that later milestones search with is only published for
Debian. The two images do not agree on how to sort text. Alpine's C library (musl) orders text by code point, and Debian's (glibc)
orders `en_US.utf8` text by linguistic rules, so `alpha`, `Beta` and `Élan` come in a different order. A data volume moved from
one image to the other keeps its B-tree indexes in the old order, and an index in the wrong order silently returns wrong answers.
Migration `017_sources.sql` rebuilds every index of every earlier table for that reason.

`scripts/check-db-upgrade.sh` (a step of the `test` job, after the unit tests) shows that it works, on a volume of its own:

1. It creates a volume on the old image, pinned by digest, applies migrations 001 to 016 with Scrylux's own migrator, and inserts
   rows whose text sorts differently in the two orders (users, projects and threat models with mixed case and accents).
2. Migration 017 refuses there, with its message, because the old image has no pgvector. After the refusal `schema_migrations` has
   no 017 row and no `sources` table exists: a refused migration changes no table.
3. It starts the new image on the same volume. Before 017, `amcheck`'s `bt_index_check(index, true)` **must report broken indexes**.
   This is the negative control: without it, a clean result after 017 would not show that the reindex repaired anything. If it
   finds none, the script prints `datlocprovider`, `datcollate` and `datctype` of both images and stops with status 2. Do not tune
   the data until it does. Ask the maintainer, because the reindex would then rest on a wrong premise.
4. It applies 017. Every B-tree index must now pass `bt_index_check(index, true)`, and every table must hold the rows it held.

Run it yourself with `scripts/check-db-upgrade.sh`. It needs Docker, `pnpm` and an installed workspace, takes about fifteen
seconds once the two images are local, and removes its containers and its volume when it ends, even when it fails. It touches no
database that you started. The service container of the `test` job and `docker-compose.yml` use the new image, so everything else
in CI runs where a v0.2 install does.

## Release pipeline

Phase 2 / Milestone 8 (`specs/phase-2/milestone-8-release-v0-1/`). The workflow is
[`.github/workflows/release.yml`](../.github/workflows/release.yml); [`releasing.md`](releasing.md) is the procedure a maintainer follows.
It is started by **the push of a tag matching `v*` and by nothing else**: not a branch, a pull request, a schedule or a manual start.

| Job | Permissions | Does |
| --- | --- | --- |
| `gate` | `contents: read`, `checks: read`, `packages: read` | Refuses what it should (below), and says what is already published |
| `build` | `contents: read` | Builds both platforms from the tagged commit into one OCI archive, with no BuildKit attestations |
| `smoke` ×2 | `contents: read` | On `amd64` and `arm64` natively: loads the archive's platform, starts `docker-compose.release.yml`, runs seven checks (health, web app, sign-in, demo import, generate, database port, labels) |
| `publish-image` | `packages: write`, `contents: read` | Pushes **the archive that was tested**, with the same digests; moves `latest` only for the highest final version. Runs only `docker` and `skopeo` |
| `verify-public` ×2 | `contents: read` | Pulls the image with **no credentials** by digest and by tag and runs the smoke checks against it |
| `notes` | `contents: read` | Makes the release notes and the compose file a release attaches (needs the workspace's dependencies, which is why it is not `release`) |
| `release` | `contents: write` | Creates the GitHub release, or completes it. Runs only `gh` |

The only secret is the per-run `GITHUB_TOKEN`. The default permission of the workflow is none. A policy test,
`scripts/workflows.test.ts`, fails the build if a job other than the two that publish holds a write permission, if one of those two
installs a dependency or runs a script of ours, if any action outside the repository is not pinned to a commit, if a `run:` block
contains an expression from the event (the tag name is text a pusher chose), or if the build leaves BuildKit's attestations on.

**The gate** refuses, naming the condition and what to do, in this order: **G1** the tag is not a version tag; **G2** the commit is
not on `main`; **G3** a package version or the compose default differs from the tag's version (a release candidate is compared by the
version it is a candidate for); **G4** `CHANGELOG.md` has no dated entry for it; **G5** a required check of `main` is not green on the
commit; **G6** the version's image exists and was built from another commit. A published version is never replaced: a re-run completes
only what is missing.

- **Reproduce the pure parts locally**: `pnpm exec vitest run --root scripts` (the gate, the notes, the smoke script against a fake server,
  the version rules and the workflow policy). The container itself: `SPEC/quickstart.md` §4.
- **BuildKit** is pinned by digest in the *Create the builder* step and **refreshed by hand**; [`releasing.md`](releasing.md#refreshing-the-pins)
  says how. So is the PostgreSQL digest in `docker-compose.release.yml`, unless Dependabot's `docker-compose` entry proposes it.
- **Verified on the runners** (2026-10-12): `skopeo` 1.13.3 is installed on `ubuntu-latest` and `ubuntu-24.04-arm`; `docker load` cannot read the
  OCI archive there (the pipeline uses `skopeo … docker-daemon:` instead); a `checks: read` token lists another workflow's check runs.

## Running checks locally

```sh
corepack enable            # gives you the exact pnpm version CI uses (packageManager)
docker compose up -d db    # only the database
pnpm install --frozen-lockfile
cp .env.example .env.test  # once; then edit it, as described below
pnpm typecheck
pnpm lint
pnpm test
docker build .
```

`pnpm test` and `pnpm test:e2e` read a gitignored `.env.test` at the repository root. CI supplies
the same values as job variables instead, so it needs no such file. After `cp .env.example
.env.test`, set `DB_PASSWORD=devpassword` (the database password in `docker-compose.yml`) and
replace the other `change-me` values with local-only values, for example
`JWT_SECRET=local-only-not-a-secret` and `ADMIN_PASSWORD=admin`. `DB_HOST=localhost` is already
right. Never commit the file.

`pnpm test` migrates the database and seeds the admin user itself (via a Vitest `globalSetup`),
so this works against a freshly created database volume — you don't need to have run the full
app first.

`packages/db`'s tests also drop and recreate a database called `scrylux_db_test`, and create and
drop short-lived `scrylux_upgrade_*` databases, on that same server. They need a role that can
create databases: the `postgres` user in `docker-compose.yml` and in the CI service container can.
Don't point `DB_HOST` at a server that holds anything that matters.

## Merge gate

`main` only accepts pull requests: direct pushes, force pushes and branch deletion are rejected.
A pull request cannot merge unless `typecheck`, `lint`, `test` and `docker-build` have all passed
on its latest commit. **Nobody can bypass this, including repository admins** — there are no
bypass actors on the ruleset.

- **Ruleset ID**: `24080645` (`shivamsaraswat/scrylux`, target `main`).
- **Definition**: `.github/rulesets/main.json`. This is the file to recreate the ruleset from if
  it's ever deleted:

  ```sh
  gh api -X POST repos/shivamsaraswat/scrylux/rulesets --input .github/rulesets/main.json
  ```

- **Emergency path**: if the hosting platform itself is down and no check can report at all, the
  only way through the gate is to temporarily disable the ruleset, then restore it:

  ```sh
  # Disable (emergency only):
  gh api -X PUT repos/shivamsaraswat/scrylux/rulesets/24080645 \
    --input <(gh api repos/shivamsaraswat/scrylux/rulesets/24080645 | jq '.enforcement = "disabled"')

  # Restore once the merge has gone through:
  gh api -X PUT repos/shivamsaraswat/scrylux/rulesets/24080645 \
    --input <(gh api repos/shivamsaraswat/scrylux/rulesets/24080645 | jq '.enforcement = "active"')
  ```

  A normal broken check (a bug in the pipeline itself, a pinned action failing) does **not**
  qualify for this — fix it with a pull request like any other change, which runs its own,
  corrected version of the checks.

## Repository settings with no file equivalent

These aren't in any committed file — they're applied directly against the GitHub API. Each
command below both documents and recreates the setting.

| Setting | Value | Recreate with |
| --- | --- | --- |
| Merge-gate ruleset | Active, id `24080645`, no bypass actors | see [Merge gate](#merge-gate) above |
| Dependabot alerts | Enabled | `gh api -X PUT repos/shivamsaraswat/scrylux/vulnerability-alerts` |
| Dependabot security updates | Enabled | `gh api -X PUT repos/shivamsaraswat/scrylux/automated-security-fixes` |
| CodeQL default setup | Disabled (the advanced-setup `codeql.yml` runs instead) | `gh api -X PATCH repos/shivamsaraswat/scrylux/code-scanning/default-setup -f state=not-configured` |
| Default `GITHUB_TOKEN` permissions | Read-only; cannot approve PRs | `gh api -X PUT repos/shivamsaraswat/scrylux/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false` |
| Fork PR workflow approval | `first_time_contributors` (GitHub's default) | left as-is; verify with `gh api repos/shivamsaraswat/scrylux/actions/permissions/fork-pr-contributor-approval` |
| Release tags: create and delete | Ruleset `release-tags`, id `24911587`, target `refs/tags/v*`; owner only | `gh api -X POST repos/shivamsaraswat/scrylux/rulesets --input .github/rulesets/release-tags.json` |
| Release tags: never moved | Ruleset `release-tags-immutable`, id `24911595`, no bypass actor | `gh api -X POST repos/shivamsaraswat/scrylux/rulesets --input .github/rulesets/release-tags-immutable.json` |
| Package `ghcr.io/shivamsaraswat/scrylux` | **Public**, linked to the repository; set once in the package's settings after the first publication | verify: `DOCKER_CONFIG="$(mktemp -d)" docker pull ghcr.io/shivamsaraswat/scrylux:<version>`; see [`releasing.md`](releasing.md#the-package-is-public-after-the-first-publication-once) |

**Scheduled workflows note**: GitHub disables scheduled workflows on public repositories after
60 days with no repository activity. If the weekly CodeQL run or the daily audit run stops firing,
re-enable it from the Actions tab.

## License check

The `lint` job also fails when a dependency that ships in the product has a license that is not on
the allowed list (Phase 1 / Milestone 7, `specs/phase-1/milestone-7-open-source-hygiene/`). It runs as the last
step of `pnpm lint`, so a local `pnpm lint` and the CI job behave identically.

- **What it checks**: the production npm dependencies of every workspace package, as
  `pnpm licenses list --prod --json` reports them. These are the ones deployed with the API or
  bundled into the web app. Development-only dependencies are not checked, and neither are the
  container base image's operating-system packages.
- **The policy** is `scripts/license-policy.json`: `allowed`, a list of SPDX license ids (MIT, ISC,
  BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD), and `exceptions`, a map from package name to the
  reason it is exempt. The check is default-deny. A license that is missing, unknown, written as
  free text or uses `WITH` fails, and so does an exception for a package that no longer ships.
  `(MIT OR GPL-3.0-only)` passes, because one alternative is allowed.
- **Adding an exception** is a reviewed change to that file. Verify the dependency's real license
  by hand, and put that license and the reason in the entry. Changing `allowed` is reviewed the same
  way, with the reason in the pull request.
- **Exit codes**: `0` all allowed, `1` at least one violation (one line each), `2` the check could
  not run, for example when `pnpm licenses` fails or the policy is malformed. It never counts as a
  pass.
- **No network access**: it reads the installed package manifests only.
- **Third-party notices**: the web build also writes `apps/web/dist/.vite/license.md`, with the
  license text of every bundled dependency, because the minified bundle keeps no license comments.
  The image carries it, it is not served, and `pnpm --filter @scrylux/web verify:build` checks it.

## Lockfile format

`pnpm-lock.yaml` must be a single YAML document — no line matching `^---`. The `lint` check fails
the build if it ever isn't.

**Why**: pnpm ≥ 11 writes `pnpm-lock.yaml` as *two* concatenated YAML documents when it manages
its own version (an "env" document with `packageManagerDependencies`, followed by the real
lockfile). GitHub's dependency graph parser reads only the first document, so it reports **zero
dependencies** for the whole workspace and silently disables Dependabot alerts and security
updates ([dependabot-core#15904](https://github.com/dependabot/dependabot-core/issues/15904),
open with no fix scheduled as of this writing).

**The trade-off**: `pnpm-workspace.yaml` sets `pmOnFail: ignore`, which is the only value that
makes pnpm write a single document. The cost is that pnpm no longer checks the running pnpm
version against `packageManager` itself. This is compensated for:

- CI and the Docker build both install the exact pinned version via Corepack
  (`pnpm/action-setup` reads `packageManager`; the Dockerfile runs `corepack enable`).
- `pnpm install --frozen-lockfile` still fails on any lockfile/manifest drift.
- Contributors are told to run `corepack enable` (see the top-level README).

**Revert this** once dependabot-core#15904 ships: remove `pmOnFail: ignore` from
`pnpm-workspace.yaml`, remove the `lint` job's lockfile-format guard step in `ci.yml`, and let
pnpm regenerate the lockfile normally.

## Dependabot

Weekly (Monday), grouped per ecosystem for minor/patch updates. Every ecosystem has a 3-day
cooldown on new releases (`cooldown.default-days: 3`):

- **npm** (`/`) — the cooldown exceeds pnpm's own 24-hour `minimumReleaseAge` protection.
  - **Known limitation**: the cooldown only covers *direct* dependencies. A Dependabot PR can
    still fail with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` if a *transitive* dependency was
    published in the last 24 hours. If that happens, comment `@dependabot recreate` on the PR the
    next day.
- **docker** (`/`) — the base image is pinned as `node:22-alpine@sha256:<digest>`, so weekly runs
  propose digest refreshes (patch releases, security rebuilds of the same tag). Node major-version
  bumps are ignored deliberately — moving to a new Node major is a human decision, and CI follows
  it automatically once the Dockerfile changes.
- **docker-compose** (`/`) — keeps the pgvector image digest of `docker-compose.release.yml` (and the tag in the contributor's `docker-compose.yml`) current. A major
  update of `pgvector/pgvector` is ignored deliberately (a test holds that rule: `scripts/compose.test.ts`). Its tag also names the PostgreSQL major
  (`-pg16-`), which Dependabot keeps as it is when it proposes a newer tag, and a move to another PostgreSQL major is a human decision with a data migration:
  refuse the pull request by hand if one ever proposes it. The `test` job's service container and `scripts/check-db-upgrade.sh` pin the same digest, which
  Dependabot does not read, so a refreshed digest is applied to all three together ([`releasing.md`](releasing.md#refreshing-the-pins)). Whether this ecosystem reads a file named
  `docker-compose.release.yml` is not yet confirmed; check after the first Monday and refresh the digest by hand if it did not
  ([`releasing.md`](releasing.md#refreshing-the-pins)).
- **github-actions** (`/` and `/.github/actions/*`) — keeps the pinned commit SHAs (and their
  `# vX.Y.Z` comments) in `ci.yml`, `codeql.yml`, `audit.yml` and the composite action current.

Updates that fix a published security advisory are proposed immediately, individually, without
waiting for the weekly schedule or the cooldown. No proposal is auto-merged — a maintainer reviews
and merges each one once its checks pass.

## CodeQL

Advanced setup (`.github/workflows/codeql.yml`), analyzing `javascript-typescript` and `actions`
(the workflow files themselves), with the broadest built-in query suite: `security-and-quality`
(`security-extended` plus code-quality queries). Runs on PRs, on pushes to `main`, weekly, and on
demand.

Findings are **informational** — they show up on the pull request and under Security → Code
scanning, but never block a merge on their own. The first run under the broadened suite may
surface a number of existing quality findings; that's expected, and the backlog is worked down
over time rather than blocking anything.

Dismissing a finding as a false positive or "won't fix" needs a written reason in the dismissal.

## Audit

`.github/workflows/audit.yml` is a second, independent source of dependency advisories, since the
lockfile-format fix above is a workaround for an open upstream bug. It runs daily and on demand,
never on pull requests, and is never a required check.

It runs two steps:

1. `pnpm audit` — prints the full report at every severity. Marked `continue-on-error: true`, so
   this step never fails the job by itself.
2. `pnpm audit --audit-level=high` — the actual gate. Fails the job only on **high or critical**
   advisories. (`--audit-level` filters what gets *printed*, not just the exit code, which is why
   this needs two separate steps rather than one.)

A failed scheduled run notifies maintainers through GitHub's standard workflow-failure email.
