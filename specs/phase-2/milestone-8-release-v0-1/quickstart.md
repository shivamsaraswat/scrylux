# Quickstart: validating Release v0.1

How to show, from a clean clone, that each part of this milestone works, in the order it is built.
Sections 1 to 4 run on a developer's machine and in the required `test` check; 5 to 7 are done by a
maintainer against the real repository and registry and are the readiness evidence (FR-029, FR-030).

Prerequisites: Node 22+ and pnpm (see [CONTRIBUTING.md](../../../CONTRIBUTING.md)), Docker, and the
local database of its Setup (`docker compose up -d db`). Section 5 onward also needs `gh` signed in as
the repository owner.

## 1. The checks that need no database

```sh
pnpm exec vitest run --root scripts                  # V, L, W, G, N, S
```

Expect every test to pass, and each refusal to be shown: a bad tag (`v0.1`, `0.1.0`), a commit not on
`main`, versions that disagree, a changelog with no entry, a missing check run, an image from another
commit. To see a check fail on purpose, change one package's version and re-run: `versions.test.ts`
names the two packages that disagree and the fix.

## 2. The Definition of Done test

The sentence of Phase 2, step by step, driven through the page, against the built app:

```sh
pnpm run build
pnpm --filter @specter/web exec playwright install chromium    # once
pnpm --filter @specter/web exec playwright test phase-2-definition-of-done
```

Its steps, which a failure names:

| `test.step` | What the test does | Reused from |
|---|---|---|
| 1. Sign in | a fresh account, through the sign-in page | `signInAsNewAccount` |
| 2. Draw | with the toolbar: a data store, two processes and an external entity, and a **trust boundary** that two of them are dropped into; two flows connected by gesture | `addNode`, `connect`, and `dropNodeAt`, which is local to `diagram.spec.ts` today and moves to `diagram-helpers.ts` (behaviour unchanged) |
| 3. Generate | **Generate threats**; the threat count is read from the page | `rule-engine.spec.ts` |
| 4. Work through | accept one threat with a reason; add a mitigation to another through the form, mark it implemented, mark the threat mitigated | `threat-workflow.spec.ts` |
| 5. Export | **Download Markdown report** and **Download OTM file**; the report's summary equals the page's counts | `report.spec.ts` |
| 6. Re-import | import the OTM file into another project through the preview; "Everything in this file will be imported"; elements, threats (title, category, status, reason, risk, origin) and mitigations equal the original; a second **Generate threats** creates 0 | `report.spec.ts` |

Break one step to see it fail by name: rename the **Download OTM file** button in a scratch branch, or
drop the `parent_boundary_id` save, and run it again.

## 3. The demo and its checks

