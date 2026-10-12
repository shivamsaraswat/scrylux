# Pull request: Release v0.1 (Phase 2 / Milestone 8)

Spec: [spec.md](./spec.md) · Plan: [plan.md](./plan.md) · Tasks: [tasks.md](./tasks.md)

## Summary

This turns the repository into something a stranger can run, and adds nothing to the product (no product source, migration, endpoint or
runtime dependency changed; one **development** dependency, `yaml`, was added).

- **A release pipeline** (`.github/workflows/release.yml`), started only by the push of a `v*` tag. A gate refuses six conditions before
  anything is built; a two-platform image is built from the tagged commit, smoke-tested natively on `amd64` and `arm64`, and **the
  tested archive is pushed byte for byte**; the image is then pulled with no credentials, and only then is the GitHub release created.
- **The image and the quickstart file**: the Dockerfile's builder stage runs on the build machine so that one build serves both
  platforms; `docker-compose.release.yml` publishes only the app, on the loopback address.
- **The demo threat model** (`docs/demo/`), a fictional note-taking app authored in a running Specter and held by checks of Milestone 7's kind.
- **The proof**: one browser test that does Phase 2's Definition of Done through the page, and the smoke run against the container.
- **The words**: `CHANGELOG.md`, release notes built from it, `docs/releasing.md`, the README's screenshots, limits and (in the second pull
  request) quickstart, `SECURITY.md`'s supported versions.
- **The release in Specter's own threat model**: nine risks, constitution 1.12.0 → 1.13.0, the committed model updated.

### Two pull requests

Some edits say a release exists. They are **not in this pull request**: they are in a second one that merges right before the final tag, so
that `main` describes a release only when it is about to exist (and never, if the name check finds a collision). They are the README's
status block, quickstart and demo download and the roadmap's ✅, `SECURITY.md`'s supported versions, and `plan.md`'s Phase 2 heading and
"Name" decision. The second pull request is opened as a draft from this one's tip. This pull request passes every check without them.

## How this satisfies Principles I–VI

| Principle | How |
|---|---|
| **I. Secure coding** | No route, input path, SQL or credential in the application. The one new input is the pushed tag's name: it never appears in a script expression, it is validated by shape (gate G1) before anything uses it, and a refusal message that names it is escaped, because a tag such as `v1%0A::…` would otherwise inject a workflow command (tested). No secret is added: the only credential is the per-run token. The image is built from a clean checkout filtered by `.dockerignore`; the demo and the release's text files are scanned for credential patterns (D7). |
| **II. Test-first** | Every script and check has its test written and seen failing first (`versions`, `notes`, `gate`, `smoke`, `links`, the workflow policy, the demo's shape checks); each check is also shown failing on input made to break it. The Definition of Done test exercises behaviour that already existed, so it passed at once; the one defect it surfaced is recorded below, not fixed (FR-040). |
| **III. Simplicity** | One development dependency, used. No third-party action, no QEMU, no release tool. The demo is a file loaded by the existing import. The seven-job pipeline is justified below. |
| **IV. Maintainability** | No environment variable is read by the app. `SPECTER_VERSION` is a Compose variable of the quickstart file. Every pin that is refreshed by hand (BuildKit, the PostgreSQL digest) is written down in `docs/ci.md` and `docs/releasing.md`. |
| **V. Threat-aware design** | The release is a new entry point, new assets and a new trust boundary, so the constitution's section and the committed model are updated **in this change** (below). |
| **VI. AI output is a draft** | No AI feature; the demo holds no AI-origin threat (checked). |

## Security implications

The release pipeline is the first workflow in the project that holds a **write permission**, and this pull request is where that is justified (Governance).

- **Two jobs, nothing else.** `publish-image` holds `packages: write`, and `release` holds `contents: write`. The workflow's default is none. `gate` holds three read scopes; every other job holds `contents: read`.
- **Neither write job runs repository code or installs a dependency.** They run `docker`, `skopeo` and `gh`. What needs the workspace's dependencies (the release notes, the compose file a release attaches) is made in the read-only `notes` job and handed over as an artifact.
- **The token is per run**, ends with the job, and is the only secret referenced anywhere. No third-party action is used by the release workflow.
- **Six refusals precede the build**, and a published version is never replaced: a re-run completes only what is missing. The tested archive is the pushed archive (the digest is compared after the push).
- **Tag creation is the control that matters**, because a tag push runs the workflow *as defined at the tagged commit*. Two tag rulesets (applied and proven) let only the owner create or delete a `v*` tag and let nobody move one. The residual (whoever can create a tag can already change the workflow) is recorded as an accepted risk until Phase 6.
- **What holds this**: `scripts/workflows.test.ts` fails the build if any other job gains a write permission, if a write job installs or runs a script, if any action is unpinned, if a `run:` block contains event text, if the build leaves BuildKit's attestations on, or if any workflow references a secret. What review holds: the repository settings (rulesets, the package's visibility), and whether the workflow's logic is right (the first run is the rehearsal candidate).
- **Not in v0.1, by decision**: signing, build attestation and an SBOM. The image is not signed; the release notes say so and give the digest. Recorded as an open risk with the Phase 6 item as its proposed remedy.

