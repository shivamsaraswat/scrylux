# Feature Specification: Release v0.1

**Feature Branch**: not yet created (spec directory `phase-2/milestone-8-release-v0-1`)

**Created**: 2026-10-12

**Status**: Implemented through T051 (this pull request); the release itself (T052 to T062) waits for the merge and the maintainer

**Input**: User description: "let's take milestone 8 of phase 2". This covers Phase 2 / Milestone 8
of `plan.md` (line 135): "Release v0.1. README with screenshots and a quickstart, a bundled demo
threat model, versioned images on GHCR, a changelog, and a GitHub release."

Milestones 1 to 7 built the product and kept it honest: a diagram editor, a rule library and engine,
a threat workflow, reports, import and export, and Specter's own threat model. None of it can be
used by anyone who has not cloned the repository and built it. `plan.md` calls Phase 2 "the release
that gets shared publicly", and its Definition of Done ends with "v0.1 is tagged and published".
This milestone does that. It is made of six parts:

- **a published, versioned image**: built by the project's pipeline from a tagged commit, pullable
  by anyone, started in one documented step;
- **a release a reader can trust**: a changelog, release notes taken from it, one version number that
  reads the same everywhere, and a supported-versions statement that is true;
- **a front page that tells the truth**: a README with screenshots, a quickstart that uses the
  released image, and a status that says what v0.1 is and is not;
- **a demo threat model**: a small, fictional model a new user loads to see every part of the product
  at work, available to someone who never clones the repository;
- **the proof**: the Phase 2 Definition of Done, walked in a real browser, and the checks that stop a
  release which should not go out;
- **the release in Specter's own threat model**: publishing is a new entry point, a new asset and the
  first job in the project that holds a write permission, so the constitution's Threat Model section
  and the committed model of `docs/threat-model/` change with it (Principle V).

It adds no feature to the product. Everything that exists is already built; this milestone makes it
reachable, and makes the claims made about it checkable.

**Not in this milestone**: signing or attesting images and a software bill of materials (all three are
scheduled for Phase 6, in `plan.md`), any registry other than GHCR, a Helm chart (Phase 6), a hosted
demo (an unscheduled idea), a public website or announcement, packages published to a language
registry, binaries, and any telemetry or update check. Each is either scheduled for a later phase or
not asked for; see the Assumptions.

## Clarifications

### Session 2026-10-12

- Q: Should v0.1's published image carry any proof of where it came from (a build attestation or
  signature), or ship with none and record that gap as a risk? → A: None in v0.1; the gap is recorded as
  a risk (FR-037). Signing, build provenance attestation and a software bill of materials are scheduled
  in `plan.md` as a Phase 6 item, which makes the remedy a proposed mitigation in the threat model.
- Q: How should the bundled demo threat model reach a new user: a downloadable file loaded with the
  existing import, or built into the app or image? → A: A file attached to the release (and kept in the
  repository), loaded with the existing import. The app does not seed it, offer a button for it, or
  ship it inside the image (FR-023, FR-040).
- Q: Before tagging v0.1.0, should the maintainers rehearse by publishing a real pre-release, or with a
  dry run that publishes nothing? → A: A real pre-release (`v0.1.0-rc.N`), published through the same
  tag-triggered pipeline. The pipeline has no dry-run or manual mode (FR-001), and the rehearsal's
  image and release stay in the registry, marked as a pre-release (FR-005, FR-007).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A maintainer publishes a version safely (Priority: P1)

A maintainer has a commit on `main` that passed every required check and wants to publish v0.1.0.
They create the version tag and the project's pipeline does the rest: it checks that the tag is one
it should release, builds the image from that commit, runs it against a database and confirms it
works, publishes it under the version, and creates the GitHub release with its notes. If anything is
wrong, nothing is published, and the message says what and what to do.

**Why this priority**: this is the milestone. Without a trustworthy way to publish, there is no
release, and a publishing path that can be fooled into shipping the wrong thing is worse than none:
it holds the project's only write credential and its output is what users will run.

**Independent Test**: Rehearse on a pre-release version: tag a commit of `main`, watch the
pipeline publish an image and a release marked as a pre-release, pull the image with no login, and
check that `latest` did not move. Then, one at a time, make each refusal condition true (tag on a
commit that is not on `main`, version that differs from the packages', no changelog entry, version
already published, smoke run failing) and check that nothing was published and the message names the
condition.

**Acceptance Scenarios**:

1. **Given** a maintainer's version tag on a commit of `main` whose version matches the packages and
   the changelog, **When** the pipeline runs, **Then** it builds the image from a clean checkout of
   that commit, starts it against a database, and only if it is healthy, signs in and loads the demo
   with nothing left out, publishes it, and creates the release.
2. **Given** a version tag on a commit that is not on `main`, **When** the pipeline runs, **Then** it
   refuses, and publishes no image and no release.
3. **Given** a tag whose version differs from the version the packages carry, or whose changelog has
   no entry, **When** the pipeline runs, **Then** it refuses, and says which of the two it is.
4. **Given** a version that has already been published, **When** a tag for it is created again or
   the pipeline is run again, **Then** the published image is not replaced, and any step that had not
   completed (the release page, for one) is completed from the image that is already there.
