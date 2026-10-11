# Feature Specification: Dogfood, Specter's Own Threat Model

**Feature Branch**: not yet created (spec directory `phase-2/milestone-7-dogfood`)

**Created**: 2026-10-11

**Status**: Implemented, awaiting CI and a maintainer's read of the traceability list (see `pr-description.md`)

**Input**: User description: "let's take milestone 7 of phase 2". This covers Phase 2 / Milestone 7
of `plan.md` (line 134): "Dogfood. Build Specter's own threat model in Specter and commit its
export to the repo."

Guiding principle 8 of `plan.md` says Specter keeps its own threat model, built in Specter. Until
now that model has existed only as prose: the Threat Model (STRIDE) section of the constitution.
Milestones 5 and 6 built the two things this milestone needs, a report to read and a file to keep,
and both were designed with this milestone in mind (their specs say Milestone 7 commits the result).
This milestone does the work they were built for:

- **the model itself**: Specter's system drawn in Specter, with its threats and mitigations, each
  one traceable to a risk the constitution already records;
- **two committed files**: the model as a Specter file (the lossless export) and as a Markdown
  report (the readable one), kept together in the repository;
- **a check that keeps it honest**: the committed files are real Specter output, load back into
  Specter without loss, and stay consistent with the rules Specter ships;
- **a way to keep it current**: a documented procedure, and the rule of which document governs when
  the prose and the model disagree.

It is also the first real use of the whole of Phase 2 on a model nobody designed as a test fixture,
so what building it exposes is recorded (User Story 5).

It adds no feature to the product. This is not Milestone 8's bundled demo: that one is for a new
user to explore; this one is the project's own, and is expected to be accurate, not instructive.

## Clarifications

### Session 2026-10-11

- Q: When the committed threat model no longer matches the rules Specter ships, does that fail the
  required build or only warn? → A: Split. A stale threat (a rule changed or retired so that a threat
  the model holds no longer matches it) fails the build; a threat a newly added or widened rule would
  create only produces a warning, and the model is updated in a later change (FR-016).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A threat model of Specter that is true to Specter (Priority: P1)

A security engineer evaluating Specter, or a contributor about to change it, wants to know what
Specter protects, where its trust boundaries are and which risks are open, accepted or handled. They
look at Specter's own threat model and find the running system drawn: who and what talks to it, what
runs inside, where the data rests, and which interactions cross a trust boundary. Each element has
threats, each threat a status and a reason or a mitigation that names the real control.

**Why this priority**: this is the milestone. The files, the checks and the procedure are only worth
having if the model is accurate, and an inaccurate public threat model is worse than none.

**Independent Test**: Take the Threat Model (STRIDE) section of the constitution and list every
asset, every current trust boundary and every risk it records as mitigated, partially mitigated,
accepted or open. Open the model. Check that each asset sits on an element or in a threat, each
boundary is a trust boundary of the diagram with the right things inside it (the CI/CD boundary is
the exception of FR-003: threats of the whole model stand for it), and each risk is a threat
whose status agrees with the section's wording (FR-005 to FR-007). Check that all six STRIDE categories
are present.

**Acceptance Scenarios**:

1. **Given** the system as shipped, **When** a reader opens the model, **Then** the diagram shows the
   people and clients that use it, the web app in the browser, the API and its parts, the database,
   the source of secrets and the point where the internet reaches the app, with a trust boundary
   wherever the constitution names one.
2. **Given** an interaction that crosses a trust boundary (sign-in, session renewal, a read or write
   under `/api/v1`, an import, an export, a report, generation, loading the web app, access to the
   database, loading secrets), **When** the reader looks for it, **Then** it is a data flow of the
   diagram, with its security flags set from what the system does.
3. **Given** a risk the constitution calls mitigated, **When** the reader opens its threat, **Then**
   the threat is mitigated and carries an implemented or verified mitigation that names the control
   and where it is documented.
4. **Given** a risk the constitution calls accepted, **When** the reader opens its threat, **Then**
   the threat is accepted, with a reason that says why it is accepted and for how long (until which
   phase, if the plan says so).
