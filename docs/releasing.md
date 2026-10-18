# Releasing Scrylux

How a version of Scrylux is published, by whom, and what to do when it goes wrong. The pipeline is
[`release.yml`](../.github/workflows/release.yml); how it is built, and how every setting behind it is configured, is in
[`ci.md`](ci.md#release-pipeline). The design is in
[`specs/phase-2/milestone-8-release-v0-1/`](../specs/phase-2/milestone-8-release-v0-1/).

**A release is made by pushing one version tag.** Nothing else starts the pipeline, and nothing publishes from a person's
machine. The pipeline refuses a tag it should not release, builds the image from the tagged commit, proves it on both
platforms, publishes the tested image, proves it can be pulled with no login, and only then creates the GitHub release.

- The image is `ghcr.io/shivamsaraswat/scrylux`, tagged with its exact version (`0.1.0`), and `latest` for a final release that
  no higher final release outranks. A published version is **never replaced**.
- A release candidate (`v0.1.0-rc.1`) is published for real and marked as a pre-release. It never becomes `latest`, and it stays
  in the registry.
- The image is **not signed** and carries no build attestation or SBOM in v0.1; the release notes say so and give its digest.
  Verifiable release images are planned for Phase 6.

## Before the first release only: the name check

The project was first called Specter. The name check for v0.1 found it taken, so the project is named **Scrylux**. The record below is
the check. It is a screen against public registers and registries, **not legal clearance or a legal opinion**; the pipeline cannot check
a name, and a collision is the maintainer's decision.

| Field | Record |
|---|---|
| Searched (databases, queries) | 2026-10-18. US: the USPTO trademark search API, `SCRYLUX` exact, fuzzy (`~2`) and prefix (`SCRY*`). International: TMview (EUIPO, WIPO and about 75 offices), word and fuzzy. Registries: GitHub users, repositories and code; npm, PyPI, Docker Hub and crates.io. Domains: `.dev`, `.io`, `.ai` and `.com`. Web search for `Scrylux`. |
| Date | 2026-10-18 |
| Found | No trademark for `SCRYLUX` in the USPTO or in TMview. The nearest marks are `ACRYLUX` (US 7526419, roofing coatings and sealants, Class 2) and `SCRYBELEX` (US 6492508, business consulting, Class 35), different goods and different words. No repository, package, image, crate or product uses the name; the only other use found is a player handle in a game-tournament data file on GitHub. `scrylux` is free on npm, PyPI, Docker Hub, crates.io and as a GitHub user, and `scrylux.dev`, `.io`, `.ai` and `.com` were unregistered. |
| Decision | Use **Scrylux** for v0.1. "Specter" was dropped: SPECTER is a registered word mark of Specter, Inc. in Classes 9 and 42 (USPTO 8415311) for software for perimeter protection and monitoring, Pentest-Tools.com sells an autonomous pentest engine called Specter, and SpecterOps is a long-established security company. |
| Decided by | The maintainer, 2026-10-18. Obtain qualified trademark advice before any commercial use of the name. |

Claim the name once, before the first tag: register `scrylux.dev`, `scrylux.io` and `scrylux.ai`, and reserve `scrylux` on npm,
PyPI, Docker Hub and crates.io. The searches above show it free at the time they ran; they do not hold it.

## Readiness: confirm each before tagging

- [ ] The name check above is filled in, and the `scrylux` names are claimed.
- [ ] `main` has green `typecheck`, `lint`, `test` and `docker-build` on the commit to tag (the pipeline checks this too).
- [ ] The five `package.json` versions and the default of `SCRYLUX_VERSION` in `docker-compose.release.yml` all say the version
      (for a candidate, the version it is a candidate for), and `CHANGELOG.md` has a dated entry for it.
- [ ] Every capability the README, the changelog and the release notes claim has been tried on a running image.
- [ ] Someone who did not write the quickstart has followed it from a machine with Docker and no clone of the repository, and the
      times and findings are recorded in the pull request (spec FR-030): signed in within 5 minutes, the demo explored within 10.
- [ ] Scrylux's own threat model and the constitution's Threat Model section are up to date, and the committed model is `approved`
      ([`threat-model/`](threat-model/)).
- [ ] The pins that nothing refreshes for you are current (see [Refreshing the pins](#refreshing-the-pins)).
- [ ] You know what you are pushing: `git tag --list 'v*'` shows only tags you expect (see
      [Never push all tags](#never-push-all-tags)).

## One-time repository settings

These are settings, not files. [`ci.md`](ci.md#repository-settings-with-no-file-equivalent) lists them next to the others.

### Version tags are protected

Two rulesets over `refs/tags/v*`, kept as definitions in [`.github/rulesets/`](../.github/rulesets/):

| Ruleset | Rules | Bypass |
|---|---|---|
| `release-tags` (id `24911587`) | `creation`, `deletion` | the repository owner only |
| `release-tags-immutable` (id `24911595`) | `update` | nobody: no one can move a version tag |

Recreate them if they are ever deleted:

```sh
gh api -X POST repos/shivamsaraswat/scrylux/rulesets --input .github/rulesets/release-tags.json
gh api -X POST repos/shivamsaraswat/scrylux/rulesets --input .github/rulesets/release-tags-immutable.json
```

Verify that they are active:

```sh
gh api repos/shivamsaraswat/scrylux/rulesets --jq '.[] | "\(.id) \(.name) \(.target) \(.enforcement)"'
```

Prove the rules with a disposable tag (no release workflow starts for a tag whose name the gate refuses, and this one is deleted
at once). As the owner, creating it must work, moving it must be refused, and deleting it must work:

```sh
git tag v0.0.0-ruleset-check && git push origin v0.0.0-ruleset-check                 # succeeds
git tag -f v0.0.0-ruleset-check HEAD~1 && git push --force origin v0.0.0-ruleset-check  # refused: "repository rule violations"
git push origin --delete v0.0.0-ruleset-check && git tag -d v0.0.0-ruleset-check        # succeeds
```

This was run on 2026-10-12 with exactly these results. Not tested: that a second account cannot create a version tag (no second
account was available); that rests on GitHub's documentation of the `creation` rule.

**A caveat that a ruleset cannot remove.** A tag push runs the workflow as defined **at the tagged commit**. The gate cannot guard
against a commit whose gate was edited, so what protects the pipeline is who may create a tag. Whoever can create a version tag can
already change the workflow and the rulesets, so the tag adds no power an owner lacks; this is recorded as an accepted risk in
Scrylux's threat model until Phase 6 gives the project roles.

### The package is public (after the first publication, once)

A package published to a user account starts **private**. Anonymous pulls, and the pipeline's `verify-public` job, need it public.

1. Let the pipeline make the package: **do not create or push `ghcr.io/shivamsaraswat/scrylux` by hand first.** A package made by
   another credential is not connected to the repository, and the run's token cannot push to it.
2. After the first publication (a release candidate is the first), open the package's page from your profile → *Packages* →
   *scrylux* → *Package settings* → *Change visibility* → *Public*. Check that the package is linked to the repository
   (*Connect repository*, if it is not).
3. Re-run the failed `verify-public` jobs of that run. No second image is published, because the version already exists; the run
   completes the release.

Verify it, with no credentials:

```sh
DOCKER_CONFIG="$(mktemp -d)" docker pull ghcr.io/shivamsaraswat/scrylux:0.1.0-rc.1
```

## Rehearse with a candidate

A candidate is published for real, through the same pipeline, so the first run exercises everything: the gate, the build, both
platforms' smoke runs, the push, the anonymous pull and the release. It stays in the registry.

1. Confirm the commit on `main`, then tag it **by name**: `git tag v0.1.0-rc.1 <commit>` and `git push origin v0.1.0-rc.1`.
2. Watch the seven jobs: `gate`, `build`, `smoke` ×2, `publish-image`, `verify-public` ×2, `notes`, `release`.
3. Check: the release is marked **Pre-release** and is not the repository's latest; both assets are attached, and the attached
   `docker-compose.yml` names `${SCRYLUX_VERSION:-0.1.0-rc.1}`; the anonymous pull works (above) on an `amd64` and an `arm64`
   machine; `ghcr.io/shivamsaraswat/scrylux:latest` does not exist or has not moved.
4. Try a refusal on a disposable tag, then delete it (the owner may): `v0.1` (not a version), a tag on a commit that is not on
   `main`, `v0.2.0` while the packages say `0.1.0`. Each run must stop at `gate` with its message and publish nothing.

If a candidate fails in a way a check should have caught, the fix includes the missing test. Publish `v0.1.0-rc.2` and repeat.

## Release

1. Every item of [Readiness](#readiness-confirm-each-before-tagging) is ticked.
2. Tag the commit **by name** and push that one tag: `git tag v0.1.0 <commit> && git push origin v0.1.0`.
3. Verify, as for a candidate but for a final release: the release is marked **Latest**; `latest` and `0.1.0` have the same digest;
   the anonymous pull works on both platforms; the page shows the digest and says the image is not signed.

### Never push all tags

Push the one tag, by name. **Never `git push --tags`** (or `--follow-tags` with unexpected tags): a clone can carry local tags
the remote does not have. A tag from an unrelated history, which is not an ancestor
of `main`, would be refused by the pipeline (G2: not on `main`), but it should never be pushed.

## If a run fails

The pipeline refuses before it builds, and says what to do. The message is one line: `release refused: <condition>. <what to do>`.

| Refusal | Means | Do |
|---|---|---|
| G1 | the tag is not `vMAJOR.MINOR.PATCH` with an optional `-suffix` | delete the tag (`git push origin --delete <tag>`), push a correct one |
| G2 | the commit is not on `main` | merge first; delete the tag; tag the merge commit |
| G3 | a package version or the compose default differs from the tag's version | fix them in a pull request, merge, tag the merge commit |
| G4 | `CHANGELOG.md` has no dated entry for the version | add `## [x.y.z] - YYYY-MM-DD`, merge, tag |
| G5 | a required check is missing, failed or still running | wait for a running check and **re-run** the workflow; fix a failing one on `main` |
| G6 | the version's image exists and was built from another commit | never replace it: delete the tag and publish the next version |

Other failures:

- **`smoke` failed**: nothing was published. The message names the step (`smoke step 4 (demo import): …`). Fix it on `main`, delete the
  tag, tag again.
- **`verify-public` failed**: the image is published and the release is not created. The usual cause is a private package
  (above). Fix the setting and re-run the failed jobs; the run publishes nothing twice and creates the release.
- **A re-run** of any run for a version that is already published completes only what is missing: it does not rebuild or push.

## A bad release

A published version cannot be replaced, and its tag is not deleted or moved. If a published version turns out to be broken or
unsafe:

1. Edit the release's notes to say so and to point to the fix.
2. Publish the next version with the fix (bump the versions and the changelog in a pull request, then release as above).
3. If it is a vulnerability, follow [`SECURITY.md`](../SECURITY.md): a private advisory first.

## Refreshing the pins

Nothing refreshes these for you, and each is a supply-chain pin:

- **BuildKit**, in the *Create the builder* step of [`release.yml`](../.github/workflows/release.yml). Find the newest stable release and
  its digest, and update the one line:

  ```sh
  gh api repos/moby/buildkit/releases/latest --jq .tag_name
  docker buildx imagetools inspect moby/buildkit:<tag> --format '{{.Manifest.Digest}}'
  ```

- **PostgreSQL**, in [`docker-compose.release.yml`](../docker-compose.release.yml): the same digest `ci.yml` pins for its service
  container. Dependabot is configured to propose it (the `docker-compose` entry); whether it reads a file with this name is not yet
  confirmed, so check after the first Monday and refresh by hand if it did not.
- **The base image**, in the `Dockerfile` (Dependabot's `docker` entry).
- **First-party actions** are pinned by commit and refreshed by Dependabot's `github-actions` entry.

## Local note: two compose files, one project name

`docker-compose.yml` (the contributor's) and `docker-compose.release.yml` live in the same directory, so Compose gives them the same
project name and volume. To run the release file next to a working copy, name the project (`docker compose -p releasecheck -f
docker-compose.release.yml up -d`) and stop the contributor's stack first: its published database port is the thing the smoke run
checks is *not* open. A user who downloads the release's `docker-compose.yml` into a directory of their own has neither problem.
