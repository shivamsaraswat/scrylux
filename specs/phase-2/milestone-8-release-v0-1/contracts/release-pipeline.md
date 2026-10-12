# Contract: the release pipeline

What the pipeline does, which permission each part holds, and every refusal. It is one workflow
definition, `.github/workflows/release.yml`, started by one event. The mechanics behind each choice
are in [research.md](../research.md); the checks that hold the workflow to this contract are in
[checks.md](./checks.md) (check W).

## Trigger

| Starts it | Does not start it |
|---|---|
| A push of a tag matching `v*` | A push to a branch, a pull request (from this repository or a fork), a schedule, a manual start, a release being created by hand |

`v*` is only a filter. The gate decides whether the tag is a version tag (FR-001). There is no
dry-run or manual mode (Clarifications, 2026-10-12): the rehearsal is a real pre-release tag.

Runs for one tag are serialised and never cancelled (`concurrency` group per tag, no
`cancel-in-progress`), so a re-run cannot overlap the run it completes.

## Jobs and permissions (FR-006)

The workflow's own default is **no permissions**. Each job declares what it needs, and only
`publish-image` and `release` hold a write permission.

| Job | Runs on | Permissions | Needs | Does |
|---|---|---|---|---|
| `gate` | ubuntu-latest | `contents: read`, `checks: read`, `packages: read` | | Reads the tag, decides whether to refuse, and says what is already published (below) |
| `build` | ubuntu-latest | `contents: read` | `gate` | Builds both platforms of the image from the tagged commit into one OCI archive. Skipped when the image is already published |
| `smoke` | matrix: ubuntu-latest (amd64), ubuntu-24.04-arm (arm64) | `contents: read` | `gate`, `build` | Runs the archive's platform variant natively against a database, with `SPECTER_VERSION` set to the version, and runs the smoke checks. Skipped when the image is already published |
| `publish-image` | ubuntu-latest | `packages: write`, `contents: read` | `gate`, `build`, `smoke` | Pushes the **archive that was tested**, byte for byte, to the registry. Skipped when the image is already published |
| `verify-public` | matrix: amd64, arm64 | `contents: read` (no registry login at all) | `gate`, `publish-image` (or skipped, when already published) | Pulls the image by digest and by tag with **no credentials**, checks its labels, and starts it with `SPECTER_VERSION` set to the version |
| `notes` | ubuntu-latest | `contents: read` | `gate`, `publish-image` (or skipped), `verify-public` | Makes everything the release needs that takes the workspace's dependencies to produce: the release notes and the compose asset. Uploads them as the artifact `release-files` |
| `release` | ubuntu-latest | `contents: write` | `gate`, `notes` | Creates the GitHub release, or completes it if it exists, from `release-files` and the demo file. Runs only `gh` |

Rules every job obeys:

- `actions/checkout` with `persist-credentials: false`. No job writes to the repository's git data.
- The only secret is the per-run `GITHUB_TOKEN`. No other `secrets.*` is referenced.
- **Nothing from the event is written into a script.** The tag name is text a pusher chooses, so it
  never appears inside a `${{ … }}` expression in a `run:` block (that would let `v1.0.0$(…)` run as
  code with the job's permissions). It, the commit and every other `github.*` value reach a script only
  through `env:`, and `gate` (G1) rejects a tag that is not a version before any later job uses it.
- **A message that names the tag is escaped before it is printed.** A refusal is printed as a `::error::` workflow command, and the
  runner decodes `%25`, `%0D` and `%0A` in it, so a tag such as `v1%0A::set-output …` would otherwise become a second command. The
  gate encodes those three characters first (`escapeCommandData` in `scripts/release/gate.ts`, tested in `gate.test.ts`), Principle I.
- Every `uses:` of a third party is pinned to a 40-character commit SHA, as in the other workflows.
  This workflow uses only first-party actions (`actions/*`) and the local `setup-workspace`; the
  image is built with the Docker CLI that is on the runner, not with a third-party action
  (research #3). `setup-workspace` runs `pnpm install`, so it is used only in `gate`, `notes` and
  `smoke`, which hold no write permission.
- **A job that holds a write permission runs no repository code and installs no dependency**
  (plan.md, Constraints). `publish-image` runs only a registry login, one existence check and the copy
  (`docker` and `skopeo`, as the runner has them); `release` runs only `gh`. What needs the workspace's
  dependencies (the release notes, the compose asset) is made earlier, in `notes`, and handed over as
  an artifact. `publish-image` runs only after `smoke` passed, and `release` only after `verify-public`.
- No job runs on `pull_request`, so no job that handles pull-request code can hold a write permission
  (SC-009, check W).

## The gate (FR-002)

`gate` runs `scripts/release/gate.ts` on the checkout (`fetch-depth: 0`, tags fetched). It reads the
tag from `GITHUB_REF_NAME` and the commit from `GITHUB_SHA`, makes the checks below in this order,
stops at the **first** that fails, and prints one error annotation:

```text
release refused: <condition>. <what to do>
```

| # | Condition checked | Refused when | Message names |
|---|---|---|---|
| G1 | **Tag shape** | The tag is not `v` + `MAJOR.MINOR.PATCH`, with an optional `-pre.release` suffix and no build metadata (`v0.1`, `0.1.0`, `v0.1.0+x`, `v01.0.0`) | the tag, and the form expected |
| G2 | **On `main`** | The tagged commit is not an ancestor of `origin/<default branch>` | the commit and the branch; says to tag a commit that is on `main` and to delete the wrong tag |
| G3 | **Versions agree** | Any of the five workspace `package.json` versions differs from the tag's version **core** (`MAJOR.MINOR.PATCH`, without the suffix), or the release compose file's default version differs | the files and the versions they carry |
| G4 | **Changelog entry** | `CHANGELOG.md` has no entry headed `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD` for the core version | the heading expected |
| G5 | **Required checks** | For any of the four checks the ruleset of `main` requires (`typecheck`, `lint`, `test`, `docker-build`, read from `.github/rulesets/main.json`), the commit has no GitHub-Actions check run with that name that concluded `success` | each missing, failed or still-running check; says to wait for a running one and re-run the workflow |
| G6 | **Not another image** | The version's image exists in the registry and its `org.opencontainers.image.revision` label is not the tagged commit. The label is read from the config of the index's `linux/amd64` image (every platform carries the same labels, which `smoke` and `verify-public` check for the platform they run) | the digest found and the commit it was built from |

A tag with a suffix (`v0.1.0-rc.1`) is a **pre-release**: G3 and G4 use its core version, so the
packages and the changelog carry `0.1.0` while its candidates are published (research #5).

What `gate` outputs when it does not refuse. All of it is written to `gate.json` (an artifact, for reading after the run) and to
the step's outputs. Only what another job reads is a **job output**:

| Output | Job output? | Meaning |
|---|---|---|
| `version` | yes | The tag without `v` (`0.1.0-rc.1`): the image tag and the release title |
| `core` | no | `0.1.0`: the version of the packages and the changelog entry. Only `gate.json` holds it, because `notes` works it out itself |
| `prerelease` | yes | `true` when the tag has a suffix |
| `is_latest` | yes | `true` only for a final version that is not lower than any other final `v*` tag of the repository; such a release moves `latest`. A pre-release never does |
| `image_published` | yes | `true` when the registry already holds the version's image (and G6 passed: it was built from this commit) |
| `image_digest` | yes | The digest of the image index when `image_published` |
| `release_published` | no | `true` when a GitHub release for the tag exists. Only `gate.json` holds it, because `release` asks GitHub itself and completes what is missing |
| `labels` | yes | The six `key=value` image labels, one per line (`scripts/release/versions.ts`), for the `build` job, which installs nothing and so cannot compute them |

A test (`scripts/workflows.test.ts`) fails if the gate declares a job output that no job reads, or a job reads one that the gate does not declare.

## Resume (FR-007)

A version is published once. A re-run of the same tag, or a second push of it after a deletion, does
only what is not done:

| State found by `gate` | Jobs that run |
|---|---|
| Nothing published | all of them |
| Image published from this commit, no release | `gate`, `verify-public`, `notes`, `release` |
| Image and release published | `gate`, `verify-public`, `notes`, and `release` only to upload an asset that is missing |
| Image exists from **another** commit | refused at G6; nothing runs |

Nothing is rebuilt on a resume, because a rebuild gives a different digest. A published tag is never
overwritten: `publish-image` runs only when `image_published` is `false`, and it refuses to push if
the tag appeared since `gate` ran.

## What `build` makes

One Docker buildx build of the repository's `Dockerfile` for `linux/amd64` and `linux/arm64`,
output as an OCI archive, uploaded as the artifact `image-oci`. It carries the labels and annotations
of [release-artifacts.md](./release-artifacts.md#the-image) and the commit of `GITHUB_SHA`. The
builder is a `docker-container` buildx builder whose BuildKit image is pinned by digest, and the build passes `--provenance=false --sbom=false`: BuildKit would otherwise add attestation manifests to the index, which v0.1 does not ship (Clarifications, 2026-10-12) and which would add `unknown/unknown` entries beside the two platforms (spike run, research #3). Nothing
from a person's machine is in the build: the context is the clean checkout, filtered by
`.dockerignore`.

## What `smoke` checks (FR-004)

On each platform, natively, with the image loaded from the archive with `skopeo --override-arch <platform> copy oci-archive:image.tar docker-daemon:<name>:<tag>` (`docker load` cannot read the archive on the runners, research #17 V2), under the exact name and tag the release compose
file refers to (`SPECTER_VERSION` is set to the version, so a candidate's `0.1.0-rc.1` is found), and
the release compose file itself starting the database and the app:

1. `GET /health` answers `200` within 60 seconds.
2. `GET /` answers the web app's HTML, with the content security policy header.
3. `POST /api/login` with the compose defaults gives a token.
4. A project is created, and `POST …/imports/check` on the demo file answers with a summary that
   lists nothing left out; the import creates the threat model.
5. "Generate threats" on it flags no threat **stale**. It does not fail when the run would **create**
   a threat: a rule added after the demo was committed makes CI warn and nothing more (FR-026), and
   that must not turn into a refusal to release. The created count is printed as a notice.
6. The database's port is not reachable from the host (only the app's port is published, on the
   loopback address).
7. The image's labels (`docker image inspect`) hold `org.opencontainers.image.version` equal to the
   version, `.revision` equal to the tagged commit, `.source` equal to the repository's URL, `.licenses`
   equal to `Apache-2.0`, `.title` equal to `Specter` and a non-empty `.description` (FR-009). Their
   expected values come from one function, shared with the build step that sets them.

Any failure fails the job, so `publish-image` does not run. The script is
`scripts/release/smoke.ts`; its steps are unit-tested against a fake server so that each can be shown
to fail (check S).

## What `publish-image` does

1. Log in to `ghcr.io` with the run's token.
2. Re-check that `ghcr.io/shivamsaraswat/specter:<version>` does not exist (the tag cannot have
   appeared since `gate`).
3. Copy the archive to `…:<version>` with all platforms and the same digests (the tested bytes).
4. When `is_latest` is true, copy it to `…:latest` too.
5. Print the digest to the job summary and pass it on.

## What `verify-public` does (FR-010)

With no registry credentials and an empty Docker configuration, on each platform natively:
`docker pull ghcr.io/shivamsaraswat/specter@<digest>` and `…:<version>`, `docker run` it far enough
to see `GET /health` answer (with a database from the release compose file), and check the same
labels as `smoke` step 7. A failure names the likely cause
(package still private: set it public once, see `docs/releasing.md`) and leaves the image published
and the release uncreated; the maintainer fixes the setting and re-runs.

## What `notes` does (FR-012)

Runs `scripts/release/notes.ts` on the checkout, with the digest from `publish-image` (or from `gate`
when the image was already published), and writes into `release-files`:

- `notes.md`, the changelog entry for the core version plus the image's name, version and digest
  ([release-artifacts.md](./release-artifacts.md#the-release-page));
- `docker-compose.yml`, a copy of `docker-compose.release.yml` in which, **for a pre-release only**,
  the default of `SPECTER_VERSION` is replaced by the full version (`0.1.0-rc.1`), so that the file a
  candidate attaches starts the candidate and not a `0.1.0` that does not exist yet. A final release's
  copy is the file as committed (its default is already the version, check V). The repository's own file
  is never changed.

## What `release` does (FR-012)

Creates the release for the tag (or finds it) with title `v<version>`, `--prerelease` when the
version has a suffix, `--latest` only when `is_latest`, and `--notes-file` of `notes.md`. It uploads two
assets, replacing an asset of the same name on a re-run: `docker-compose.yml` from `release-files` and
the demo model from the checkout. It creates nothing in git, installs nothing, runs no repository
script and uploads nothing else.

## What the pipeline needs from the repository's settings

Not in the workflow file, and documented in `docs/ci.md` with the command that recreates each
(FR-011, FR-042):

| Setting | Value |
|---|---|
| Tag ruleset, create and delete | Target tags `refs/tags/v*`; rules `creation` and `deletion`; bypass only for the repository owner |
| Tag ruleset, update | Target tags `refs/tags/v*`; rule `update`; no bypass actor, so nobody can move a version tag |
| Default workflow permissions | Unchanged: read-only (each job above declares its own) |
| Package visibility | `ghcr.io/shivamsaraswat/specter` set to public once, after the first publication; verified by every run (`verify-public`) |