5. **Given** a risk the constitution calls open, or partially mitigated, **When** the reader opens
   its threat, **Then** the threat is open, and any control already in place is recorded as an
   implemented mitigation, with the planned remedy recorded as a proposed one.
6. **Given** the rules Specter ships, **When** they are run against the diagram, **Then** every
   threat they propose is in the model, each reviewed: it is mitigated, accepted, dismissed as not
   applicable with a reason, or open on purpose.
7. **Given** a risk that belongs to no single element (the build and release pipeline, the supply
   chain), **When** the reader looks for it, **Then** it is a threat of the model as a whole.

---

### User Story 2 - Read it in the repository, without installing anything (Priority: P1)

A visitor to the repository, with no Specter running, wants to read the threat model. From the front
page of the repository they reach a report with the diagram, the threats grouped by element, and the
risk summary, in the form the repository host shows as a page. A tool or a script that wants the
data reads the Specter file next to it.

**Why this priority**: a threat model nobody can open does not show anything. This is also the
"commit its export to the repo" of the plan.

**Independent Test**: From the front page of the repository, with a browser and no other tool, reach
the report in no more than two steps, and read the diagram and the list of threats. Then validate the
Specter file against the published schema.

**Acceptance Scenarios**:

1. **Given** the repository's front page, **When** a reader looks for the threat model, **Then** a
   link leads to it, and a short description says what it is and where its two files are.
2. **Given** the report, **When** it is shown on the repository host, **Then** the diagram, the
   headings, the lists and the summary display as the report designs them, and no text of the model
   acts as markup.
3. **Given** the folder of the two files, **When** a reader opens its description, **Then** it says
   what each file is, how it was produced, how to read it, how to load it into Specter, and how to
   change it (FR-018).
4. **Given** the model changed by one threat, **When** the report is committed again, **Then** the
   change in the report is that threat, the counts that depend on it and the export time, and nothing
   else (SC-007).

---

### User Story 3 - The committed files are real, valid and loadable, and the build says so (Priority: P2)

A maintainer wants to be sure the committed files are what Specter writes, not a hand-made look-alike,
and that they keep loading as Specter changes. The test suite loads the committed Specter file the way
a user would and checks that nothing is lost and nothing is invented, and that the committed report is
the one Specter builds from it.

**Why this priority**: it is what turns "we have a threat model" into "we have a threat model that
is built in Specter and stays that way". It matters after the model exists, so it ranks below it.

**Independent Test**: Run the checks against the committed files: valid against the published
schema, accepted by the import check with nothing left out, imported into an empty project and
exported again equal to the committed file apart from identifiers and export time, "Generate
threats" on the imported model flags nothing stale, and the report built from the imported model
equals the committed report apart from the export time and the project line. Then break each condition in turn (edit a
threat, add an element, change a report line, retire a rule a threat comes from) and check that a
check fails with a message that says which and what to do. Finally add a rule that proposes a new
threat and check that the build passes with a warning.

**Acceptance Scenarios**:

1. **Given** the committed Specter file, **When** the import check runs on it, **Then** it accepts
   it and its summary lists nothing left out.
2. **Given** the committed file imported into an empty project, **When** it is exported again,
   **Then** the new file equals the committed one apart from record identifiers and export time.
3. **Given** the imported model, **When** "Generate threats" runs on it, **Then** it marks none
   stale and, on the code as merged, would create none (FR-016).
4. **Given** a rule changed or retired so that a threat of the model no longer matches it, **When**
   the checks run, **Then** the build fails and the message names the threat and the rule.
5. **Given** a rule added so that it proposes a threat the model lacks, **When** the checks run,
   **Then** the build passes, and a warning names the rule and the element and points to the update
   procedure.
6. **Given** the committed report, **When** the report is built from the imported model, **Then**
   the two equal each other apart from the export time and the project line (FR-015).
7. **Given** a file or report changed by hand so that it no longer equals Specter's output, **When**
   the checks run, **Then** a check fails and its message names the file, the difference and the
   procedure that fixes it.

---

### User Story 4 - Keep the model current, and know which document governs (Priority: P2)

