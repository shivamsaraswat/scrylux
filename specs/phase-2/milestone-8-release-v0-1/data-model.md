# Data Model: Release v0.1

This milestone adds **no table, column, migration or record type** (spec FR-040). What it adds is
content and a few small records that only exist in files and in the pipeline's run. This document
describes each, the demo model's blueprint (what to draw and how to triage it), and the register of new
risks that go into Specter's own threat model (spec User Story 7). It is what the pull request's
traceability list (SC-010) is built from.

As in Milestone 7, the repository and the running app are the truth. A flag, a name or a control that
turns out to be wrong here is corrected in the thing it describes, and the correction goes in the pull
request's findings.

## 1. Records that exist in files or in a run

### Version

`MAJOR.MINOR.PATCH` plus an optional pre-release suffix, parsed by one function
(`scripts/release/versions.ts`) that the gate, the notes and the checks all use.

| Field | Rule |
|---|---|
| `core` | `MAJOR.MINOR.PATCH`, no leading zeros, numbers only |
| `suffix` | optional, `-` followed by dot-separated identifiers of `[0-9A-Za-z-]`; no `+build` metadata (Docker tags cannot hold `+`) |
| `prerelease` | `suffix` is present |
| order | by `core`, then a version with no suffix is higher than the same core with one; used only to decide `is_latest` among **final** versions, so suffix ordering is never needed |

### Gate result

