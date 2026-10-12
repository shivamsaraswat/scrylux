# Implementation Plan: Release v0.1

**Branch**: not yet created (spec directory `phase-2/milestone-8-release-v0-1`) | **Date**: 2026-10-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/phase-2/milestone-8-release-v0-1/spec.md`

## Summary

Turn the repository into something a stranger can run: a tag-triggered pipeline that publishes a
tested, two-platform image and a GitHub release, a README that starts that image in minutes, a demo
model to explore, and the checks and the threat-model update that make the release honest.

This milestone is **pipeline, packaging, documentation and content**. It adds no product code, no
endpoint, no table and no runtime dependency (spec FR-040). The deliverables:

1. **The release pipeline** (FR-001 to FR-011): one workflow started only by a version tag, with a
   gate that refuses what it should, a native smoke test on each platform, a push of the very bytes that
   were tested, an anonymous-pull check and a release page. Write permissions sit only in the two jobs
   that publish ([contracts/release-pipeline.md](./contracts/release-pipeline.md); research #1 to #8).
2. **The image and the quickstart file** (FR-008, FR-009, FR-016 to FR-018): the existing `Dockerfile`
   with one flag so that one build serves both platforms, and `docker-compose.release.yml`, which
   publishes only the app, on the loopback address ([contracts/release-artifacts.md](./contracts/release-artifacts.md);
   research #3, #9).
3. **The words** (FR-012 to FR-014, FR-019 to FR-022, FR-031 to FR-035): `CHANGELOG.md`, release notes
   built from it, the README's quickstart, limits and screenshots, `SECURITY.md`'s supported versions,
   `plan.md`'s bookkeeping, and `docs/releasing.md` with the name-check record (research #10, #13, #16).
4. **The demo** (FR-023 to FR-026): a fictional model, authored in a running Specter, committed under
   `docs/demo/`, attached to the release, and held by checks that reuse Milestone 7's
   ([data-model.md §2](./data-model.md#2-the-demo-model); research #12).
5. **The proof** (FR-027, FR-028): one browser test that does the Phase 2 Definition of Done in order,
   all through the page, and the pipeline's smoke run against the container (research #4, #14).
6. **The checks** (FR-006, FR-015, FR-021, FR-043): versions, links, workflow policy, the gate, the
   notes and the smoke script, as tests in the existing `scripts/` project, plus the demo's, all in the
   required `test` check ([contracts/checks.md](./contracts/checks.md); research #11).
7. **The release in Specter's own threat model** (FR-036 to FR-039): nine risks recorded in the
   constitution and as threats of the whole committed model, the constitution amended to 1.13.0
   ([data-model.md §3](./data-model.md#3-new-risks-for-specters-own-threat-model); research #15).

Three facts shape the design, and each was measured here (research #3, #5, #17), not assumed:

- The base image is already multi-platform and the production dependencies are pure JavaScript, so a
  two-platform image needs one fast build and no emulation, and `skopeo`-style copying can push exactly
  the bytes that were tested.
- A tag push runs the workflow as defined **at the tagged commit**, so the gate cannot be its own
  control. What protects it is who may create a tag (two rulesets), and the residual is a named,
  accepted risk (R5), not a hidden one.
- The tag name is text a pusher chooses. It reaches no script except through `env:`, after the gate has
  checked its shape, and a test holds the workflow to that.

## Technical Context

**Language/Version**: TypeScript (strict), Node.js 22+, for the scripts, the checks and the tests.
YAML (workflow, compose, rulesets), Markdown and JSON for the rest. Bash only in one-line workflow
steps.

**Primary Dependencies**: none at runtime. One **development** dependency at the repository root:
`yaml` (already in the lockfile as a transitive package), to read workflow files by structure. The
pipeline uses the Docker CLI and `gh` already on the GitHub-hosted runners, `actions/checkout`,
`actions/upload-artifact`, `actions/download-artifact` (first party, pinned by SHA, as the other
workflows are) and the repository's local `setup-workspace` action. No third-party action.

**Storage**: none new. The registry holds the image; the repository holds files. No table, column or
migration (FR-040).

**Testing**: Vitest in `scripts/` (V, L, W, G, N, S) and in `apps/api` (D, and Milestone 7's T);
Playwright for E. The image itself is tested by the pipeline's smoke run, and once by hand before the
first release (quickstart §4).

**Target Platform**: GitHub Actions (`ubuntu-latest` and `ubuntu-24.04-arm`, both free for a public
repository), GHCR, Docker with Compose. The image runs on `linux/amd64` and `linux/arm64`.

**Project Type**: monorepo (pnpm workspaces). This milestone touches `.github/`, `scripts/`, the
repository root files, `docs/`, `apps/web/e2e`, `apps/api/test/demo` and the constitution.

**Performance Goals**: the pipeline from tag to release page in 20 minutes or less (the build is about
four minutes; each smoke run, three; the rest are small); the Definition of Done test in 60 seconds
or less; the new unit tests add under 10 seconds to `pnpm test`; the demo test under 10 seconds.

**Constraints**:
- No product change, no endpoint, no table, no migration, no runtime dependency, nothing of a later
  phase (FR-040). The contributor's path is unchanged (FR-041).
- A version, once published, is never replaced (FR-007): the pipeline cannot overwrite, and a re-run
  completes only what is missing.
- No third-party code runs in a job that holds a write permission (FR-006).
- The committed demo and threat-model files are exactly what Specter exports, never edited (FR-025,
  Milestone 7 FR-013).
- Checks never compare record ids, the clock or an install's project name (Milestone 7, research #1).

**Scale/Scope**: an image of about 65 MB per platform; a demo of sixteen elements and about fifty
threats; four screenshots of at most 600 KB each; roughly ten new source files in `scripts/`, one
workflow, one compose file, one new browser spec, and a handful of documents.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Check | Result |
|---|---|---|
| **I. Secure coding** | No new route, input path, SQL or credential in the application. The new input is the pushed tag's name: it is never placed in a script expression, it is validated by shape first (G1), and a test fails the build if a `run:` block of the release workflow contains an event expression. Secrets: none are added; the only credential the pipeline touches is the per-run token. The image holds no `.env` (`.dockerignore`) and is built from a clean checkout. Demo and text files are scanned for credential patterns (D7). | Pass |
| **II. Test-first** | Each script (versions, links, gate, notes, smoke) and the demo shape checks get their tests **before** their code, and each check has a broken-input test so none can be a check that never fails. The Definition of Done test is a test of behaviour that already exists, so it is written first and is expected to pass; a defect it finds is fixed under FR-040 with a test that fails first. The workflow cannot be run before it exists; its policy (W) and its decision logic (G, N, S) are tested without running it, and the first run is the rehearsal candidate. | Pass |
| **III. Simplicity** | No runtime dependency, no abstraction in the application, no later-phase content. One development dependency (`yaml`), used. No third-party action, no QEMU, no release tool, no changesets. The demo is a file loaded by the existing import; no seeding code, no button (Clarifications). The seven-job pipeline is justified under Complexity Tracking. | Pass, one entry |
| **IV. Maintainability & observability** | No environment variable is read by the app: `SPECTER_VERSION` is a Compose variable of the quickstart file and is documented in the README's quickstart; `PORT` is already in the variable table. No log line is added to the app. The workflow logs to the job log and never prints a secret. The demo, the changelog and the notes are data and text a reviewer can diff. Every manual refresh (the BuildKit pin, the Postgres digest) is written in `docs/ci.md`. | Pass |
| **V. Least-privilege, threat-aware design** | This is the milestone's second reason to exist. It adds an entry point (a tag push), assets (the image, the publishing credential) and a trust boundary (release pipeline vs pull-request pipelines). The constitution's section and the committed model are updated in the same change (FR-036 to FR-039); the write permission is the broadest thing the project has ever held and is justified in the pull request: the two jobs, nothing else (Complexity Tracking). | Pass |
| **VI. AI output is a draft** | No AI feature. The demo has no AI-origin threat (D4), and Phase 3's content is absent. | Pass |

Post-design re-check: unchanged. Phase 1 design added the tag name as an input and the loopback bind,
and both strengthened rows I and V; nothing added a dependency, a permission or a rule outside the
table.

## Project Structure

### Documentation (this feature)

```text
specs/phase-2/milestone-8-release-v0-1/
├── plan.md              # This file
├── research.md          # Phase 0: decisions, the alternatives rejected, what is not yet verified
├── data-model.md        # Phase 1: version and gate records, the demo's blueprint, the new risks R1 to R9
├── quickstart.md        # Phase 1: how to validate each part, the rehearsal, the walkthrough, the release
├── contracts/
│   ├── release-pipeline.md    # Trigger, jobs and permissions, the gate G1 to G6, resume, smoke, publish
│   ├── release-artifacts.md   # Version, image, compose file, release page, changelog, README, demo, images
│   └── checks.md              # The checks V, L, W, G, N, S, D, E, T and what review decides
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks, not created by this command)
```

### Source Code (repository root)

```text
.github/
├── workflows/release.yml                  # NEW   the pipeline (contracts/release-pipeline.md)
├── actions/setup-workspace/action.yml     # EDIT  the FROM regex accepts --platform=…
├── rulesets/release-tags.json             # NEW   create and delete: owner only
├── rulesets/release-tags-immutable.json   # NEW   update: nobody
└── dependabot.yml                         # EDIT  docker-compose entry if V6 holds
Dockerfile                                 # EDIT  builder stage: FROM --platform=$BUILDPLATFORM
docker-compose.release.yml                 # NEW   the quickstart's file, attached to each release
CHANGELOG.md                               # NEW   the 0.1.0 entry
README.md                                  # EDIT  status, quickstart, demo, screenshots, limits, upgrading, roadmap
SECURITY.md                                # EDIT  supported versions
CONTRIBUTING.md                            # EDIT  changelog entries; how releases are made (link)
plan.md                                    # EDIT  Phase 2 done; Name decided; (Phase 6 item already added)
docs/
├── releasing.md                           # NEW   readiness, settings, rehearsal, release, failure, bad release, name check
├── ci.md                                  # EDIT  the release pipeline, tag rulesets, the pins refreshed by hand
├── demo/
│   ├── README.md                          # NEW   what it is, how to load it, how it was made and updated
│   └── notes-app.specter.json             # NEW   the demo, exported unchanged
├── images/                                # NEW   the four screenshots
└── threat-model/                          # EDIT  README scope; the two exports (nine new whole-model threats)
scripts/
├── release/
│   ├── versions.ts  versions.test.ts      # NEW   V: parse a version, read the five packages, the compose default, the changelog
│   ├── gate.ts      gate.test.ts          # NEW   G: the decision function and its command-line wrapper
│   ├── notes.ts     notes.test.ts         # NEW   N: changelog extraction and the release page
│   └── smoke.ts     smoke.test.ts         # NEW   S: the seven steps, tested against a fake server
├── check-links.ts   links.test.ts         # NEW   L
└── workflows.test.ts                      # NEW   W (reads .github/workflows and the local actions)
apps/api/test/demo/                        # NEW   D: checks.ts (shape), checks.test.ts (broken inputs), demo.test.ts (real operations)
apps/web/e2e/
├── phase-2-definition-of-done.spec.ts     # NEW   E
└── diagram-helpers.ts, diagram.spec.ts    # EDIT  dropNodeAt moves into the helpers (no behaviour change)
.specify/memory/constitution.md            # EDIT  Threat Model section, Dev Workflow sentence, Sync Impact Report, 1.13.0
package.json                               # EDIT  devDependency yaml
```

**Structure Decision**: the release machinery is repository-level and has no database, so its checks
live in `scripts/` with the code they test, next to `check-licenses.ts`, and run in the existing
`pnpm test`. The demo checks need the app and Postgres and reuse Milestone 7's modules, so they live
in `apps/api/test/` beside `dogfood/`. The release compose file is at the root, next to the
contributor's, because it is the file a user downloads and a maintainer attaches; the demo is under
`docs/demo/`, not `docs/threat-model/`, because a check holds that folder to its three files and the
two models are different things.

## Delivery Order (for `/speckit-tasks`)

The order that keeps every step testable and the risky, one-time work early:

1. **Spikes and settings, first** (research #17): a throwaway workflow run on a branch to settle V1,
   V2 and V7; the two tag rulesets and the verification of V4 by the maintainer. Nothing else depends
   on a result, but a surprise here changes #3 or #7.
2. **Pure code, test-first**: `versions`, `gate`, `notes`, `smoke`, `links`, `workflows` tests, then
   their code. The workflow policy test is written against the contract before `release.yml` exists,
   and fails until it does.
3. **Image and pipeline**: the Dockerfile flag and the `setup-workspace` regex; `docker-compose.release.yml`
   and the smoke run against it by hand (quickstart §4); `release.yml` until the policy test passes.
4. **Definition of Done test**: move `dropNodeAt`, write the spec, run it.
5. **Demo**: author it (needs a running Specter), then the demo checks (test-first, with broken
   inputs), then the file.
6. **Documents and screenshots**: `CHANGELOG.md`, README, `docs/releasing.md`, `docs/demo/README.md`,
   `SECURITY.md`, `CONTRIBUTING.md`, `docs/ci.md`; the screenshots from the loaded demo; the link check
   passes last.
7. **Threat model**: the constitution's section and the committed model for R1 to R9, then Milestone
   7's checks.
8. **Merge, then rehearse and release** (quickstart §5 to §7): these need the merged pipeline and the
   maintainer's access, and are not part of the pull request. The edits that say a release exists (the
   README's status, quickstart and demo download, the roadmap's ✅, `SECURITY.md`, `plan.md`'s Phase 2
   and Name) are a **second pull request**, merged right before the final tag (tasks.md T052, T060),
   so that `main` describes a release only when it is about to exist.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| A seven-job pipeline (`gate`, `build`, `smoke` ×2, `publish-image`, `verify-public` ×2, `notes`, `release`) in a project whose other workflows are one job each | Each job exists to hold one permission or prove one fact: the gate decides with read scopes only; build and smoke touch no write scope; the registry write and the release write are separate scopes (FR-006); `verify-public` needs a runner with no login; `notes` exists so that the two jobs that hold a write permission run no repository code and install no dependency (it takes the workspace's dependencies to make the notes and the compose asset); and the two platforms are tested natively | One job would give the build, the repository checkout and the registry push a shared write token. Two jobs (test, publish) would drop the separate release scope and the anonymous check, which is where a private package is caught |
| A write permission (`packages: write`, `contents: write`), the first the project holds beyond CodeQL's `security-events: write` | A release must be published by something. It is per-run, per-job, never a stored secret, and gated by six refusals; the two jobs that hold it run only `docker`, `skopeo` and `gh` | Publishing from a maintainer's machine would put a long-lived credential on a laptop and nothing between a typo and the registry. This is the broadening Governance asks to be justified: two jobs, no more |
| One development dependency, `yaml` | The workflow policy (SC-009) asks which job a permission belongs to | Regular expressions over YAML cannot answer that, and a policy test that gets it wrong is worse than none |
| Two tag rulesets instead of one | One ruleset has one bypass list; "the owner may create or delete, nobody may move" needs two | One ruleset with no bypass means nobody can create a version tag; one with a bypass lets the owner move one |
| A change to the `Dockerfile` and to the shared `setup-workspace` action in a milestone that adds no product code | One flag removes emulation from the build and keeps the tested bytes the published bytes (research #3) | QEMU: a slow emulated install in the privileged build, or a per-platform push before the smoke test |