5. **Given** a smoke run that fails, **When** the pipeline reaches it, **Then** nothing is published.
6. **Given** a pre-release version (a release candidate), **When** it is published, **Then** it is
   marked as a pre-release and does not become the image or the release that a user who asks for the
   latest version gets.
7. **Given** a pull request, a fork, or any branch, **When** their pipelines run, **Then** none of
   them can publish, and none of them holds a write permission.
8. **Given** a version tag, **When** someone who is not a maintainer tries to create, move or delete
   it, **Then** the repository refuses.

---

### User Story 2 - A newcomer runs Specter from the README (Priority: P1)

Someone who has heard of Specter, with Docker and nothing else, follows the README's quickstart.
They do not build anything and do not need a Node.js toolchain. In a few minutes they have a running
Specter, they sign in, and the README says plainly what to change before this is anything but a local
trial.

**Why this priority**: an image nobody can start is not a release. The quickstart is the only
documentation most people will read, so it must work as written, from a clean machine.

**Independent Test**: Someone who did not write the quickstart follows it, and only it, on a machine
with Docker and no clone of the repository, and times it (SC-001). Repeat on a second machine of the
other CPU architecture (SC-002).

**Acceptance Scenarios**:

1. **Given** a machine with Docker, **When** the reader follows the quickstart, **Then** the released
   version of Specter starts with its database, `GET /health` answers, and the web app loads at the
   address the quickstart gives.
2. **Given** the running app, **When** the reader signs in with the credentials the quickstart names,
   **Then** they reach the project list.
3. **Given** the quickstart's setup, **When** the reader checks what is reachable from outside the
   machine, **Then** only the app is: the database is not published on a host port.
4. **Given** the quickstart, **When** the reader looks for what to change before exposing the app
   anywhere beyond their own machine, **Then** it says the defaults are for local use only, names
   each value to set (the database password, the signing secret, the admin account), says the app
   does not terminate TLS and must sit behind something that does, and links to the deployment
   notes.
5. **Given** a reader who wants a specific version rather than the latest, **When** they look in the
   quickstart, **Then** it shows how to choose one, and that a version, once published, never changes.
6. **Given** a user who later wants to upgrade, **When** they read the upgrade note, **Then** it says
   to back up the database first, that migrations only move forward, and what the changelog records
   about each version.

---

### User Story 3 - A newcomer explores a demo threat model (Priority: P1)

Having started Specter, the same person wants to see what it does with something real before they
draw anything. They load the bundled demo: a small, fictional web application, already drawn, with
its threats generated and worked through. In a few minutes they have seen the diagram with its
trust boundary, a threat list with statuses, mitigations in each state and the risk summary, and
they can download the report. They did not need the repository: the demo is a file they can get
from the release.

**Why this priority**: an empty tool does not show its value. The demo is also the content of the
README's screenshots, so it shapes how the project looks to everyone who sees it.

**Independent Test**: With only the release page and a running Specter, get the demo file and load
it with the app's existing import, with nothing else. Check that it imports with nothing left out
and that each thing in FR-024 is there to be seen. Break each of the demo's checks in turn and see
that the build fails or warns as FR-026 says.

**Acceptance Scenarios**:

1. **Given** the release page, **When** a reader looks for the demo, **Then** it is an attachment of
   the release, and the quickstart says how to load it.
2. **Given** a running Specter and the demo file, **When** the reader imports it, **Then** the app's
   preview says everything in the file will be imported, and the result is a threat model with its
   diagram, threats and mitigations.
3. **Given** the imported demo, **When** the reader opens it, **Then** they see the diagram with at
   least one trust boundary and flows that cross it, threats in each of the four statuses, the risk
   summary, mitigations in each state, and threats of both origins: those the rules generated and
   one written by hand.
4. **Given** the imported demo, **When** the reader runs "Generate threats", **Then** it flags none
   as stale and creates none.
5. **Given** the demo, **When** the reader looks for anything that is real, **Then** there is none:
   it describes a fictional system, and says so in its own name or description, so it is never
   mistaken for guidance about a real one.

---

### User Story 4 - A visitor judges the project from its front page (Priority: P2)

Someone lands on the repository's front page, perhaps from a link in a post, and has a minute. They
want to know what Specter is, whether it works today, what it cannot do, whether it is maintained,
and whether it is safe to report a problem. The README shows the product in screenshots, says
which phase the project is at without overstating it, links to the changelog, the releases, the
demo and the threat model, and the security policy names the versions that receive fixes.

**Why this priority**: this is where the release is judged. It ranks below running it because it
cannot be tested until something is released, but a release whose front page promises what is not
there loses the trust the rest of the work earns.

**Independent Test**: A reviewer reads the README against a running release and ticks every
capability it claims (SC-005), then follows every link and image (SC-006).

**Acceptance Scenarios**:

1. **Given** the front page, **When** a visitor reads the status, **Then** it says v0.1 is the first
   release, which parts of the roadmap are built (Phases 0 to 2) and which are planned, and does not
   describe a planned feature as available.
2. **Given** the front page, **When** a visitor scrolls, **Then** screenshots of the demo show the
   diagram editor with a trust boundary, a threat list for a selected element with the open-threat
   counts on the canvas, and a report, each with a text description for people who cannot see it.
3. **Given** the front page, **When** a visitor looks for limitations, **Then** it lists the plain
   ones: no roles (every account can read and change everything), no AI features yet, a single
   container with its database and no TLS of its own, and the open risks that the threat model
   records.