What `scripts/release/gate.ts` returns and the workflow publishes as job outputs and as `gate.json`
(fields in [contracts/release-pipeline.md](./contracts/release-pipeline.md#the-gate-fr-002)). Pure data:
`{ version, core, prerelease, is_latest, image_published, image_digest, release_published }`, or
`{ refused: { gate: "G1".."G6", condition, fix } }`. It is computed from the tag, the commit, the files
of the checkout, the check runs of the commit, the registry's answer for the version, and the list of
release tags; the module that decides takes those as arguments, so each refusal is a unit test with no
network (check G).

### Release (the state of one version)

A version moves one way and each step is recorded by the thing it creates:

```text
tag pushed ──gate──▶ image built ──smoke──▶ image published ──verify-public──▶ release created
 (refused: nothing)   (artifact only)        (immutable)        (anonymous pull ok)   (immutable notes aside)
```

| State | Evidence | A re-run does |
|---|---|---|
| Tag only | no image for the version | everything |
| Image published | the registry holds the version; its revision label is this commit | `verify-public`, then `release` |
| Released | a GitHub release exists for the tag, with both assets | `verify-public`, and uploads a missing asset |

There is no "unpublish". A bad version stays, and the next version is the fix (spec edge cases).

### The release page

Text assembled by `scripts/release/notes.ts` from the changelog entry, the image name, the digest and
the asset names. No other input, so it is a pure function with a fixed output for a fixed input.
The same module, in the pipeline's read-only `notes` job, makes the attached compose file: a pure
function of the committed file and the version, which for a pre-release replaces the default of
`SPECTER_VERSION` by the full version and for a final release returns the file unchanged.

### Changelog entry

A `## [core] - YYYY-MM-DD` heading and the text up to the next `## [` or the end, extracted by the
same module. The three sub-headings are named in
[contracts/release-artifacts.md](./contracts/release-artifacts.md#changelogmd).

### Check findings

`{ file, check, message, fix }`, printed as the two lines of the checks contract. The demo checks use
Milestone 7's type (`Finding`); the scripts-side checks define the same shape beside them, because the
two packages do not import each other's tests.

## 2. The demo model

One project and one threat model, authored in a running Specter, exported once as the Specter file,
and committed as `docs/demo/notes-app.specter.json`. It is **not** Specter's own model: it describes an
invented application, it is allowed to be instructive, and it is nobody's real design.

| Record | Value |
|---|---|
| Project | `Specter demo (fictional)` |
| Threat model | `Notes app (fictional demo)`, methodology `STRIDE`, status `in_review` (shows a lifecycle state other than draft) |
| The invented system | A small note-taking web app: people write notes with attachments in a browser, and a worker emails reminders |
| Tags and descriptions | Technologies and protocols only (`React`, `HTTPS`, `PostgreSQL`, `Object storage`). No real product name beyond those, no address, no account, no person (FR-025) |

### 2.1 The diagram

Sixteen elements, small enough to read in a screenshot, large enough that the rules generate a
substantial list (about forty to sixty threats, counted when it is authored).

| Name | Type | Inside | Flags (set only where the system's design says so; others left unassessed) |
|---|---|---|---|
| Cloud account | trust boundary | | |
| Private subnet | trust boundary | Cloud account | |
| Note taker | external entity | | `authenticated`: true, `internet_facing`: true |
| Email provider | external entity | | `authenticated`: true, `internet_facing`: true |
| Web app | process (runs in the browser) | | `internet_facing`: true, `requires_authentication`: true, `handles_sensitive_data`: true |
| Notes API | process | Cloud account | `internet_facing`: true, `requires_authentication`: true, `handles_sensitive_data`: true, `runs_privileged`: false |
| Reminder worker | process | Cloud account | `requires_authentication`: true, `handles_sensitive_data`: true, `runs_privileged`: false |
| Notes database | data store | Private subnet | `stores_sensitive_data`: true, `encrypted_at_rest`: true, `internet_facing`: false |
| Attachment bucket | data store | Private subnet | `stores_sensitive_data`: true, `encrypted_at_rest`: false, `internet_facing`: false |
| Writes and reads notes | data flow | Note taker → Web app | `authenticated`: true |
| Sign-in and note requests | data flow | Web app → Notes API (**crosses** Cloud account) | `encrypted_in_transit`: true, `authenticated`: true, `carries_sensitive_data`: true |
| Queries and updates | data flow | Notes API → Notes database (**crosses** Private subnet) | `encrypted_in_transit`: true, `authenticated`: true, `carries_sensitive_data`: true |
| Attachment upload and download | data flow | Notes API → Attachment bucket (**crosses** Private subnet) | `encrypted_in_transit`: true, `authenticated`: true, `carries_sensitive_data`: true |
| Schedules reminders | data flow | Notes API → Reminder worker | `authenticated`: true |
| Reads due reminders | data flow | Reminder worker → Notes database (**crosses** Private subnet) | `encrypted_in_transit`: false, `authenticated`: true, `carries_sensitive_data`: true |
| Sends reminder emails | data flow | Reminder worker → Email provider (**crosses** Cloud account) | `encrypted_in_transit`: true, `authenticated`: true, `carries_sensitive_data`: false |

The deliberate imperfections (an unencrypted bucket, an unencrypted internal read) are what make the
generated threats worth looking at and the statuses worth choosing. Names within a type are unique,
and no two flows share a name (the ties check, D3).

### 2.2 The triage (what the screenshots and the check D4 need)

Generate the threats, then decide a subset by hand, leaving the rest `open` as a real model in progress
would. The targets are what FR-024 and check D4 require, with margin:

| Property | Target |
|---|---|
| STRIDE categories present | all six, from the generated threats |
| Mitigated | at least 3, each with an `implemented` or `verified` mitigation |
| Accepted | at least 2, each with a reason that says why and until when |
| Not applicable | at least 2, each with a reason that states the fact that makes it impossible |
| Open | the rest; at least 3 of them carry a `proposed` mitigation |
| Mitigation states | at least one each of `proposed`, `implemented`, `verified` |
| Risk levels | at least three of Low, Medium, High, Critical: set likelihood and impact so that the open threats are not all one level, and at least one is Critical |
| Origin | the generated ones (`rule`), plus **one** written by hand (`manual`): *Shared note link can be guessed*, Information disclosure, on Notes API, with a `proposed` mitigation |
| Reasons and descriptions | Plain, short, about the invented system only |

Authoring follows Milestone 7's method: a running Specter, the documented API through throwaway scripts
kept out of the repository, then **Download Specter file** with no edit. A `docs/demo/README.md` records
how, and how to update it (the same procedure as `docs/threat-model/README.md`, with its caveat that
every import gives every record a new id).

## 3. New risks for Specter's own threat model

The release pipeline adds what the constitution's Threat Model section must record (FR-036, FR-037):

- **Asset (current)**: the published image `ghcr.io/shivamsaraswat/specter`, which every user
  runs; and the pipeline's **publishing credential**, the per-run `GITHUB_TOKEN` as held by the two
  publishing jobs.
- **Entry point**: the creation of a `v*` tag, which starts a run that holds write permissions.
- **Trust boundary (current)**: the line between the pipelines that run pull-request code and hold no
  write permission (`typecheck`, `lint`, `test`, `docker-build`, CodeQL, audit), and the release
  pipeline that holds two. The existing CI/CD boundary (forks, third-party actions and images) stays; this
  one is inside it.

Because the five element types cannot draw a pipeline, each risk is a **threat of the whole model**
(`element_id` null) of the committed model, with the status the constitution gives it. Titles are
unique within the whole-model threats of their category (the ties check, T). All have likelihood and
impact assessed; statuses are the vocabulary of Milestone 7's README ("How to decide a status").

| # | STRIDE | Title (whole model) | Status | Mitigations (text names the control and where it is documented) | L / I |
|---|---|---|---|---|---|
| R1 | Spoofing | A version tag is forged by someone who is not a maintainer | mitigated | `verified`: the gate refuses a tag that is not a version, is not on `main`, or whose versions disagree (`scripts/release/gate.test.ts`, G1 to G3). `implemented`: tag rulesets let only the repository owner create or delete a `v*` tag and let nobody move one (`docs/ci.md`, release tag protection) | Low / High |
| R2 | Tampering | A build or release step is replaced with a malicious one | mitigated | `verified`: every third-party step of every workflow is pinned to a commit SHA and the release workflow uses only first-party actions (`scripts/workflows.test.ts`). `implemented`: BuildKit is pinned by digest and refreshed by hand (`docs/ci.md`); Dependabot's three-day cooldown covers the actions | Low / High |
| R3 | Tampering | A published image is replaced after publication | **open** | `verified`: the pipeline never overwrites a version, and resumes a half-done release from the image already there (`scripts/release/gate.test.ts`, G6 and resume). `implemented`: the release notes print the image digest so a user can pin it (`scripts/release/notes.test.ts`). `proposed`: signed images and build attestation (`plan.md`, Phase 6, Verifiable release images) | Low / High |
| R4 | Elevation of privilege | The publishing credential is stolen or broader than needed | mitigated | `verified`: write permissions are held only by the two jobs that publish, and no secret other than the per-run token is referenced (`scripts/workflows.test.ts`). `implemented`: the token ends with the job, and the repository default stays read-only (`docs/ci.md`) | Low / High |
| R5 | Elevation of privilege | A tag runs the release workflow as defined at the tagged commit | accepted | none. Reason: whoever can create a version tag can already change the workflow and the rulesets, so the tag adds no power a repository owner lacks; the only tag creator is the owner (R1). Accepted until Phase 6 gives the project roles and organisation-level required workflows | Low / High |
| R6 | Repudiation | A user cannot tell who built an image or from which commit | **open** | `verified`: the image labels carry the source repository and the commit, which the smoke run checks on both platforms before publishing and again after (`scripts/release/smoke.test.ts`, step 7). `proposed`: build attestation and an SBOM (`plan.md`, Phase 6, Verifiable release images) | Medium / Medium |
| R7 | Spoofing | A look-alike image or registry is mistaken for the project's | accepted | none. Reason: every release's notes name the exact image and its digest (and the README's quickstart, from the second pull request, its name), and a user can be told no more than that without a signature; accepted until Phase 6's verifiable images | Medium / High |
| R8 | Information disclosure | A secret reaches the image, a release asset or the pipeline's log | mitigated | `verified`: the demo and the release's text files are scanned for credential, email, address and cloud-account patterns (`apps/api/test/demo/`, D7); the workflow references no secret but the per-run token (`scripts/workflows.test.ts`). `implemented`: the image is built by the pipeline from a clean checkout filtered by `.dockerignore`, never from a person's machine (`docs/releasing.md`) | Low / High |
| R9 | Elevation of privilege | An install is left running on the documented default credentials | **open** | `verified`: the quickstart's compose file publishes only the app, on the loopback address, and never the database, which every release's smoke run proves on the real image (`scripts/release/smoke.ts`, step 6). `implemented`: the header comment of `docker-compose.release.yml` says the defaults (`admin`/`admin`, a development signing secret, the database password) are for local use only, names each value to set, and says the app has no TLS of its own (`docker-compose.release.yml`), and the README's Quickstart says the same (`README.md`, which lands with the second pull request). No `proposed` mitigation: no phase schedules refusing weak defaults, and the product does not (FR-040) | Medium / High |

How these show in the constitution (FR-036, FR-037): the assets, the entry point and the boundary go
into the existing "current" lists; R1 and R7 into *Spoofing*, R2 and R3 into *Tampering* (next to the
CI/CD supply-chain bullet they extend), R6 into *Repudiation*, R8 into *Information disclosure*, R4,
R5 and R9 into *Elevation of privilege* (R9 next to the bullet on `ADMIN_USERNAME` and `ADMIN_PASSWORD`
being unset) together with the justification of the write permission that Governance asks for. R3, R6 and R7 name the same Phase 6 remedy.

**Traceability list for the pull request** (Milestone 7's form): one row per R1 to R9 with the
constitution bullet it comes from, the threat's title, and the two statuses compared. A reviewer confirms
every row; a program can only check that each threat has the status and the mitigation kind it needs.

## 4. Things this milestone does not model

- The image's contents as a supply chain of its own (base image, dependencies): already recorded by
  the existing Tampering bullets (digest pins, lockfile, cooldowns).
- The registry's own compromise: GHCR is a platform the project trusts as it trusts GitHub itself;
  R3's proposed remedy is what would let a user stop trusting it.
- Anything of Phase 3 onward (documents, LLM providers, repositories, integrations).