A contributor adds an entry point, changes how sessions work, or retires a library rule. The
constitution already makes them update its Threat Model section in the same change. Now the model
changes in the same change too (for a rule that is only added, it may follow in a later one, because
that only warns), by a procedure written down: load the committed file into Specter,
make the change in the app, export, commit both files. If the prose and the model disagree, the
contributor knows which one is right.

**Why this priority**: a threat model that is not kept current becomes a false statement. It is P2
because the first commit does not need it, and the model starts to age on the day it is made.

**Independent Test**: Someone who did not write the procedure follows only the documented steps to
add one new threat to the committed model. The result passes the checks, and its report differs from the
old one only as SC-007 says.

**Acceptance Scenarios**:

1. **Given** a change that adds an entry point, an asset or a trust boundary, **When** the
   contributor reads the contribution guide and the pull request checklist, **Then** both tell them
   to update the constitution's section and the committed model in the same change.
2. **Given** a disagreement between the constitution's section and the model, **When** a reviewer
   asks which is right, **Then** the constitution says: the section governs, and the model is
   corrected.
3. **Given** the documented procedure, **When** a contributor follows it, **Then** they end with two
   changed files that pass the checks, and know that the identifiers in the Specter file have all
   changed and that the report is the file to review (FR-018).

---

### User Story 5 - What building it taught us (Priority: P3)

Drawing a real system in the editor, generating its threats, triaging them, and exporting the result
is the first use of Phase 2 as a whole by someone who needs the answer. Anything awkward, missing or
wrong that this exposes is written down, not forgotten or silently worked around.

**Why this priority**: it is the other reason dogfooding is in the plan. It is P3 because it follows
from doing the work and adds no deliverable of its own.

**Independent Test**: At the end of the milestone, the pull request description holds a list of
findings (what was tried, what happened, what the work-around was), and each finding is either
fixed in this milestone, because it kept the model from being accurate, or recorded as an issue.

**Acceptance Scenarios**:

1. **Given** a thing the editor or the rules could not express, **When** the model is made, **Then**
   it is modelled in the closest honest way and the gap is listed as a finding.
2. **Given** a defect that makes the model wrong or impossible to build, **When** it is found,
   **Then** it is fixed in this milestone with a test that reproduced it first (Principle II).
3. **Given** any other friction, **When** it is found, **Then** it is recorded as a finding and is
   not built in this milestone (Principle III).

---

### Edge Cases

- **The rules change after the model is committed.** A rule retired or changed later leaves a threat
  of the model with no matching source: generation flags it as stale and the build fails (FR-016). A
  rule added later proposes a threat the model lacks: the build passes with a warning, and the model
  is updated in a later change. A model that is behind its rules for a time is expected; one that
  contradicts them is not.
- **Two elements of one type with the same name.** The report's order falls back on identifiers for
  a complete tie, and an import changes identifiers, so a report built from the imported model could
  order them differently. Names of elements of one type are therefore unique in the model (FR-004).