4. **Given** the roadmap table and `plan.md`, **When** a visitor reads them, **Then** both show
   Phase 2 as done, in the form Phases 0 and 1 use.
5. **Given** the security policy, **When** a reporter reads which versions receive fixes, **Then** it
   names the latest release line, and no longer says there is no release yet.
6. **Given** a screenshot that has fallen behind the interface in a later release, **When** a
   maintainer retakes it, **Then** the README says how (FR-033).

---

### User Story 5 - The Definition of Done is proven, and a failure blocks the release (Priority: P2)

The Definition of Done of Phase 2 is a sentence with six steps, from `docker compose up` to a
round-trip import: start it, draw a diagram with a trust boundary, generate threats, work through
them, export, and import the OTM file back. The project proves it with a browser test against the
built app and a real database that does every step after the first through the interface, in one
run, and fails the required check if any step breaks. The first step, the container, is proven by
the same pipeline that publishes the image.

**Why this priority**: it is what lets the project say "v0.1 does what Phase 2 promised". It follows
the release machinery because the machinery is what a failing proof must stop.

**Independent Test**: Run the test against the built app: it passes. Break one step at a time (the
trust boundary is not saved, a generated threat is lost on re-import, the Markdown export is
empty) and check that it fails at that step with a message that names it.

**Acceptance Scenarios**:

1. **Given** the built app and a real database, **When** the test runs, **Then** it signs in, draws
   a diagram on the canvas that includes at least one trust boundary, generates threats, changes
   statuses and adds mitigations through the interface, downloads the Markdown report and the OTM
   file, imports the OTM file back, and finds every element, threat and mitigation of the original.
2. **Given** that this flow already has two halves covered in the browser tests, **When** the plan is
   made, **Then** it names which steps the existing tests cover only by setting data through the API
   (today: the diagram, the statuses and the mitigations are set that way where the export and
   re-import are checked), and the new test closes those, so that no step of the Definition of Done
   is covered only by seeding.
3. **Given** any change to a pull request, **When** the required checks run, **Then** this test is
   among them.
4. **Given** the image the pipeline built, **When** it is started, **Then** the smoke run (US1) has
   shown it healthy, able to sign a user in, able to serve the web app, and able to import the demo;
   this is the part of the Definition of Done's "`docker compose up`" that the browser tests, which
   run against the built app and not the container, do not cover.

---

### User Story 6 - Know which version this is and what changed (Priority: P2)

A user, an operator or a reporter wants to know what is in version 0.1.0, what changed from the
version before, whether it matters to them, and which version they are running. The changelog says,
the release notes repeat it, and the version reads the same everywhere it is written.

**Why this priority**: a changelog nobody keeps up is worse than none, so this is where a first
release sets the habit. It ranks below the pieces that exist to be run.

**Independent Test**: Take the tag, the version in each package, the first changelog entry, the
image's version tag and label, and the release's title. All say the same version. Then change one
and check that a check fails.

**Acceptance Scenarios**:

1. **Given** the first release, **When** a reader opens the changelog, **Then** it has an entry for
   0.1.0, dated, that says what a user can now do (grouped by what they do, not by commit), what v0.1
   does not do yet, and what an operator must know when upgrading: that Phase 1 dropped the original
   tracker's data without exporting it, and that migrations only move forward.
2. **Given** a release, **When** a reader opens its page, **Then** the notes are the changelog's
   entry for that version, the image is given by name and version and by digest, and the demo and the
   quickstart's file are attached.
3. **Given** a change that sets the packages to different versions, **When** the required checks run,
   **Then** one of them fails and says which packages disagree.
4. **Given** a running container, **When** an operator asks which version it is, **Then** the image
   carries it in its labels and in the tag they pulled; the app itself does not show a version
   (FR-040).
5. **Given** a published version that turns out to be bad, **When** a maintainer follows the
   procedure, **Then** the notes of that release say so and point to the fix, the image is not
   replaced, and the next version carries the fix.

---

### User Story 7 - The release is part of Specter's own threat model (Priority: P2)

Specter keeps a threat model of itself (Phase 2 Milestone 7) and the constitution says a change that
adds an entry point, an asset or a trust boundary updates it in the same change. Publishing adds all
three: a tag push starts a pipeline, that pipeline holds a credential that can write packages and
releases, and the image it publishes is what users run. The constitution's section and the committed
model say what these are and what protects them, and the checks of Milestone 7 still pass.

**Why this priority**: Specter is a security tool, and a supply-chain compromise of its own image
would undo everything else. It is P2 because it is written alongside the pipeline and judged in
review, but it blocks the merge (Principle V).

**Independent Test**: List each new asset, entry point and risk the pipeline adds. Check that the
constitution's section records each, and that the committed model has a threat for each risk whose
status agrees with the section, as Milestone 7's traceability list does; then run its checks.

**Acceptance Scenarios**:

1. **Given** the merged milestone, **When** a reader opens the Threat Model section, **Then** the
   published image and the credentials the pipeline holds are assets, a version-tag push is an entry
   point, and the boundary between the read-only pipelines of pull requests and the one that holds a
   write permission is a trust boundary.
