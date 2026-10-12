# Research: Release v0.1

Decisions behind the plan, with the alternatives rejected. Each is either **verified** here (against the
repository, a command run in this session, or GitHub's documentation) or listed in
[#17](#17-what-is-not-verified-and-where-it-is) as something the first tasks check before building on
it. Nothing in this list needs the user's decision: the two defaults the spec called most likely to be
challenged were decided in its Clarifications (2026-10-12).

## 1. One workflow, one trigger

**Decision.** One workflow, `.github/workflows/release.yml`, started only by the push of a tag that
matches `v*`. The glob is a filter; the gate (#5) decides whether the tag is a version.

**Rationale.** FR-001 allows nothing else to start it, and Clarifications 2026-10-12 removed the
dry-run and the manual start. One trigger means one thing to protect (#7).

**Alternatives.** `workflow_dispatch` with a tag input (runs the workflow from a branch, which would
let the workflow definition come from `main` and not from the tag; rejected because the spec forbids a
manual start of a final release and the clarified rehearsal is a real tag); `release: published`
(the person creates the release first, then CI attaches an image: the image would be built after the
announcement, and a release page could exist with no image); a separate "release PR" tool
(changesets, release-please: a dependency and a bot for one release, Principle III).

**Known cost, recorded as risk R5.** A tag push runs the workflow **as defined at the tagged commit**.
The gate cannot protect against a commit whose gate has been edited. What stops it is who may create a
tag (#7), and the residual (a repository owner can already edit the workflow) is accepted until Phase 6.

## 2. The jobs, and where the write permissions sit

**Decision.** Seven jobs (`gate`, `build`, `smoke`, `publish-image`, `verify-public`, `notes`,
`release`). The workflow's default is no permission; `gate` holds `contents: read`, `checks: read`,
`packages: read`; `build`, `smoke`, `verify-public` and `notes` hold `contents: read`; `publish-image`
alone holds `packages: write`; `release` alone holds `contents: write`
([contracts/release-pipeline.md](./contracts/release-pipeline.md)). The two jobs that hold a write
permission run no repository code and install nothing: they use `docker`, `skopeo` and `gh`, as the
runner has them. What needs the workspace's dependencies (the release notes and the compose asset made
from `scripts/release/notes.ts`) is done by `notes`, which holds a read scope only, and handed over as an
artifact. (An earlier draft ran `notes.ts` in the `release` job, which would have run `pnpm install`
under `contents: write`; the analysis of 2026-10-12 caught it.)

**Rationale.** FR-006 asks that a write permission be held only by the part that publishes and only
after every check passed. Splitting the registry write from the release write means a bug or a
compromise in one cannot use the other's scope, and neither is reachable until `smoke` has passed. The
jobs that execute repository code (`gate`, `build`, `smoke`) hold only read scopes. `checks: read` is a
documented scope of the workflow token (GitHub's token-permission list has `checks` with read and
write; **verified** by search), and the list-check-runs endpoint takes a SHA.

**Alternatives.** One job (simplest, but the build and the push would share a write token);
`environment:` protection for the two publishing jobs (useful with required reviewers and secrets, but
the repository is a single maintainer and the project holds no secret; it would be ceremony with a
manual approval nobody else can give); a reusable workflow for the gate (indirection with no second
caller).

## 3. Building the image

**Decision.**

- The **Docker CLI that is on the runner**, with a `docker-container` buildx builder created by
  command, its BuildKit image **pinned by digest**. No third-party action builds or pushes.
- The Dockerfile's builder stage gains `--platform=$BUILDPLATFORM` (the final stage is unchanged and
  has no `RUN`), so one build on one machine produces both platforms with nothing emulated.
- The build's output is **one OCI archive** (an index holding `linux/amd64` and `linux/arm64`),
  uploaded as an artifact. The archive that `smoke` tests is, byte for byte, the archive
  `publish-image` pushes.
- Labels in the image config and the source annotation on the index
  ([contracts/release-artifacts.md](./contracts/release-artifacts.md#the-image)).

**Verified in this session** (a throwaway build from a copy of the Dockerfile; no repository file was
changed):

| Fact | Result |
|---|---|
| The pinned base image digest `node:22-alpine@sha256:0a7108…` | an OCI index with `linux/amd64` and `linux/arm64/v8` among its platforms |
| The production dependency tree (`pnpm --filter=@specter/api deploy --prod`) | 0 native `.node` files, no package with an `os` or `cpu` field |
| One `docker buildx build --platform linux/amd64,linux/arm64 --output type=oci` with the changed Dockerfile | exit 0, a 130 MB archive in about four minutes on a laptop; an index of two images; each image's config holds the labels, the user is `node`; the index carries the source annotation |
| `docker load` of the archive and running each platform | both started `node` and loaded `express`, `pg`, `bcryptjs`, `jsonwebtoken`, `kysely`, `zod` and the AWS SDK, as user 1000 (`arm64` on this arm64 host, `x64` through emulation) |

**Rationale.** Cross-compiling the TypeScript is unnecessary because the output is JavaScript;
because the production dependencies are pure JavaScript, one `node_modules` is right for both
platforms. That removes QEMU (a 10 to 15 minute emulated `pnpm install`) and the registry-side
juggling of per-platform pushes. Using the runner's Docker and no action keeps third-party code out of
the job that holds `packages: write` (FR-006) and the supply-chain bullet short. The risk that a
future dependency adds a native binary and silently breaks the other platform is caught by `smoke`,
which runs each platform natively (#4).

**Settled by the spike run of 2026-10-12** (both runner types): `docker load` cannot load the archive on the runners' classic image store, so the platform variant is loaded with `skopeo --override-arch … copy oci-archive:… docker-daemon:…` (V2); and BuildKit adds **default provenance attestation manifests** to the index (the copy reported "4 images generated from 4 images in list" for a two-platform build). That contradicts the clarified decision that v0.1 carries no attestation, and adds unknown/unknown entries to the index, so the build passes `--provenance=false --sbom=false` and a test of the build arguments (T006) and the smoke run (index holds exactly two manifests) hold it.

**Pushing the tested bytes.** `skopeo copy --all oci-archive:image.tar docker://…` copies an OCI
archive, all platforms, with the same digests, and is on the GitHub-hosted Ubuntu images (documented
tool list; **to verify in the first task**, #17). The fallback, if it is not, is `docker load` plus
`docker push` of each platform and `docker buildx imagetools create` for the index, which changes the
digest of the index but not of any platform image.

**Alternatives.** `docker/build-push-action` with QEMU (a third-party action in the privileged job, a
slow emulated install, and the image tested is not the image pushed unless a second invocation reuses
the cache); building each platform on its own runner and merging (what Docker's own documentation
shows, but it pushes by digest **before** the smoke test, which would put untested images in the
registry); a base-image change to a distroless or scratch final stage (a product-image change nobody
asked for).

**Side effect.** `.github/actions/setup-workspace` reads the Node major version from the Dockerfile's
`FROM node:` lines with a regular expression that does not allow `--platform=…` after `FROM`. It is
widened to allow an optional flag, and `docs/ci.md`'s description is updated. That Dependabot's Docker
ecosystem still proposes digest updates for a `FROM --platform=… image@digest` line is expected, not
verified (V8).

## 4. The smoke test

**Decision.** `smoke` runs twice, natively: `ubuntu-latest` for `amd64` and `ubuntu-24.04-arm` for
`arm64`. Each downloads the archive, loads **its** platform variant under the exact name and tag the
release compose file uses, and runs `docker compose -f docker-compose.release.yml up -d` and
`scripts/release/smoke.ts` (the seven steps of the contract, the seventh being the image's labels). The arm64 runner label is **free for
public repositories and generally available** (GitHub changelog, 7 August 2025; the repository is
public).

**Rationale.** It tests the file users will download, with the image that will be published, on each
platform, as a user would run it. The demo import through the real API in the same run is FR-004's
"imports the demo with nothing left out". The script is plain TypeScript with `fetch` (Node 22), run
with `tsx` as the other scripts are, and kept apart from the API's test helpers so that it has no
dependency on the app's source.

**Two details the analysis of 2026-10-12 settled.** (1) Step 5 ("Generate threats" on the imported demo)
fails the release only on a **stale** threat. A threat the run would **create** is printed as a notice,
because FR-026 makes it a CI warning and nothing more: failing the release on it would turn a warning
that was meant to wait for "a later change" into a blocker at tag time. (2) `SPECTER_VERSION` is set to
the full version for `smoke` and `verify-public`, so a candidate (`0.1.0-rc.1`) is found; and the labels
of FR-009 are checked as step 7 of `smoke` and again in `verify-public`, from one function that also
builds the label arguments, so the build and the check cannot disagree.

**Alternatives.** QEMU on one runner (slow, emulated Node under a database); only `amd64` natively
(would leave arm64 untested, and SC-002 asks for both); the Playwright browser tests against the
container (the browser tests already run against the built app; a second browser run in the release
path doubles its time for no new coverage of the image).

## 5. The gate, versions, pre-releases, `latest`

**Decision.** `scripts/release/gate.ts` is a pure decision function (arguments in, a result out) with a
thin command-line wrapper that gathers the inputs. The six refusals and the outputs are in the
[contract](./contracts/release-pipeline.md#the-gate-fr-002).

- **Pre-release versions are compared by their core.** A candidate `v0.1.0-rc.1` is accepted when the
  five packages, the changelog and the compose default say `0.1.0`; the image and release are tagged
  `0.1.0-rc.1`. So a rehearsal does not need a version-bump pull request and a second one to undo it.
  This reads FR-002 and FR-015 as "the version the tag is a candidate for" for a pre-release; a
  one-line note is added to FR-015 so that the spec and the plan agree.
- **`latest` is moved only by a final version that is not lower than any other final `v*` tag**
  (fetched with the checkout). A patch for an older line (`0.1.1` after `0.2.0`) does not take it, and
  neither does a candidate.
- **Resume** keys on the registry: image present with the tagged commit as its revision label means
  "published from this commit". Present with another commit means refuse (G6). This is the only
  place the pipeline compares against what already exists, and it never overwrites.

**Rationale.** Pure functions make SC-003's "100% of the six refusals" a set of fast unit tests with
no GitHub and no registry. Each refusal prints one line with the fix, so a maintainer who made a typo
learns what to do from the run.

**Alternatives.** Parsing the version in shell inside the workflow (untestable); reading the version
from the tag alone and not from the packages (FR-015 asks the packages to agree); a semver library
(a dependency for a regular expression and a three-number comparison).

## 6. Verifying that the required checks passed (G5)

**Decision.** The gate lists the check runs of the tagged commit
(`GET /repos/{owner}/{repo}/commits/{sha}/check-runs`, paginated) and requires, for each of the four
names in `.github/rulesets/main.json`, a run from the GitHub Actions app (the ruleset pins integration
id 15368) with conclusion `success`. A missing or running check is a refusal that says to wait and
re-run the workflow.

**Rationale.** `main` accepts only pull requests that passed those four checks and has no bypass
actor, and CI also runs on every push to `main`, so a commit that is on `main` has check runs of those
names; the gate states the fact and does not infer it. Re-running the whole of CI inside the release
(a reusable `workflow_call`) would repeat a 25-minute job whose result already exists, and would make
`ci.yml` callable (a change to a required workflow).

**Alternatives.** Trusting "on `main`" alone (a merge commit's own push-run could still be running or
could have failed after a revert); the combined-status API (it reports commit statuses, not check
runs, which is what Actions uses).

## 7. Protecting version tags (FR-011)

**Decision.** Two tag rulesets over `refs/tags/v*`, as definitions in `.github/rulesets/`, created with
the same `gh api` command the existing ruleset uses, and documented in `docs/ci.md`:

| Ruleset | Rules | Bypass |
|---|---|---|
| `release-tags` | `creation`, `deletion` | the repository owner only |
| `release-tags-immutable` | `update` | none: nobody can move a version tag |

**Rationale.** A ruleset's rules apply to everyone but its bypass actors, and one ruleset has one bypass
list, so "the owner may create or delete, nobody may move" is two rulesets. GitHub's documentation
**confirms** that `creation` limits who can create matching tags to bypassers and that `update` and
`deletion` do the same for those operations; the rest of the REST page lists the actor types
(`RepositoryRole`, `User`, `Team`, `Integration`, `OrganizationAdmin`, `DeployKey`) and notes that
`OrganizationAdmin` is not applicable to a personal repository.

**To verify before relying on it** (#17): which actor type a personal repository accepts as its
owner's bypass (`RepositoryRole` with the Admin role, or `User` with the owner's id), the exact form of
the tag pattern in `conditions.ref_name`, and that the owner's push of the tag is actually allowed
while a second account's is not. The tasks make this the first change to the repository's settings,
done by the maintainer, with the verification commands written into `docs/releasing.md`.

**Alternatives.** One ruleset with no bypass (nobody could create a tag at all); the older "protected
tags" setting (superseded by rulesets, with fewer rules); no protection and the gate alone (a pushed
tag still runs the workflow at its commit, which is the R5 residual: the gate cannot be its own
control).

## 8. The registry, the package and what it does not guarantee

**Decision.** The image is `ghcr.io/shivamsaraswat/specter`. The package is made public once, by the
maintainer, after the first publication, and `verify-public` proves it on every release.

| Fact (GitHub documentation, fetched) | Consequence |
|---|---|
| A new package's default visibility is private | the one-time public setting, and `verify-public` as the safety net |
| A package published from a workflow with the run's `GITHUB_TOKEN` is linked to the workflow's repository automatically | no extra step to link it; the source label and annotation make the link explicit |
| Public container images can be pulled anonymously | what `verify-public` and the quickstart rely on |
| The run's token "will not have permission" to push if the package was previously pushed to that namespace by another means and is not connected to the repository | the first push is the pipeline's: the maintainer must not pre-create the package by hand (the same page, read for what it does not say: it does not mention `packages: write` or a user-owned namespace, hence V5) |
| The page does not mention tag immutability | the registry will not stop a tag being overwritten by someone with write access, so FR-007 is held by the pipeline and the procedure, and R3 stays open until signing |
| The page does not say whether visibility can be changed by API | the docs say to do it from the package's settings; treated as a manual step |

**To verify:** that the annotation on the index is what links a multi-platform package (the page names
only the description annotation for multi-platform images), and that the first publication creates the
package under the user account with the run's token (#17).

**Rationale for the name.** The owner's lowercase namespace and the repository's name, no suffix, so
that the README's `docker pull` and the compose file say what the project is called.

## 9. The release compose file

**Decision.** `docker-compose.release.yml`, attached to each release as `docker-compose.yml`; its
database publishes no port, its app publishes `127.0.0.1:${PORT:-3000}:3000`, and its image is
`…:${SPECTER_VERSION:-0.1.0}`. The Postgres image is pinned by the digest CI already uses.

**Rationale.** FR-017: only the app is published. The loopback bind goes one step further for no cost:
a quickstart copied to a server is not reachable from the network until its operator says so, which
matters because the defaults (`admin`/`admin`) are weak by design and FR-040 forbids the product
refusing them. The default version being the release's own (checked, #11) gives the asset of a release a
reproducible start and a documented way to move (`SPECTER_VERSION`), which closes the one question left
Outstanding by the clarification (`latest` or pinned: pinned, with `latest` available to those who ask
for it by hand).

**Alternatives.** An override file next to the existing compose file (two files to download and merge
for a first run); making the compose file refuse unset secrets with `${VAR:?}` (a stronger default, and
a failed first run that SC-001 measures; the quickstart names each value to set instead); publishing
the database port "for convenience" (the existing contributor file does; this one must not).

## 10. Release notes and the changelog

**Decision.** `CHANGELOG.md` in Keep a Changelog form with three headings per entry; the release notes
are produced by `scripts/release/notes.ts` from the entry and the pipeline's facts, and checked by unit
tests ([contracts/release-artifacts.md](./contracts/release-artifacts.md)). GitHub's generated notes
are not used.

**Rationale.** One source of truth for what changed (FR-012, FR-013). A commit list says what a
maintainer did, not what a user can now do. The "not signed" sentence and the digest are mandatory
(FR-037, R3), and a function that builds them cannot forget.

## 11. Checks in `scripts/`

**Decision.** The version, link, workflow-policy, gate, notes and smoke checks are Vitest tests in the
workspace's existing `scripts/` project (`vitest run --root scripts`, already part of `pnpm test`),
with the code they test beside them. One **development** dependency is added to the root: `yaml`
(already in the lockfile as a transitive package at 2.9.1) to read workflow files by structure. There is
no runtime dependency and no new package (FR-040).

**Rationale.** `scripts/` is where repository-level checks already live (`check-licenses.ts` and its
test), runs without a database and is in the required `test` check. A regular expression cannot tell
which job a `permissions:` line belongs to, and the workflow policy (SC-009) is exactly that question.
The link check is a few dozen lines with the standard library; a Markdown parser or a link-checker
package would be a dependency for a rule this simple, and checking external URLs would make the build
depend on the network (not asked: FR-021 is about relative links and images).

**Alternatives.** A shell script in the workflow (untested, not run by `pnpm test` locally); a link
checker action (third-party, network); reading workflows with regular expressions (wrong for
permissions).

## 12. The demo

**Decision.** Authored in a running Specter, as Milestone 7 did, from the blueprint in
[data-model.md](./data-model.md#2-the-demo-model); exported with **Download Specter file** and committed
unedited in `docs/demo/`, beside a README. Checked by `apps/api/test/demo/`, which imports the
dogfood checks' modules and operations (FR-026). The pipeline attaches the same file to the release
and the smoke script imports the same file.

**Rationale.** Everything the dogfood checks need (schema, import with nothing left out, round trip,
stale and new threats, secret patterns) already exists and works on any Specter file; only the
shape rules (D4) differ, because the demo has other requirements than Specter's own model. Reuse by
import avoids a copy of 300 lines, and the two sets of checks cannot drift apart on what "imports with
nothing left out" means.

**Alternatives.** Putting the demo inside `docs/threat-model/` (a check holds that folder to three
files, and the two models are different things: M7's spec says so); generating the demo from a script
(a second source of truth for a file Specter itself should produce, as M7 decided); seeding it in the
app (ruled out by Clarifications 2026-10-12).

## 13. Screenshots

**Decision.** Four PNG files in `docs/images/`, taken by hand from the loaded demo in a 1400 × 900
window, cropped to the application (no browser chrome), no address or account visible, at most 600 KB
each and 3 MB together, embedded with alt text. How to retake them is written in the README.

**Rationale.** FR-020 and the Assumptions: pictures of the product, not tests; a script would be new
code to maintain for four images that are retaken a few times a year. The link check (L) keeps them
from being missing, oversized or without alt text; whether they are current is review's job.

**Alternatives.** Generating them with Playwright (reproducible, and then a test that must be kept in
step with the interface for the sake of a picture); an animated recording (size, and no alt text a
screen-reader user can use).

## 14. The Definition of Done test

**What exists today** (read, not assumed):

| Step of the sentence | Covered through the page by | Covered only by seeding in |
|---|---|---|
| `docker compose up` | nothing in the browser tests (they run against the built app, not a container) | the smoke script of this milestone covers the container |
| Sign in | `definition-of-done.spec.ts` (Phase 1's walk), `fixtures.signInAsNewAccount` | |
| Draw a DFD with a trust boundary | `diagram.spec.ts` (the toolbar adds every type, including `Add trust boundary`; flows are connected by gesture) | `report.spec.ts` and `threat-workflow.spec.ts` seed the diagram through the batch endpoint |
| Generate threats | `report.spec.ts`, `rule-engine.spec.ts`, `threat-workflow.spec.ts` click **Generate threats** | |
| Change statuses and add mitigations | `threat-workflow.spec.ts` (accept with a reason, add and mark a mitigation, mitigate) | `report.spec.ts` sets statuses and a mitigation through the API |
| Export a Markdown report and an OTM file | `report.spec.ts` (both downloads from the page) | |
| Re-import the OTM, nothing lost | `report.spec.ts` (the preview, the import, a comparison of elements, threats, mitigations, and a second generation that creates 0) | |

**Decision.** One new spec, `apps/web/e2e/phase-2-definition-of-done.spec.ts`, that does the whole
sentence in order in one test, reusing the helpers (`addNode`, `connect`, `untilSaved`, the account and
download helpers) and the assertions of the existing specs, with every step through the page: the
diagram is **drawn with the toolbar**, including a trust boundary that the API and web are dropped into;
statuses and the mitigation are set through the threat panel. The comparison at the end is
`report.spec.ts`'s. Its steps are `test.step`s named for the sentence.

**Rationale.** The gap is real and small: the halves exist, no test chains them, and the first half is
seeded in the tests that exercise the second. FR-027 names exactly this ("no step covered only by
seeding"). It is not a duplicate: `report.spec.ts` keeps its job (the report's content and the
unsaved-changes dialog); the new test keeps one (the sentence).

**Alternatives.** Extending `report.spec.ts` (it would then do two jobs and fail with an unhelpful
name); running the whole browser suite against the container (a second 10-minute run in the release
path for coverage the smoke script and the built-app run already give together).

## 15. The threat model, the constitution and the documents

**Decision.** In the same change: the constitution's Threat Model section records the assets, the entry
point, the boundary and the nine risks of [data-model.md](./data-model.md#3-new-risks-for-specters-own-threat-model)
(FR-036, FR-037), amends *Development Workflow & Quality Gates* by a sentence ("a release is published only by the
tag-triggered pipeline"), and its Sync Impact Report, version (1.12.0 → **1.13.0**, a MINOR: materially
expanded guidance, no principle added) and date are updated, with the justification of the write
permission that Governance asks for. The committed model is updated by the procedure in
`docs/threat-model/README.md`: import the file into a project named `Specter`, add the eight
whole-model threats and mitigations, export both files, run the checks. Its README's scope sentence
("through Phase 2 Milestone 6") is brought up to this milestone.

**Rationale.** Principle V and the PR template make this part of the milestone, not a follow-up. The
risks that have a proposed remedy name the Phase 6 item (a remedy is `proposed` only where the plan
schedules it, M7 FR-008; Clarifications 2026-10-12 put it there).

## 16. The name check

**Decision.** Not made by this plan. `docs/releasing.md` carries a section to record what was searched,
when, what was found and the decision, and `plan.md`'s "Name" open decision moves to **Decided** only
when the maintainers have filled it (FR-032, FR-035). The tag cannot be created until then.

**Rationale and one datum.** The spec treats it as a human gate. A single web search in this session
for a threat-modelling product called "Specter" found none, and found **SpecterOps**, an established
security company with open-source tools (BloodHound among them), in the same field; it also found
nothing about a trademark, and a search engine is not a trademark search. That is a reason to do the
check properly (the USPTO and EUIPO databases, GitHub and package registries for the name, the
company's own marks), not a result. The local `v1.0.0` tag's "Open Specter" is the same kind of datum.

## 17. What is not verified, and where it is

| # | Unverified | Why it matters | Where it is checked | If it fails |
|---|---|---|---|---|
| V1 | ~~`skopeo` is on `ubuntu-latest` and `ubuntu-24.04-arm` runner images~~ | `publish-image` copies the archive with it | **Verified 2026-10-12** (spike run, both runners): `skopeo` 1.13.3 is installed; `skopeo copy --all oci-archive:… docker://…` kept the index digest and every manifest digest identical to the archive's, on both | n/a |
| V2 | ~~`docker load` of the OCI archive loads the runner's platform variant~~ | `smoke` loads the image to run it | **Verified, and it does NOT work** (both runners, Docker 28.0.4, classic overlay2 store): `docker load -i image.tar` fails with `open …/blobs/json: no such file or directory`. **The fallback works**: `skopeo --override-arch <amd64\|arm64> copy oci-archive:image.tar docker-daemon:<name>:<tag>` loads the runner's own platform, the image runs natively, and its labels survive. So `smoke` and `verify-public` (for the archive) use `skopeo`, never `docker load` | decided: `skopeo … docker-daemon:` |
| V3 | Index-level source annotation links a multi-platform package to the repository | the package's page, its permissions | the rehearsal candidate | link by hand once from the package's settings, and say so in `docs/releasing.md` |
| V4 | ~~Personal-repository bypass actor type and the tag-pattern form for the two rulesets~~ | FR-011, risk R1 | **Verified 2026-10-12** (rulesets 24911587 `release-tags` and 24911595 `release-tags-immutable`): a personal repository accepts `{"actor_type":"User","actor_id":<owner id>,"bypass_mode":"always"}`; `refs/tags/v*` is the working pattern; with both live the owner could create and delete a disposable `v*` tag, and a force-push that moved it was refused ("push declined due to repository rule violations"), for the owner too. **Not tested**: that a second account cannot create a `v*` tag (no second account was available); that rests on GitHub's documentation of the `creation` rule | n/a |
| V5 | The first publication creates the package under the owner, and the run's token may push to it afterwards | the first release | the rehearsal candidate | grant the repository write access to the package in its settings (documented) |
| V6 | Dependabot's `docker-compose` ecosystem reads `docker-compose.release.yml` for the Postgres digest | keeping the pin fresh | the first Monday after the merge | refresh the digest by hand, listed in `docs/releasing.md`'s readiness list and `docs/ci.md` |
| V7 | ~~A fine-grained `checks: read` suffices to list another workflow's check runs for a commit~~ | gate G5 | **Verified** (spike run): a token with `contents: read`, `checks: read` lists `GET /repos/{owner}/{repo}/commits/main/check-runs` with name, status, conclusion and `app.id`; the four required checks come back `success` from app 15368, and a non-Actions check (Socket Security, app 156372) is also listed, which is why G5 filters on the app id | n/a |
| V8 | Dependabot's Docker ecosystem keeps proposing digest updates for `FROM --platform=$BUILDPLATFORM node:…@sha256:…` | the base image's pin stays fresh | the first Monday after the merge | refresh the digest by hand, as for V6 |
| V9 | GHCR's answer for a version that is not published | gate and `publish-image` decide "published or not" from it | **Verified anonymously on 2026-10-12**: a package that does not exist yet answers `denied` (HTTP 403), the same as a private one; "not found" appears only for a missing tag of an existing public package. **With the run's own token it is unverified.** The gate and `publish-image` therefore read `denied` as "not published", which cannot overwrite a version: overwriting needs write access, write includes read, so a token able to overwrite sees the image; a token denied the read is denied the push | the rehearsal candidate confirms the first publication and the second run's "found" |

None blocks the plan: each has a named fallback, each is exercised by the rehearsal candidate the
Clarifications call for, and the candidate is published before the version that matters.

## 18. Bookkeeping

`plan.md`: Phase 2 marked ✅ as Phases 0 and 1 are, "Name" moved to Decided (after #16). `README.md`:
status block, quickstart, limits, screenshots, roadmap row. `SECURITY.md`: supported versions.
`docs/ci.md`: the release pipeline, the tag rulesets and the manual refresh of the BuildKit pin.
`CONTRIBUTING.md`: how a change that is visible to a user adds a changelog entry (FR-013). No change to
`.github/pull_request_template.md`. `.github/dependabot.yml`: one added entry for the compose file if V6
holds.
