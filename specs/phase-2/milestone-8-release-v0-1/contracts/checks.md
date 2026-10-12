# Contract: the checks

Everything that holds this milestone to its spec and runs without a person. All of it runs in the
**required `test` check** of every pull request (Vitest, plus the Playwright step that is already
there), so no new job and no change to the ruleset of `main` is needed. The pipeline's own gate and
smoke code are also unit-tested here, which is how SC-003 is shown for each refusal without publishing
anything.

A failure of a check below uses the form Milestone 7 gave its checks, so a reader of the pull request
sees the same thing everywhere:

```text
<file>: <check> — <what is wrong>
  fix: <what to do>
```

## The checks

| ID | Check | Lives in | Fails the build when | Spec |
|---|---|---|---|---|
| **V** | Versions and changelog | `scripts/release/versions.test.ts` (with `scripts/release/versions.ts`) | the five workspace packages do not all carry one version; `docker-compose.release.yml`'s default version is not that version; `CHANGELOG.md` has no dated entry for it; the entry lacks one of the headings the contract names where it has content; the changelog lacks the sentence that links `docs/threat-model/` and `SECURITY.md` (FR-034); the compose copy made for a pre-release does not carry the full version as its default, or the copy made for a final release differs from the committed file | FR-013, FR-015, SC-004 |
| **L** | Links and images | `scripts/links.test.ts` (with `scripts/check-links.ts`) | a relative link or an image in `README.md`, `CHANGELOG.md`, `docs/releasing.md`, `docs/demo/README.md` or `docs/images/` points at a file that is not there; an image has no alt text; the README embeds fewer than four images; the images together exceed 3 MB or one exceeds 600 KB; the README or the changelog does not link to every target FR-021 lists | FR-020, FR-021, SC-006 |
| **W** | Workflow policy | `scripts/workflows.test.ts` | `release.yml` has a trigger other than a `v*` tag push (no branch, `pull_request`, `pull_request_target`, `workflow_dispatch` or `schedule`); any job of it other than `publish-image` (`packages: write`) and `release` (`contents: write`) holds a write permission, or those two hold one the contract does not name; `gate` holds anything other than `contents: read`, `checks: read` and `packages: read`; its default permissions are not none; it has no `concurrency` group or has `cancel-in-progress` other than `false`; a job that holds a write permission has a step that uses the local `setup-workspace` action or runs `pnpm`, `npm`, `npx` or `tsx` (such a job runs no repository code and installs nothing); job `build` uses `actions/cache` or `actions/download-artifact` (it builds the checkout of the tagged commit and nothing from elsewhere, FR-003); the `build` job's buildx command lacks `--provenance=false` or `--sbom=false`; the `gate` job declares an output that no job reads, or a job reads one it does not declare; the jobs' `if:` conditions, evaluated for a fresh release, a re-run of a published version and a failed build, smoke run, publish, anonymous pull or gate, let a job run after a failure upstream, or make a re-run rebuild or republish (spec FR-007, FR-010); any `uses:` of any workflow or local action outside the repository is not pinned to a 40-character SHA; any workflow references a secret other than `GITHUB_TOKEN`; a `run:` block of `release.yml` contains a `${{ … }}` expression other than a `needs.*.outputs.*` or `matrix.*` value (the event's own text, such as the tag name, may only enter through `env:`); a workflow other than the existing CodeQL one holds a write permission it did not hold before | FR-006, SC-009 |
| **G** | The gate | `scripts/release/gate.test.ts` (with `scripts/release/gate.ts`) | the gate does not refuse each of G1 to G6 with a message that names the condition, or refuses a good tag; resume, `is_latest` and the pre-release rule do not give the table of the pipeline contract | FR-002, FR-005, FR-007, SC-003 |
| **N** | Release notes | `scripts/release/notes.test.ts` (with `scripts/release/notes.ts`) | the changelog entry is not extracted exactly; the notes lack the image name, the digest, the "not signed" sentence, the threat model and `SECURITY.md` links; a pre-release lacks its sentence; the notes call the version secure | FR-012, FR-034, FR-037 |
| **S** | The smoke script | `scripts/release/smoke.test.ts` (with `scripts/release/smoke.ts`), against a fake server | any one of the seven steps of the pipeline contract, made to fail on the fake, does not fail the script with a message that names the step | FR-004, SC-003 |
| **D** | The demo | `apps/api/test/demo/` | see below | FR-023 to FR-026, SC-008, SC-012 |
| **E** | The Definition of Done | `apps/web/e2e/phase-2-definition-of-done.spec.ts` | the walk of [quickstart.md](../quickstart.md#2-the-definition-of-done-test) fails at a step; the message names the step | FR-027, SC-007 |
| **T** | The threat model (Milestone 7's checks, re-run) | `apps/api/test/dogfood/` (unchanged code) | the committed model, updated in this change, fails any check it already has | FR-038, SC-010 |

### D: the demo checks

They live next to the threat-model checks and reuse their modules (`checkForm`, `checkTies`,
`checkRoundTrip`, `classifyRegeneration`, `checkPatterns`, `publishedSchemaValidator` and the
operations that import, export, generate and report through the real API). They read
`docs/demo/notes-app.specter.json` and only read it.

| # | Fails when | Message names |
|---|---|---|
| D1 | The file is not what Specter writes, or does not match the published schema (`checkForm`) | the file, what is wrong |
| D2 | Specter's import refuses it or lists anything left out, or the model exported after an import differs from the file (apart from ids and the export time) (`checkRoundTrip`) | what the import said, or what differs |
| D3 | Two records of one kind could be ordered only by id (`checkTies`) | the records |
| D4 | The demo lacks what FR-024 lists: any of the five element types; a trust boundary holding an element; a flow that crosses it with security flags set; a STRIDE category with no threat; a status of the four with no threat, or an accepted or not-applicable threat with no reason; a mitigation state of the three with none; fewer than three risk levels among its threats; no threat of origin `rule` or none of origin `manual`; an AI-origin threat; a project or model name without the word "fictional" | the missing thing |
| D5 | "Generate threats" on the imported model **flags a threat stale** | the threat and the rule; says to retire or update it by the procedure in `docs/demo/README.md` |
| D6 | `docs/demo/` holds a file other than the two | the file |
| D7 | The demo, `CHANGELOG.md`, `docs/releasing.md`, `docs/demo/README.md` or `docker-compose.release.yml` hold a pattern of FR-043: a credential, an email address, an IP address, a cloud account identifier (`checkPatterns`) | the file, the line's kind, never the value |

D5's counterpart is a **warning, not a failure**: "Generate threats" would **create** a threat, because
a rule was added or widened. It is raised the way Milestone 7's is: a `::warning` annotation from a CI
step of its own that runs this one test as a single project (the existing step *Threat model
warnings*, extended to run the demo test too), naming the rule and the element and pointing to the
update procedure. The build passes (FR-026).

Each of D1 to D7 also has a test against a deliberately broken input in `checks.test.ts`, so none can
be a check that never fails (Principle II).

### E: the Definition of Done test

One browser test, in the order of the sentence, against the built app and the real database, with the
helpers the other specs share. Its steps and the existing tests that cover each part are in
[quickstart.md](../quickstart.md#2-the-definition-of-done-test) and
[research.md](../research.md#14-the-definition-of-done-test). Every step after starting the app is
driven through the page, and each `test.step` is named for its step, so a failure names it (SC-007).
Starting the container is the smoke script's step, run against the image by the pipeline.

## What none of these can check

Judged in review, and said so in the pull request (the last Assumption of the spec): that the
README's claims are true (FR-022), that the screenshots show what their text says (FR-020), that the
quickstart is understandable (FR-030), that the statuses of the new threats say something true
(FR-037), and the name check (FR-035). The repository's tag rulesets and the package's visibility are
settings, verified by the commands in `docs/releasing.md` and, for visibility, by every release's
`verify-public`.