Author (once, by hand, as Milestone 7 did) from [data-model.md](./data-model.md#2-the-demo-model):
start Specter (`docker compose up --build`), sign in, create the project and the model, draw the
sixteen elements, **Generate threats**, triage by the targets, add the one manual threat, set the
threat model's status to `in_review`, and **Download Specter file**. Save it **unchanged** as
`docs/demo/notes-app.specter.json`.

Then:

```sh
pnpm --filter @specter/api exec vitest run test/demo
```

D1 to D7 pass. Then break each in turn in a scratch copy (edit a threat's status in the JSON, retire
the rule behind one threat in `packages/threat-library`, add an email address to
`docs/demo/README.md`, add a third file to `docs/demo/`) and see the matching check fail with the file,
what is wrong and the fix. Add a rule that proposes one new threat to the demo's elements and see the
build pass with a *Threat model warnings* annotation that names the rule and the element.

## 4. The container, as the pipeline will run it

Build both platforms as the pipeline does, run one, and run the smoke script against it:

```sh
docker buildx create --name release-check --driver docker-container
SHA=$(git rev-parse HEAD)
docker buildx build --builder release-check --platform linux/amd64,linux/arm64 \
  $(pnpm --silent exec tsx scripts/release/versions.ts labels 0.1.0 "$SHA" | sed 's/^/--label /' | tr '\n' ' ') \
  --output type=oci,dest=image.tar .
# load the platform of this machine as ghcr.io/shivamsaraswat/specter:0.1.0, then:
docker compose -f docker-compose.release.yml up -d
pnpm exec tsx scripts/release/smoke.ts http://127.0.0.1:3000 docs/demo/notes-app.specter.json \
  0.1.0 "$SHA" ghcr.io/shivamsaraswat/specter:0.1.0
docker compose -f docker-compose.release.yml down -v
```

Expect the seven steps of the pipeline contract to pass, in order, and `docker compose … ps` to show only
the app with a published port, on `127.0.0.1`. Stop the database service and run the script again to see
the health step fail by name.

## 5. Rehearse with a candidate (FR-029, SC-011)

Done by the maintainer, after the pull request merged and after the one-time settings of
[docs/releasing.md](../../../docs/releasing.md): the two tag rulesets, checked with their verification
commands; and, **once, after the first publication**, the package set to public.

1. Confirm the commit on `main` has green `typecheck`, `lint`, `test`, `docker-build`.
2. `git tag v0.1.0-rc.1 <commit> && git push origin v0.1.0-rc.1` (that one tag, by name).
3. Watch the run: `gate`, `build`, two `smoke`, `publish-image`, two `verify-public`, `notes`, `release`.
4. Check: the release is marked **Pre-release** and is not the repository's latest; both assets are
   attached; the attached `docker-compose.yml` names `…:${SPECTER_VERSION:-0.1.0-rc.1}` (the candidate's
   own tag, not `0.1.0`); `docker pull ghcr.io/shivamsaraswat/specter:0.1.0-rc.1` works with
   `DOCKER_CONFIG` pointing at an empty directory; `…:latest` does not exist or has not moved.
5. If `verify-public` fails the first time (the package is private), set it public, **re-run the failed
   jobs**, and see that no second image is published and the release is then created.
6. Try each refusal on a disposable tag (`v0.1`, a tag on a branch commit, `v0.2.0` while the packages
   say `0.1.0`): the run stops at `gate` with the message of the contract and publishes nothing; delete
   the tag.

If a candidate fails in a way the checks of sections 1 to 4 should have caught, the fix includes the
missing test. Publish `v0.1.0-rc.2` and repeat; candidates stay in the registry.

## 6. The clean-machine walkthrough (FR-030, SC-001)

On a machine with Docker and **no clone of the repository**, by someone who did not write the
quickstart, following only the README, with a stopwatch. The README's release-facing text (the
quickstart, the status, the demo download) is in the second pull request (tasks.md T052), not yet merged
at this point: follow the README **of that pull request's branch**, and the candidate's release assets:

1. Download the release's `docker-compose.yml`, `docker compose up -d`, open the address, sign in.
   *Stop the clock at the project list: 5 minutes or less (not counting the image download).*
2. Download `notes-app.specter.json`, **Import threat model**, open it, find the trust boundary, a
   threat of each status, the risk summary, and download the Markdown report.
   *10 minutes or less in all.*
3. Read every claim of the README, the changelog and the release notes and tick it against the app
   (SC-005); note each claim that is not true or not demonstrable.
4. Run `docker compose ps` and confirm only the app is published, on the loopback address.
5. On an ARM machine (or an ARM runner), repeat 1 and 2.

Record the result, the times and the findings in the pull request. A defect that stops the quickstart
working is fixed under FR-040 with a test that fails first; anything else is an issue.

## 7. Release

1. The name check is recorded (FR-035) and `plan.md`'s "Name" is Decided.
2. Every item of the readiness list in `docs/releasing.md` is ticked in the pull request.
3. Merge the second pull request (the release-facing text of tasks.md T052: the README's status,
   quickstart and demo download, the roadmap's ✅, `SECURITY.md`'s supported versions and `plan.md`'s
   Phase 2 and Name), so that the front page describes a release only in the minutes before it exists.
   `git tag v0.1.0 <commit> && git push origin v0.1.0`, with `<commit>` the merge of that pull request.
4. Verify as in 5.4, for the final release: the release is **Latest**, `latest` points at the same
   digest as `0.1.0`, the anonymous pull works on both platforms, and the release page shows the digest.
5. Tick the Definition of Done of Phase 2 in the pull request that closes the milestone.

## 8. What review decides

Said in the pull request, as the spec's last Assumption requires: that the README's claims are true,
that the screenshots show what their text says, that the quickstart is understandable, that the
statuses of R1 to R9 say something true (the traceability list of data-model.md §3), and the name check.