## Threat Model

Updated in this change: the constitution's Threat Model section (assets: the published image and the publishing credential; trust boundary: the release pipeline against the pull-request pipelines; entry point: the creation of a `v*` tag; nine risks), its Sync Impact Report (**1.12.0 → 1.13.0**, a MINOR), and `docs/threat-model/` (both files, by the procedure of its README, plus two existing mitigations corrected because they were no longer complete). The model is set to **in review** until a maintainer reads this list.

**Traceability list** (the constitution's wording against the committed threat; all nine agree):

| # | STRIDE | Threat in the committed model (whole model) | Constitution says | Model says | Agree |
|---|---|---|---|---|---|
| R1 | Spoofing | A version tag is forged by someone who is not a maintainer | Mitigated (Phase 2 Milestone 8) | mitigated (verified, implemented) | yes |
| R2 | Tampering | A build or release step is replaced with a malicious one | Mitigated (Phase 2 Milestone 8) | mitigated (implemented, verified) | yes |
| R3 | Tampering | A published image is replaced after publication | Open risk (Phase 2 Milestone 8) | open (proposed, verified, implemented) | yes |
| R4 | Elevation of Privilege | The publishing credential is stolen or broader than needed | Mitigated (Phase 2 Milestone 8) | mitigated (verified, implemented) | yes |
| R5 | Elevation of Privilege | A tag push runs the release workflow as defined at the tagged commit | Accepted risk (Phase 2 Milestone 8) | accepted (no mitigation; reason) | yes |
| R6 | Repudiation | A user cannot tell who built an image or from which commit | Open risk (Phase 2 Milestone 8) | open (proposed, verified) | yes |
| R7 | Spoofing | A look-alike image or registry is mistaken for the project's | Accepted risk (Phase 2 Milestone 8) | accepted (no mitigation; reason) | yes |
| R8 | Information Disclosure | A secret reaches the image, a release asset or the pipeline's log | Mitigated (Phase 2 Milestone 8) | mitigated (verified, implemented) | yes |
| R9 | Elevation of Privilege | An install is left running on the documented default credentials | Open risk (Phase 2 Milestone 8) | open (implemented, verified) | yes |

## Testing

Written first and seen failing, then passing. Run locally on this branch:

- `pnpm typecheck`, `pnpm lint` (license check: 148 shipped packages, all allowed): clean.
- `pnpm test`: web 666, API 1,129 (including the 48 of the demo and the 126 with Milestone 7's), scripts 248: all pass.
- `pnpm run build`, `pnpm --filter @specter/web verify:build`, `pnpm test:e2e`: **60 browser tests pass**, including `phase-2-definition-of-done.spec.ts`.
- `docker build --pull .` and `docker compose build`; the contributor path (`docker compose up --build`) is unchanged.
- The image, built as the pipeline builds it (BuildKit pinned by digest, labels from `versions.ts`, no attestations): exactly `linux/amd64` and `linux/arm64`, six labels on each, run through the **seven smoke steps** against the release compose file (with the real demo) and made to fail by name for a stopped database (step 3), nothing listening (step 1, after 60 s) and a wrong version (step 7).
- The quickstart's commands run as written from a directory holding only the downloaded compose file: up, sign in, only the app published on loopback, `pg_dump`, data survives `down`/`up`, `SPECTER_VERSION` overrides, `down -v` wipes.
- **Platform spike on the real runners** (both `ubuntu-latest` and `ubuntu-24.04-arm`, a throwaway branch, deleted): `skopeo` 1.13.3 is there and `copy --all` keeps every digest; `docker load` of the archive **fails** on the runners' image store (the pipeline uses `skopeo … docker-daemon:` instead); a `checks: read` token lists another workflow's check runs; BuildKit adds attestation manifests by default (switched off).
- **The tag rulesets proven** with a disposable tag: create as owner works, a force-move is refused even for the owner, delete as owner works. Not tested: that a second account cannot create a `v*` tag (none was available).

**Each check was shown to fail** on a break made for the purpose, and the repository restored: the workflow policy (five mutations, each caught by the intended clause), the demo checks (D1 to D7, and a new rule that only warns), the Definition of Done test (five product features broken, each naming its step), the version check (four conditions on the real files). These are the breaks and what failed:

| Check | Break made (then restored) | What failed |
|---|---|---|
| Workflow policy | event text in a \`run:\` block; \`pnpm install\` in the release job; a third write permission; an unpinned action; attestations left on | the clause meant for each, and only it (the permission one also trips two neighbours) |
| Demo D1/D2/D4 | an open threat set to accepted with no reason; the file re-indented; the hand-written threat removed | D1 and D4; D1; D4 and D1 |
| Demo D5 | a rule retired under a demo threat | D5 (stale) |
| Demo D7 | an email address added to \`docs/demo/README.md\`; \`CHANGELOG.md\` deleted | D7, the line named and the value not printed; D7, the file named |
| Demo D6 | a third file in \`docs/demo/\` | D6 naming it |
| Demo warning | a new valid rule that proposes a threat | passes; three \`::warning\` annotations name the rule and each element |
| Definition of Done | "Add trust boundary" makes a process; Generate threats does nothing; accepting does not save; the report is empty; the OTM import loses a threat | steps 2, 3, 4, 5 and 6, by name |
| Job conditions | the F-4 condition put back; `release` no longer requires its notes; `notes` no longer requires the anonymous pull | the scenario tests, by name (a smoke failure must run nothing downstream) |
| Version check | one package at 0.1.1; the compose default at 0.2.0; the entry undated; the entry deleted | each names the file, the versions and the fix |
| Not-published pattern | one word of the workflow's copy changed | the drift test (the gate's and the workflow's lists must be identical; also checked under GNU `grep`) |
| Gate outputs | an output declared and unread; an output read and undeclared | the output clauses, both directions |
| Smoke | the database stopped; nothing listening; the wrong version | step 3; step 1 after 60 s; step 7 naming the label |

## Findings (FR-040)

None of these stopped a model being accurate, so none is fixed here; F-3 and F-4 are corrections to this milestone's own work.

| # | Finding | Disposition |
|---|---|---|
| F-1 | Right after a mitigation is saved from the threat panel, choosing "mitigated" on that threat is refused again ("Mark one of its mitigations implemented or verified first.") in 4 of 6 runs: the status control still holds the mitigation list from before. A second try works. | **Issue to open**; the Definition of Done test retries as a person would. |
| F-2 | A single measurement of the boundary's on-screen box dropped nodes outside it (scrolling the canvas into view and the view re-fitting both shift it). | Test only; fixed in the test. |
| F-3 | The demo's first layout (840 px wide) rendered at half scale in the 575 px canvas, unreadable in a screenshot. | Fixed: restacked narrow and tall; the demo was regenerated, counts unchanged. |
| F-4 | The attacker's-eye review of `release.yml` found that `verify-public` accepted a *skipped* `publish-image`, which also happens when `smoke` fails; it would have run on an empty digest and blamed a private package. Nothing could have been published, but the message misled. | **Fixed** in `release.yml`, and now **regression-tested**: scenario tests evaluate every job's `if:` for a fresh release, a re-run, and a failed build, smoke run, publish, anonymous pull or gate. Putting the old condition back is caught (and two neighbouring broken conditions are too). Added by `/speckit-converge`, which found that the fix had gone in without a test (Principle II). |
| F-5 | GHCR answers "denied" (403) for a package that does not exist yet, so "not found" alone would have refused the first release. | Handled: "denied" is read as "not published", which cannot overwrite (write includes read). **Unverified with the run's own token: the rehearsal candidate confirms it** (research #17, V9). |
| F-6 | Two of my first break-it mutations did not compile (TypeScript narrowing), so they proved nothing; and a first probe rule had a duplicate title and was refused, making a first "warning only" pass vacuous. | Redone with mutations that compile and a valid rule. |
| F-7 | Something in this environment stages files (`git add`) behind the scenes. `git checkout -- <file>` restores from the index, so a staged mutation survived once. | Mutations are restored with `git restore --source=HEAD --staged --worktree` from then on; no file under `apps/*/src` or `packages/` differs from HEAD. |

## What review decides

Not testable by a program: that the README's, the changelog's and the release notes' claims are true (FR-022: each was read against the app while writing, and the clean-machine walkthrough repeats it); that the screenshots show what their text says (FR-020: viewed at full size, no account name or address); that the quickstart is understandable (FR-030: **a person who did not write it follows it on a clean machine, on the candidate**); that the statuses of R1 to R9 say something true (the list above); and the **name check** (FR-035), which is the maintainers' decision and gates the tag.

## Convergence

`/speckit-converge` found six gaps after the implementation and they are closed (tasks T063 to T068): the missing regression test for F-4 (the one rated CRITICAL), the "not published" pattern written twice and now tied by a test, a stale sentence in `docs/ci.md`, two gate outputs no job read (and one the contract did not list), a dead export, and two things the contracts did not mention (the `::error::` escaping).

## Not done in this pull request

The release itself. Tasks T052 to T062 need the merge, the repository's settings and a registry: the second pull request, the name check, a release candidate (`v0.1.0-rc.1`), the refusal rehearsals, the clean-machine walkthrough on both architectures, re-approving the model, the final tag, and the post-release Dependabot check. See `docs/releasing.md`.

## Spec coverage

Every FR and SC, and what holds it. **T** = a test in the required `test` check; **R** = review; **P11** = a step of Phase 11 (after the merge).

| Requirement | Held by |
|---|---|
| FR-001 trigger | T: `workflows.test.ts` (only a `v*` tag push) |
| FR-002 refusals | T: `gate.test.ts` G1 to G6 and their order; P11: refusal rehearsals |
| FR-003 clean checkout | T: `workflows.test.ts` (the build uses no cache, no artifact); the build job's context is the checkout |
| FR-004 smoke | T: `smoke.test.ts` (seven steps, each failing by name); run on the real image locally; P11: on the runners |
| FR-005 pre-release | T: `gate.test.ts` (`is_latest`, candidates), `notes.test.ts`; P11: the candidate |
| FR-006 least permission | T: `workflows.test.ts` (permissions, pins, no secret, no event text); five mutations caught |
| FR-007 immutable | T: `gate.test.ts` (G6, resume, and the pattern shared with the publish step); `workflows.test.ts` (what runs after a failure); the publish step re-checks and compares digests; P11 |
| FR-008 two platforms | the archive's index is checked in the workflow; inspected locally; P11: native smoke on both |
| FR-009 labels | T: `versions.test.ts`, `smoke.test.ts` step 7; inspected on the built archive |
| FR-010 anonymous pull | the `verify-public` job; P11 |
| FR-011 tag protection | applied and proven (rulesets 24911587, 24911595); documented in `docs/ci.md`, `docs/releasing.md` |
| FR-012 release page | T: `notes.test.ts`; P11 |
| FR-013, FR-014 changelog | T: `versions.test.ts` on the real file; R |
| FR-015 one version | T: `versions.test.ts` (`checkVersions`, broken four ways on the real files), `gate.test.ts` G3 |
| FR-016 to FR-018 quickstart | file in this PR; the README text is in the second; commands run as written; P11: walkthrough |
| FR-019 status and limits | Limits here (T: `links.test.ts` for its links); status in the second PR |
| FR-020, FR-021 screenshots and links | T: `links.test.ts` on the real files (both states of the README); R |
| FR-022 claims are true | R; P11 |
| FR-023 to FR-026 demo | T: `apps/api/test/demo/` D1 to D7 (48 tests), broken seven ways; the demo is a file, no seeding |
| FR-027 Definition of Done | T: `phase-2-definition-of-done.spec.ts`, five steps broken and caught |
| FR-028 container | the smoke run, locally and in the pipeline |
| FR-029 releasing procedure | `docs/releasing.md`; P11: followed for the candidate |
| FR-030 walkthrough | P11 |
| FR-031, FR-032 `SECURITY.md`, `plan.md` | the second pull request |
| FR-033 retake procedure | in the README (here); R |
| FR-034 no "secure", where risks are, how to report | T: `notes.test.ts`, `versions.test.ts` |
| FR-035 name check | P11, the maintainers |
| FR-036 to FR-039 threat model | T: Milestone 7's checks on the updated files (126 tests with the demo's); the list above |
| FR-040 no product change | verified against HEAD: no product source, migration or OpenAPI change |
| FR-041 contributor path | `docker build`, `docker compose build`, `docker compose up --build` run; README section kept |
| FR-042 settings documented | `docs/ci.md`, `docs/releasing.md` |
| FR-043 no secrets | T: D7 (the demo, its README, the changelog, `docs/releasing.md`, the compose file); R for the screenshots |
| SC-001, SC-005, SC-011 | P11 (walkthrough, claims ticked, rehearsal by a second person) |
| SC-002 | the `verify-public` job on both platforms; P11 |
| SC-003 | T: `gate.test.ts`, `smoke.test.ts`; P11: refusal rehearsals |
| SC-004 | T: `versions.test.ts` |
| SC-006 | T: `links.test.ts` (564 KB of screenshots, largest 248 KB) |
| SC-007 | T: the Definition of Done test (stable over repeated runs) |
| SC-008 | T: D1 to D5 |
| SC-009 | T: `workflows.test.ts` |
| SC-010 | T: Milestone 7's checks; the traceability list |
| SC-012 | T: D7; R for the screenshots |