- **A component the five element types cannot draw** (a person's laptop, a CI pipeline, a registry).
  It is drawn as the nearest element type, or covered by a threat of the whole model, and is a finding.
- **A risk that spans several elements** (session theft involves the browser, the API and the
  database). The threat sits on the element that decides the outcome, names the others in its
  description, and is not duplicated.
- **A "partially mitigated" risk.** Specter has no such status. It is an open threat that carries
  its implemented mitigations, and the summary shows it as open.
- **The model finds a real, unfixed vulnerability.** It is reported by the project's own disclosure
  process (`SECURITY.md`), and enters the committed model only when it can be public (FR-011).
- **The Specter file format changes version.** The committed file is exported again in the same
  change, and the checks use the schema of the current version.
- **Every export has a new export time.** A re-export that changes nothing but that time is not
  committed; the checks ignore the time.
- **A hand edit that keeps the file in the form Specter writes.** The checks cannot tell it from an
  export, and the procedure says to change the model in Specter. It is a rule of the project, not
  something the checks can enforce.
- **Text that looks like markup or like a secret.** Names and descriptions are shown as text by the
  report, as Milestone 5 guarantees. A name that looks like a credential is a defect of the model
  (FR-010).

## Requirements *(mandatory)*

### Functional Requirements

**The model**

- **FR-001**: The repository MUST hold one threat model of Specter itself, in a project named for
  Specter, using the STRIDE methodology, describing the system as it is implemented when this
  milestone merges (through Phase 2 Milestone 6). Nothing planned and not shipped (document
  ingestion, LLM providers, repository access, integrations, roles, audit log) is drawn as if it
  exists.
- **FR-002**: The diagram MUST show the system's own components and its neighbours: the people and
  clients that use it, the web app that runs in the browser, the API and its main parts (sign-in and
  sessions, the threat-model API, generation, reports, import and export), the database, the source
  of secrets, and the proxy or load balancer that sits in front of it in a deployment. Each element
  MUST correspond to a real component, named so that a reader can find it in the repository or the
  deployment documentation, and carries its technology as tags where one applies.
- **FR-003**: Every trust boundary in the constitution's "Trust boundaries (current)" MUST be a trust
  boundary of the diagram, with the elements on each side, except the CI/CD boundary (GitHub Actions
  on pull requests from forks, with third-party actions and images), which the five element types
  cannot draw: its risks are threats of the whole model (FR-006), and the traceability list names the
  threats that stand for that boundary. Every interaction that crosses a drawn boundary
  MUST be a data flow with its flags set (authenticated, encrypted in transit, internet-facing,
  stores sensitive data, as they apply) from what the system does. A flag whose answer is not known
  is left unassessed, and is never guessed.
- **FR-004**: The names of elements of one type MUST be unique within the model, and the layout MUST
  be readable: no element hides another, and each element is inside the boundary it belongs to.
- **FR-005**: Every asset in the constitution's "Assets (current)" MUST appear in the model: held by
  an element, or named by a threat. Planned assets (Phase 3 onward) MUST NOT.
- **FR-006**: The model MUST contain every threat Specter's shipped rules propose for its diagram
  (generated threats, `origin: rule`), and, for each risk the Threat Model section records that the
  rules cannot derive, a threat added by hand (`origin: manual`). A risk that belongs to no single element MUST be
  a threat of the whole model. All six STRIDE categories MUST have at least one threat. Every threat
  MUST have its likelihood and its impact assessed.
- **FR-007**: Each risk the Threat Model section records MUST be a threat of the model whose status
  agrees with the section:
  - *Mitigated* → a mitigated threat with an implemented or verified mitigation;
  - *Partially mitigated* → an open threat carrying its implemented mitigations, and a proposed
    mitigation for what remains;
  - *Accepted risk* → an accepted threat with its reason (FR-009);
  - *Open risk* → an open threat, with the planned remedy as a proposed mitigation if the plan names
    one;
  - *Planned* (a later phase's feature) → not in the model.
  Every other threat MUST have a status that its review decided (FR-006), and none MUST be left in a
  state it only has because nobody looked.
- **FR-008**: A mitigation MUST name the control and where it is documented (a milestone's
  specification, a document of the repository or an area of the code), in text. A mitigation is
  `verified` only where an automated test covers the control, `implemented` when the control exists
  without one, and `proposed` for a remedy the plan schedules.
- **FR-009**: The reason of an accepted or not applicable threat MUST say why, and, for an accepted
  one, until when it is accepted if the plan or the Threat Model section says so.
- **FR-010**: The model, the files and the descriptions MUST hold no credential, secret value,
  personal data, account name, or address or identifier of a real deployment. Generic names are used
  ("the database", "the load balancer"), and the reference deployment is the one the repository
  documents: one app container, one Postgres, an optional secrets manager, an optional proxy.
- **FR-011**: A finding that is an exploitable vulnerability in the released code, not yet fixed,
  MUST go through the disclosure process of `SECURITY.md` first, and MUST NOT be written into the
  committed model until it can be public.

**The committed files**

- **FR-012**: The repository MUST hold, together in one folder with a description (FR-018), the
  model as a Specter file and as a Markdown report. No other export (OTM, HTML) is committed.
- **FR-013**: Both files MUST be what Specter's export writes for a threat model built in a running
  Specter, through its web app or its documented API. They MUST NOT be written by hand, and the
  report MUST NOT be edited after export.
- **FR-014**: The Specter file MUST be valid against the published schema; the import check MUST
  accept it and list nothing left out; importing it into an empty project and exporting the result
  MUST give a file equal to it apart from record identifiers and the export time (Milestone 6,
  FR-004).
- **FR-015**: The Markdown report MUST equal the report Specter builds from the model imported from
  the committed Specter file, apart from the export time and the project line. The project line is
  set aside because the check imports into a project of its own (project names are unique across an
  install, so it cannot be called `Specter`); the committed report's project line MUST still name the
  project the Specter file names.
- **FR-016**: "Generate threats", run on the model imported from the committed Specter file, MUST
  flag no threat of the model as stale. This is a blocking check: a rule changed or retired so that a
  threat the model holds no longer matches it fails the required build. The same run is expected to
  create none: a rule added, or widened, so that it proposes a threat the model lacks does **not** fail
  the build, and is reported as a warning in the pull request's test results, naming the rule and the
  element (Clarifications, 2026-10-11). The model is brought up to date in a later
  change, by the procedure of FR-018.
- **FR-017**: The checks of FR-014, FR-015 and the blocking part of FR-016, and a check that the files
  hold none of the patterns of FR-010 a program can recognise (credentials, email addresses, IP
  addresses, cloud account identifiers), MUST run in the required test check of every pull request. A
  failure MUST name the file, say which check failed and point to the update procedure (FR-018), and a
  warning of FR-016 MUST say that the model is behind the rules and point to the same procedure.

**Keeping it current**

- **FR-018**: The folder's description MUST say what each file is; that the model was built in Specter
  and how it was produced; how to read the report and how to load the Specter file into Specter; and
  the update procedure: load the committed file into an empty project, make the change in the app,
  export both files, replace the committed ones, and run the checks. It MUST say that every import
  gives every record a new identifier, so every identifier in the Specter file changes on every
  update, and that the report, whose order and numbering do not depend on identifiers, is the file
  to review.
- **FR-019**: The repository's front page and the contribution guide MUST link to the model, and the
  pull request template MUST ask whether the change adds an entry point, an asset or a trust boundary
  and, if so, whether the constitution's section and the model were updated.
- **FR-020**: The constitution MUST state that the Threat Model section governs when it disagrees
  with the committed model, that the model is corrected to agree, and that a change that updates the
  section updates the model in the same change (Principle V). Its Sync Impact Report, version and
  date MUST be updated, as for each earlier milestone.
- **FR-021**: The findings of User Story 5 MUST be recorded in the pull request description. A defect
  that stops the model being accurate MUST be fixed in this milestone with a failing test first; any
  other finding MUST be recorded as an issue and not built here.
- **FR-022**: This milestone MUST NOT change the product's behaviour except to fix a defect under
  FR-021, MUST NOT add an endpoint, a table, a migration or a dependency, and MUST NOT add content
  that belongs to a later phase.

### Key Entities *(include if feature involves data)*

- **Specter's own threat model** (existing kind of record, new content): one project and one threat
  model, with the elements, flows, boundaries, threats and mitigations of FR-001 to FR-009. It is
  made and kept in a running Specter, and lives in the repository only as its two exports.
- **The committed Specter file** (derived, committed): the lossless export of the model, the form the
  checks load. Its identifiers are those of the install that exported it.
- **The committed report** (derived, committed): the Markdown report of the same model, the form a
  reader opens and a reviewer compares.
- **The checks** (test-suite): the conditions of FR-014 to FR-017, run on every pull request.
- **The traceability list** (review aid, in the pull request): each risk of the constitution's Threat
  Model section, the threat of the model that represents it, and the two statuses compared (FR-007).
- **The findings** (review aid, in the pull request): what building the model exposed (User Story 5).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The committed Specter file is valid against the published schema, is accepted by the
  import check with 0 items left out, and imports and exports back to an equal file (FR-014), in 100%
  of runs of the test suite.
- **SC-002**: "Generate threats" on the model imported from the committed file flags 0 threats as
  stale and, on the code as merged, would create 0 threats (FR-016). Flagging a stale threat fails the
  build in 100% of cases; a threat it would create produces a warning in 100% of cases and never
  fails the build.
- **SC-003**: 100% of the risks the constitution's Threat Model section records as mitigated,
  partially mitigated, accepted or open appear in the traceability list with a threat whose status
  agrees, 100% of its current assets are on an element or in a threat, 100% of its current trust
  boundaries are trust boundaries of the diagram (the CI/CD boundary is represented by threats of the
  whole model, FR-003), and all six STRIDE categories have at least one threat; a reviewer confirms
  it from the list.
- **SC-004**: A visitor reaches the report from the repository's front page in 2 steps or fewer, with
  no tool installed, and it shows the diagram and the threats on the repository host.
- **SC-005**: Someone who did not write the procedure follows only the folder's description to add
  one threat to the model and gets two files that pass every check, with no step outside the
  description needed.
- **SC-006**: The check for credentials, email addresses, IP addresses and cloud account identifiers
  finds 0 matches in the committed files, and a reviewer finds 0 real deployment names in them.
- **SC-007**: Adding one threat to the model and committing again changes the report in that
  threat's section, the counts that depend on it and the export time, and in nothing else.
- **SC-008**: Every finding of User Story 5 is either fixed in this milestone with a test, or is an
  issue, and 0 are left only in someone's memory.

## Assumptions

- **The constitution governs.** Its Threat Model section is the text maintainers and reviewers are
  already bound by (Principle V); the model is the structured, checkable counterpart and is corrected
  when the two disagree. The checks cannot compare prose with the model, so keeping them aligned is a
  rule of review (FR-019, FR-020), and the traceability list is how this milestone proves they agree.
- **One threat model, the running system.** Plan.md speaks of "Specter's own threat model". The
  build and release pipeline and the supply chain cannot be drawn with the five element types, and the
  constitution records them as risks, so they are threats of the whole model.
- **Implemented behaviour only.** `plan.md` makes Phase 3 (Milestone 8, AI security hardening)
  responsible for updating the model for uploads and LLM egress; Phases 4 and 5 update it for their
  entry points in the same way.
- **Two files, no more.** The Specter file is the record, the report the reading copy. OTM and HTML
  are derived and nobody asked for them in the repository; either can be exported when needed.
- **Identifiers change on every update, by design of Milestone 6.** Milestone 6's import gives every
  record a new identifier, so the "update by importing the committed file" procedure rewrites every
  identifier in the Specter file. Milestone 6 expected stable identifiers only from one long-lived
  install that keeps exporting. This milestone does not depend on such an install and does not add a
  way to keep identifiers on import, which would be a product change. It makes the Markdown report the
  file to review, because its order and numbering depend on content only (Milestone 5). The cost is a
  noisy diff of the Specter file on every update.
- **Hand edits are a rule, not a check.** A change that leaves the Specter file in the form Specter
  writes cannot be told from an export. The description says to change the model in Specter, and a
  reviewer reading the report sees the change.
- **Status of the model.** The committed file carries a status. It is `approved` only after the
  maintainers have reviewed the traceability list; Specter has no approval workflow before Phase 6
  and the status is a record of that review, not a control.
- **Public by design.** Open and accepted risks are already published in the constitution, so the
  model discloses nothing new; FR-011 covers the one case where it could.
- **Where it lives.** The folder and the file names are the plan's to choose, in the repository's
  documentation. The names of the project and of the threat model are Specter's own.
- **Constitution update.** The milestone adds no entry point, endpoint or credential. It adds a
  committed artefact and a duty to keep it current, which is an expansion of Principle V's guidance
  and of the Threat Model section's preface, and is recorded in the constitution as a minor amendment.
- **What review decides.** Three requirements cannot be tested by a program and are judged in review,
  from the traceability list and the editor: that the layout is readable (FR-004), that no threat is
  left in a state only because nobody looked at it (FR-007), and that a reason or a mitigation says
  something true and useful (FR-008, FR-009). The checks guard what they can (names, statuses, the
  presence of a reason); the rest is a reviewer's call, and the pull request says so.