2. **Given** each risk of that pipeline (a stolen or over-broad publishing credential, a tampered
   build step or action, a tag moved or forged, an image replaced after publication, an image users
   cannot verify, a registry that is not the project's, a secret that reaches an artefact, and an
   install left running on the documented default credentials), **When** the reader looks, **Then** it
   is recorded with its status: mitigated and naming the control, accepted with a reason and an end
   date, or open.
3. **Given** the committed model, **When** its checks run, **Then** they pass, and the report shows
   a threat of the whole model for each new risk (the pipeline cannot be drawn with the five element
   types, as for the earlier ones).
4. **Given** the constitution, **When** it is read, **Then** its Sync Impact Report, version and date
   are updated, and the pull request justifies the write permission, as Governance asks.

---

### Edge Cases

- **A local tag from an earlier history.** A clone of this repository can carry a local tag named
  `v1.0.0` that is not on the remote and is not part of this history: it is the "initial public
  release" of a different tree, by a different author. It matches the shape of a version tag. A push
  of every local tag would send it. The pipeline MUST refuse it (it is not on `main`, and its version
  is not the packages'), and the maintainers' documentation MUST say to push the one tag, by name,
  never all of them.
- **A tag created in error, or in a hurry.** A tag on the wrong commit, a typo (`v0.1`, `0.1.0`), a
  tag made before the changelog entry merged. The pipeline refuses and publishes nothing; the tag is
  deleted and made again, which the tag protection allows only to a maintainer, and the procedure only
  before anything was published under it. After publication a version is never moved or deleted
  (FR-007).
- **The image is published and the release page fails.** The pipeline ran past the image and stopped
  at the release. A re-run completes the release from the image already published, and never
  publishes a second, different image under the same version.
- **The image is published and nobody can pull it.** A package first published by an account starts
  private, and the one-time change to public is a setting of the registry that a pipeline run may not
  be able to make. The maintainers' documentation says to make it, and the check that follows a
  publication pulls the image with no credentials and fails loudly if it cannot (FR-010).
- **A user on an ARM machine.** An image built for one architecture fails to start on the other,
  with an error that does not say why. Both common architectures are published (FR-008).
- **A bad release.** A published version can be broken or unsafe. Published versions are not
  overwritten (FR-007); the remedy is a new version, with the old release's notes updated to say so,
  and a security advisory where it applies (`SECURITY.md`).
- **The defaults are weak by design.** The compose defaults (`admin`/`admin`, a development signing
  secret, a published database port) suit a contributor's laptop. A reader who copies them to a
  server has a weak install. The released path publishes no database port and says what to change;
  it does not change the product to refuse weak values, which is a product change (FR-040).
- **Someone upgrades from a development build.** v0.1 is the first release. There is no support
  for upgrading from an arbitrary commit of `main`; the changelog and the upgrade note say that the
  supported path is from one release to the next.
- **Someone upgrades from the Phase 0 tracker.** Their install is dropped by a Phase 1 migration, by
  design. The changelog and the README say so in plain words, because this is the one place where an
  upgrade deletes data.
- **The name.** `plan.md` lists as an open decision that the name "Specter" is to be checked for
  trademark and project-name collisions before v0.1. The tag cannot be created until that is
  recorded (FR-035). A collision, if found, is a decision for the maintainers, and not made here;
  the spec does not assume there is none. (The stray tag above names "Open Specter", which is the
  kind of thing the check looks for.)
- **Screenshots go stale.** The interface will change in later milestones. A screenshot that no
  longer matches is not a failed check, and the README's procedure for retaking them is what keeps
  them current (FR-033). What the checks do guard is that none is missing or broken (SC-006).
- **The demo meets a newer rule library.** A rule added later proposes a threat the demo lacks, or a
  rule retired leaves one stale. The checks of Milestone 7's kind apply: stale fails, new warns
  (FR-026).
- **The demo's project name is already taken** in the install it is loaded into. The app's import
  preview already says so and lets the name be changed (Milestone 6); the quickstart does not need
  to explain it.
- **A secret in the released artefacts.** The image, the release, the demo and the screenshots hold
  no credential, token, address or name of a real deployment. The image is built by the pipeline from
  a clean checkout of the tag, and never from a maintainer's machine, so nothing local reaches it
  (FR-006, FR-043).
- **Pre-release rehearsal pollutes the registry.** A rehearsal publishes a real image under a
  pre-release version. It is kept (versions are immutable) and is marked as a pre-release, so it is
  never what `latest` means.
- **The clone-and-build path.** Contributors still run from source with `docker compose up --build`
  and develop as before. The release path is an addition. The README keeps both, and says which is
  for whom.

## Requirements *(mandatory)*

### Functional Requirements

**The release pipeline**

- **FR-001**: Creating a version tag of the form `vMAJOR.MINOR.PATCH`, with an optional pre-release
  suffix (`v0.1.0-rc.1`), MUST start the project's release pipeline, and nothing else MUST: no push to
  a branch, no pull request, no schedule, no manual start of a final release.
- **FR-002**: The pipeline MUST refuse, publish nothing, and say which condition failed and what to
  do, when any of these holds: the tag is not a version tag (FR-001); the tagged commit is not on
  `main`; the version in the tag differs from the version of the workspace packages; the changelog has
  no entry for that version; the required checks have not passed on that commit; the version is
  already published as a different image.
- **FR-003**: The pipeline MUST build the image from a clean checkout of the tagged commit, in the
  pipeline's own environment, with the repository's own Dockerfile, so that what is published is what
  the repository builds, and nothing from a person's machine is in it.
- **FR-004**: Before publishing, the pipeline MUST start the image it built against a database and
  check that it is healthy, serves the web app, signs a user in, and imports the demo model (US3)
  with nothing left out. If any step fails, nothing is published.
- **FR-005**: A pre-release version MUST be published and marked as a pre-release, and MUST NOT
  become the image tagged `latest` or the release GitHub shows as the latest.
- **FR-006**: The pipeline MUST hold the least permission it needs. The write permissions it needs
  (to publish the image and to create the release) MUST be held only by the part of it that publishes,
  and only after every check above has passed. No part that builds, tests or runs code from a pull
  request, a fork or a branch may hold a write permission. It MUST use no secret other than the
  credential the platform issues for each run. Every third-party step it uses MUST be pinned to an
  immutable reference, as the project's other pipelines are (constitution, Tampering).
- **FR-007**: A published version MUST be immutable. Its image MUST NOT be replaced, and its tag MUST
  NOT be moved or deleted once anything has been published under it. A re-run for a version already
  published MUST complete only the steps that did not complete, from the image already there.
- **FR-008**: The image MUST be published for both of the common server and desktop CPU
  architectures (x86-64 and ARM64), and a user MUST get the right one without choosing.
- **FR-009**: The image MUST be published under its exact version (`0.1.0`) and, for a final release
  only, under `latest`. It MUST carry, as labels, its version, the commit it was built from, the
  repository it comes from and its license.
- **FR-010**: After publishing, the pipeline MUST pull the image with no credentials, from the
  registry, and fail loudly if it cannot. The maintainers' documentation MUST say what to set once
  (the package's visibility, and its link to the repository) for an anonymous pull to work, and how to
  verify it.
- **FR-011**: Version tags MUST be protected by a repository setting: only maintainers can create or
  delete one, and nobody can move one. (Not deleting one after publication is the procedure's rule,
  FR-007 and FR-029; a setting cannot tell a tag with a release from one without.) The setting MUST be
  kept as a definition in the repository and documented next to the one that protects `main`, with
  how to recreate it (as `docs/ci.md` does for `main`).

**The GitHub release and the changelog**

- **FR-012**: The pipeline MUST create the GitHub release for the version, titled with the version.
  Its notes MUST be the changelog's entry for that version, followed by the image's name, version and
  digest and how to run it. It MUST attach the demo model (FR-023) and whatever file the quickstart
  tells a reader to download (FR-016).
- **FR-013**: The repository MUST hold a changelog, with an entry for 0.1.0 that follows FR-014. A
  later change that is visible to a user or an operator adds to it in the same pull request.
- **FR-014**: The 0.1.0 entry MUST say, in plain words and grouped by what a user does (draw,
  generate, work through, report, exchange): what v0.1 can do; what it cannot do yet (the limitations
  of FR-019); and, for an operator, the upgrade notes of User Story 6. It MUST NOT list a planned
  feature as available.
- **FR-015**: One version MUST read the same in the tag, in each workspace package, in the changelog
  entry, in the image's tag and labels, and in the release's title. (For a release candidate such as
  `v0.1.0-rc.1`, "the version" of the packages and the changelog is the one it is a candidate for,
  `0.1.0`, so that a rehearsal needs no version change; the image and the release carry the full tag.) A check in the required `test`
  run MUST fail if the packages disagree with one another, and the pipeline MUST refuse if they
  disagree with the tag (FR-002).

**The quickstart and the front page**

- **FR-016**: The README MUST give a quickstart that starts the released image and its database with
  documented commands, with no build and no clone of the repository, using at most one file the
  reader downloads from the release. It MUST work with Docker as the only prerequisite, and on both
  architectures.
- **FR-017**: The quickstart's setup MUST publish only the app's port to the host. The database
  MUST NOT be reachable from outside the machine. The quickstart MUST say that its defaults are for
  local use only, name each value to set before exposing the app anywhere else (the database
  password, the signing secret, the admin username and password), say that the app does not
  terminate TLS and must sit behind a proxy that does (with the `TRUST_PROXY` note the README
  already has), and link to the deployment notes.
- **FR-018**: The README MUST show how to choose a version and how to upgrade between releases,
  including backing up the database first and that migrations only move forward.
- **FR-019**: The README MUST state, near the top, what v0.1 is, what is built (Phases 0 to 2) and
  what is planned (Phases 3 onward), and MUST list the limitations a user needs to know: no roles
  and every account reads and changes every project, no AI features, one container with its database
  and no TLS of its own, the open risks recorded in the threat model, and a link to it. Its status
  block ("Phase 2 in progress…") MUST be replaced. Its roadmap table and `plan.md` MUST show Phase 2
  as done, in the form of Phases 0 and 1.
- **FR-020**: The README MUST show at least four screenshots, all of the demo model (US3), of: the
  diagram editor with a trust boundary; a threat list filtered to a selected element, with the
  open-threat counts on the canvas; the report; and the import or export. Each MUST have a text
  description, and the screenshots together MUST add no more than 3 MB to the repository.
- **FR-021**: The README MUST link to the changelog, the releases, the demo, the threat model, the
  contribution guide and the security policy. A check in the required `test` run MUST fail if a
  relative link or an image of the README, the changelog or the new documents of this milestone points
  to something that does not exist.
- **FR-022**: Every capability the README, the changelog or the release notes claim MUST be
  demonstrable on the released image. A claim about something that is not built, or is built and not
  reachable from the interface or the documented API, MUST be removed or labelled planned.

**The demo model**

- **FR-023**: The repository MUST hold a demo threat model as a Specter file (Milestone 6), outside
  `docs/threat-model/` (which a check holds to its two files), and the release MUST attach it. It MUST
  be loadable with the app's existing import and nothing else. The app MUST NOT seed it, offer a
  button for it, or load it on its own; the demo is not a feature.
- **FR-024**: The demo MUST describe a small, fictional web application, and say so in its project or
  threat model name or description. It MUST contain all five element types, at least one trust
  boundary with elements inside and flows that cross it, with their security flags set; threats of all
  six STRIDE categories; threats in each of the four statuses, with a reason where one is required;
  mitigations in each of the three states; risks at three or more levels; threats generated by the
  rules and at least one written by hand; and a threat model status that shows the lifecycle.
- **FR-025**: The demo MUST be what Specter's export writes for a model built in a running Specter,
  and MUST NOT be written or edited by hand (Milestone 7, FR-013). It MUST hold no credential, address,
  personal data or name of a real deployment, company or person.
- **FR-026**: The required `test` run MUST hold the demo to checks of the kind Milestone 7 gives
  its own model: valid against the published schema; accepted by the import check with nothing left
  out; imported and exported again equal to itself apart from identifiers and the export time;
  "Generate threats" on it flags none stale. A stale threat MUST fail the build. A threat a rule
  newly proposes MUST produce a warning only, naming the rule and the element. Each failure MUST say
  which check, which file and what to do.

**The proof and the readiness**

- **FR-027**: A browser test in the required `test` run MUST walk the Phase 2 Definition of Done
  through the interface in one run, against the built app and a real database: sign in, draw a
  diagram on the canvas with at least one trust boundary, generate threats, change statuses and add
  mitigations, download the Markdown report and the OTM file, import the OTM file back, and find every
  element, threat and mitigation of the original with its status. Where an existing browser test
  covers a step, the plan MUST say which, and no step MAY be covered only by setting data through the
  API (US5).
- **FR-028**: The published image MUST be shown to work as a container by the pipeline's smoke run
  (FR-004), because the browser tests do not run against one.
- **FR-029**: The maintainers MUST have a releasing procedure in the repository's documents that a
  person who did not write it can follow to the end: its readiness checks (FR-030, FR-035), how to
  rehearse with a pre-release, how to create the tag and push that one tag, what to verify afterward
  (the release page, the anonymous pull on both architectures, the demo attachment), the one-time
  registry settings, and how to deal with a bad release (FR-007, US6).
- **FR-030**: Before the tag is created, a person who did not write the quickstart MUST follow it,
  and only it, from a clean machine and load the demo (where there is no such person, the maintainer,
  on a machine with no clone of the repository and no earlier image, and the pull request says
  which), and the result, the time it took and every finding MUST be recorded in the pull request
  (SC-001). A defect they find that stops it working MUST be fixed under
  FR-040; anything else is recorded as an issue.
- **FR-031**: The security policy MUST say which versions receive security fixes: the latest release
  line, and nothing older until the project says otherwise. It MUST no longer say that there is no
  release.
- **FR-032**: `plan.md` MUST show Phase 2 as done and its open decision "Name" as decided, with the
  outcome of the check of FR-035.
- **FR-033**: The README MUST say how the screenshots are retaken from the demo (which model, which
  window size, how they are cropped and named), so that a maintainer can refresh them without
  guessing.
- **FR-034**: The changelog and the release notes MUST NOT claim a version is "secure", and MUST say
  where the open risks are recorded (the threat model) and how to report a vulnerability.
- **FR-035**: The name "Specter" MUST be checked for trademark and project-name collisions before the
  tag is created, as `plan.md` requires. What was searched, when, what was found and the maintainers'
  decision MUST be recorded in the repository, and the releasing procedure MUST list it as a gate.
  A collision is for the maintainers to decide, and the pipeline cannot check it.

**The threat model**

- **FR-036**: The constitution's Threat Model section MUST record, as `Assets (current)`, the
  published image and the credentials the pipeline holds; as an entry point, the creation of a version
  tag; and as a trust boundary, the one between the pipelines that hold no write permission and the one
  that does.
- **FR-037**: The section MUST record each risk of User Story 7's second scenario with a status in
  the vocabulary the section uses (mitigated, partially mitigated, accepted, open), and for each
  mitigated one the control that decided it. The absence of a signature, a build attestation and a
  software bill of materials on the image MUST be recorded as an open risk, not left out, with the
  Phase 6 item of `plan.md` ("Verifiable release images") as its proposed remedy, because the plan
  schedules it (Milestone 7, FR-008). The release notes MUST say the image is not signed and give its
  digest, so that a user can pin it. An install left running on the quickstart's documented default
  credentials (`admin`/`admin`, a development signing secret) MUST be recorded as a risk too, since
  this milestone is what makes that path public; the product does not refuse them (FR-040), so the
  controls recorded are the loopback-only publication and the README's warning.
- **FR-038**: The committed model of `docs/threat-model/` MUST be updated, by the procedure its
  description gives, in the same change: a threat of the whole model for each new risk, with a status
  that agrees with the section, its checks passing, and its description's scope ("through Phase 2
  Milestone 6") brought up to this milestone. The pull request MUST carry a traceability list of the
  new risks and their threats, as Milestone 7's did.
- **FR-039**: The constitution's Sync Impact Report, version and date MUST be updated, as for each
  earlier milestone, and the pull request MUST justify the write permission the pipeline holds
  (Governance).

**Guardrails**

- **FR-040**: This milestone MUST NOT change the product's behaviour except to fix a defect found by
  FR-027 or FR-030, with a test that fails first (Principle II). In particular it MUST NOT show a
  version in the app or its API, MUST NOT add a seeded or loadable demo to the app, MUST NOT refuse or
  change the compose defaults in the product, MUST NOT add an endpoint, a table, a migration or a
  runtime dependency, and MUST NOT add content that belongs to a later phase.
- **FR-041**: The contributor's path (`docker compose up --build` from a clone, and the commands of
  the README's development section) MUST keep working unchanged.
- **FR-042**: The pipeline's documents MUST say how each of its settings is configured and where its
  definition lives, in `docs/ci.md`, as for the other pipelines.
- **FR-043**: The released image, the release assets, the demo and the screenshots MUST contain no
  credential, token, email address, address or identifier of a real deployment, and a check in the
  required `test` run MUST look for the patterns of such things in the demo and in the text files this
  milestone adds, as Milestone 7's check does for its own files.

### Key Entities *(include if feature involves data)*

- **A release**: one version of Specter, published once. It has a version, a tag on a commit of
  `main`, an image, notes and attachments. Once published it does not change.
- **The published image**: what a user runs. Named by registry, repository and version, identified
  by a digest, built by the pipeline from the tagged commit, labelled with where it came from.
- **The release pipeline**: what turns a tag into a release. Started by a tag, refusing what it should
  refuse, holding write permissions only where it publishes.
- **The changelog entry**: the statement of what a version contains, from which the release notes are
  taken.
- **The demo threat model**: a fictional, finished example in the Specter file format, attached to the
  release and used for the screenshots. Not Specter's own model.
- **The screenshots**: pictures of the demo in the README, with text descriptions.
- **The Definition of Done test**: the browser run that walks Phase 2's sentence.
- **The readiness record**: the name check and the clean-machine walkthrough, kept in the repository
  and the pull request.
- **The checks** (test-suite): the conditions of FR-015, FR-021, FR-026, FR-027 and FR-043.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A person who did not write the quickstart, with Docker and no clone of the repository,
  goes from the README to a signed-in Specter in 5 minutes or less, and to the demo imported and its
  threats open in 10 minutes or less, counting neither the time to download the image nor to read the
  README's other sections. This is recorded in the pull request (FR-030).
- **SC-002**: The image of every published version pulls with no credentials and starts, on both
  x86-64 and ARM64, in 100% of the checks run after publication.
- **SC-003**: 0 images are published from a run whose smoke run failed, and for each refusal
  condition of FR-002 a test or a rehearsal shows that nothing is published and the message names the
  condition: 100% of the six (the five of FR-002 and the tag's shape).
- **SC-004**: The version reads the same in the tag, the packages, the changelog entry, the image tag
  and labels, and the release title in 100% of releases, and a disagreement among the packages fails
  the required build in 100% of cases.
- **SC-005**: 100% of the capabilities that the README, the changelog and the release notes claim are
  demonstrated on the released image by the clean-machine walkthrough, and 0 refer to a later phase's
  feature as available. A reviewer ticks each against the app.
- **SC-006**: The README shows at least 4 screenshots of the demo, each with a text description; the
  images together add no more than 3 MB to the repository; and 0 relative links or images in the
  README, the changelog and this milestone's new documents are broken.
- **SC-007**: The Definition of Done test passes in 100% of runs of the required `test` check, every
  step of the sentence from drawing to the round-trip import is driven through the interface (the
  first, starting the container, by the smoke run of FR-004), and breaking any one of them makes it
  fail naming the step.
- **SC-008**: The demo is valid against the published schema, imports with 0 items left out, and
  "Generate threats" flags 0 of its threats stale, in 100% of runs of the test suite; a stale threat
  fails the build and a threat that would be created only warns, each in 100% of cases.
- **SC-009**: A reviewer confirms from the pipeline's definition that 100% of its third-party steps
  are pinned, that write permissions are held only by the publishing part, and that it uses no secret
  other than the platform's per-run credential.
- **SC-010**: The new risks of the release appear in the constitution's section and in the committed
  model with agreeing statuses (100% of the risks of FR-037 in the traceability list), and the
  checks of Milestone 7 pass in the same change.
- **SC-011**: Someone who did not write the releasing procedure rehearses a pre-release with only its
  steps, and ends with a published pre-release that did not move `latest`, with no step needed
  outside the document.
- **SC-012**: The checks of FR-043 find 0 credentials, email addresses, IP addresses or cloud
  account identifiers in the demo and in this milestone's new text files, and a reviewer finds 0 real
  names in them and in the screenshots.

## Assumptions

- **Final release `v0.1.0`, first of its kind.** All five workspace packages already carry 0.1.0
  and `plan.md` names this release v0.1. No tag has been pushed to the remote, and the remote has no
  releases. The first tag it receives is this one.
- **The registry is GHCR, under the repository's owner.** `plan.md` names it. The image is public
  (anonymous pull is a success criterion), which for a package published by a user account is a
  setting made once by a maintainer, documented and then verified by every release. The image's name
  is the plan's to choose.
- **One pipeline, triggered by a tag, publishing the image and the release.** A maintainer's machine
  never publishes. How the tag is protected, how the pipeline checks that the required checks passed,
  and how a re-run completes is for the plan; this spec states what it must do and what it must refuse.
- **The rehearsal is a real pre-release (decided, Clarifications 2026-10-12).** A dry run would not
  exercise the steps most likely to fail the first time: the package's visibility, the anonymous pull,
  and the write permission. So the maintainers publish `v0.1.0-rc.1` (and further candidates if it
  fails) through the one pipeline, accept that it stays public, and verify it as FR-029 lists. A
  rehearsal that fails before publishing leaves no image; one that fails after is completed by a
  re-run (FR-007), or abandoned and followed by the next candidate.
- **Both architectures.** x86-64 and ARM64 cover servers, cloud instances and Apple-silicon laptops,
  which is where first users are likely to be. Others are not promised.
- **No signing, attestation or software bill of materials in v0.1 (decided, Clarifications
  2026-10-12).** The milestone's line in `plan.md` asks for "versioned images on GHCR" and nothing
  more. Adding proof of origin would need further permissions for the pipeline (Principle V, least
  privilege) and is not asked for (Principle III). Consumers can pin an image by the digest the
  release notes print. The absence is an open risk in the threat model (FR-037), and `plan.md` now
  schedules all three under Phase 6 ("Verifiable release images"). It is not a Phase 2 task, and
  no milestone of Phase 2 or Phases 3 to 5 is to take it up.
- **The demo is a file, loaded with the existing import (decided, Clarifications 2026-10-12).** The Specter file format's own description
  says a model can be shipped as a demo, and the product already imports it with a preview. Seeding
  the demo on first start, or adding a button, would be a product change with its own risks (data
  written at startup, a new entry point) that Principle III and FR-040 rule out. To reach someone who
  never clones the repository, it is an attachment of the release. It is not copied into the image.
- **The demo is separate from Specter's own model.** Milestone 7 states that its model is for the
  project and is "expected to be accurate, not instructive", and that this milestone's demo is "for a
  new user to explore". They share the checks' approach and nothing else.
- **The README's quickstart needs one downloaded file at most.** A compose file for the released
  image, attached to the release (and kept in the repository), fits "Docker and nothing else". Whether
  it is a new file or an override of the existing one is for the plan; the existing `docker-compose.yml`
  keeps its contributor-friendly defaults, including its published database port.
- **The app shows no version.** `/health` returns `{"status":"ok"}` and the API document's version is
  the API's `1`. Showing a build's version in the app or its API would be a product change (FR-040).
  The version lives in the image tag and labels.
- **Screenshots are taken by hand from the running demo**, with a documented procedure, not
  generated by a script. They are product pictures, not tests; a script would be a new thing to
  maintain (Principle III). They are not checked for freshness.
- **The Phase 2 Definition of Done is mostly tested already.** The existing report test seeds the
  diagram, sets statuses and mitigations through the API, then drives generation, both exports and the
  OTM re-import through the page, and compares elements, threats, mitigations and a second
  generation's zero result. Other browser tests drive the canvas and the workflow separately. What is
  missing is one run that does all of it through the interface (FR-027), and a run against the
  container (FR-004). The plan decides how much of the existing test to reuse.
- **The Threat Model change is mostly threats of the whole model.** The pipeline and the supply chain
  cannot be drawn with the five element types, as Milestone 7 found, so the new risks join the model's
  existing "not linked to an element" threats. The constitution's section and the model's description
  say so.
- **Maintainers' own settings are not checked by a program.** A repository's visibility settings, its
  tag protection and its package visibility are made by a person with the right access and documented
  with commands that verify them. The pipeline's anonymous pull (FR-010) is the one check that
  catches a wrong package setting after the fact.
- **The name check is a human gate.** It cannot be automated and its result is not known. If it
  finds a collision, this milestone stops at the tag, and the maintainers decide what to do; every
  other part is unaffected and can be merged.
- **Local tags are not part of the repository.** A clone may carry tags the remote does not have.
  The stray `v1.0.0` tag of an earlier, unrelated history is local only; this spec does not delete
  or push it, and the pipeline refuses it if it is ever pushed.
- **Constitution update.** The milestone adds an entry point, assets and a trust boundary (the
  release pipeline), so the constitution's Threat Model section changes and its version is raised, as
  for each earlier milestone. It adds no endpoint, credential of the application, table or runtime
  dependency.
- **What review decides.** Four things are not testable by a program and are judged in review: that
  the README claims only what is true (FR-022), that the screenshots show what the text says they do
  (FR-020), that the quickstart is understandable (FR-030), and that the statuses of the new threats
  say something true (FR-037). The checks guard what they can (links, images, versions, schema, stale
  threats); the pull request says which parts are review's.
