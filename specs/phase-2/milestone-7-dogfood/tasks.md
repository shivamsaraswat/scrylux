---

description: "Task list for Dogfood, Specter's Own Threat Model (Phase 2 / Milestone 7)"
---

# Tasks: Dogfood, Specter's Own Threat Model

**Input**: Design documents from `/specs/phase-2/milestone-7-dogfood/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/checks.md,
contracts/model-files.md, quickstart.md

**Tests**: Required.

- Constitution Principle II requires a failing test before each new behaviour, and the checks of
  contracts/checks.md are the behaviour this milestone adds to the build.
- In every phase, a test task **MUST be run and seen failing** before the implementation task that
  follows it. The one exception is the test of the committed files (T010), which fails until the files
  exist (T025 to T026): that failure is the point, and T029 is where it turns green.

**Organization**: by user story, but **not in priority order**, because test-first overrides it.

- **Phase 2 (Foundational)** holds the pure checks and their tests, which every story's acceptance
  depends on.
- **US3 (P2) is built before US1 and US2 (P1)**: its tests are the failing tests that the model and the
  committed files make pass. Its tasks T008 to T011 write and run them red; T029 is where they go green.
- **US1 → US2** then author the model and put its files in the repository.
- **US4 → US5** follow.
- **Stories are sequential**, not parallel. Almost everything in US1 and US2 is a step of one authoring
  session against one local install.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task).
- **[Story]**: US1 to US5, from spec.md. Setup, Foundational and Polish tasks have none.

## Path conventions

Shorthand used below. Paths are from the repository root.

- `TEST` = `apps/api/test/dogfood/`
- `DOC` = `docs/threat-model/`
- `SPEC` = `specs/phase-2/milestone-7-dogfood/`
- `SCRATCH` = a directory **outside the repository** for the authoring scripts, the triage table and
  the notes (research #6). Nothing from it is ever committed.

**No product code is touched** (spec FR-022): the only code written is test code under `TEST`.

---

## Phase 1: Setup

**Purpose**: a working baseline, and the one thing the design could not settle by reading.

- [X] T001 Confirm the baseline: `docker compose up -d db`; `pnpm install --frozen-lockfile`; `.env.test`
  exists (CONTRIBUTING.md, Setup). Run `pnpm --filter @specter/api exec vitest run test/exchange test/contract/v1/exchange.test.ts test/contract/v1/reports.test.ts`
  and record that it is green. Do **not** run `docker compose down -v` at any point: the volume holds
  the developer's data and is the test database.
- [X] T002 Spike, **before anything depends on it**: does a Vitest annotation reach the GitHub reporter
  under this repository's configuration (research #4)? Create `TEST/annotate-spike.test.ts` with one
  test that calls `await task.annotate('spike', 'warning')` (the test context's `annotate`), run
  `GITHUB_ACTIONS=true pnpm --filter @specter/api exec vitest run test/dogfood/annotate-spike.test.ts`,
  and look for a line starting `::warning` carrying a `file=` and `line=`. Record the result in research
  #4 ("Verified on <date>: yes" or the fallback chosen and why), then **delete the spike file**. If the
  annotation does not appear, switch research #4 and contracts/checks.md ("The warning annotation") to
  the fallback (`::warning title=…::` written with `process.stdout.write`) before T012.

---

## Phase 2: Foundational (the pure checks)

**Purpose**: checks 1, 3, 4, 5 and the classifiers of 6 and 7 of contracts/checks.md as pure functions,
each shown to fail. **No operation, no database, no committed file** is needed here.

**⚠️ CRITICAL**: US3 to US5 build on these.

- [X] T003 Write the failing tests in `TEST/checks.test.ts` (new file; imports from `./checks.js` and
  `./patterns.js`, which do not exist yet) for the formatter and checks 1, 3, 4, 5, from the "Tests of the
  checks themselves" table in contracts/checks.md. Cases:
  - **`formatFinding`**: output is exactly two lines, `<file>: <check>: <message>.` then
    `Fix: <fix>. See "Updating the model" in docs/threat-model/README.md.`; it never contains a long text
    field.
  - **1 `form`**: passes a valid file written by `serializeExport` (from `apps/api/src/exchange/specter-export.ts`);
    fails keys reordered, CRLF line endings, no final newline, and a schema break (a threat with an
    unknown status). Validate with `ajv2020()` from `apps/api/test/exchange/ajv.ts` (draft 2020-12; **not**
    `ajvDraft07`) against `docs/formats/specter-file-v1.schema.json`, and with `SpecterFileV1` from
    `@specter/core`. Build inputs with `us1Model` / `canonical` from `apps/api/test/exchange/fixtures.ts`.
  - **3 `ties`**: fails two processes named alike (different case, extra surrounding space), two threats
    with one category and title on one element (or both on none), two mitigations of one threat with one
    description; passes the same names on different element types. Rule: "No two elements of one type
    share a name (case-insensitive, trimmed); no two threats of one element (or of none) share a category
    and title; no two mitigations of one threat share a description."
  - **4 `shape`**: fails a `project.name` other than `Specter`, a `threat_model.name` other than
    `Specter application`, a methodology other than STRIDE, a status outside `in_review` / `approved`, an
    `ai`-origin threat, a missing STRIDE category (each of the six: Spoofing, Tampering, Repudiation,
    Information Disclosure, Denial of Service, Elevation of Privilege), an `accepted` or `not_applicable`
    threat with a `null` `status_reason`, a `mitigated` threat whose only mitigation is `proposed`, no
    trust boundary, no threat with `element_id: null`.
  - **4 `folder`** (`checkFolder(names)`): passes exactly `README.md`, `report.md` and
    `threat-model.specter.json`; fails an extra file (`threat-model.otm.json`, `report.html`, a script,
    an image) and a missing one, naming it (spec FR-012).
  - **5 `patterns`**: for **each** pattern of research #9 one sample that matches and one near-miss that
    does not, written as text of the **JSON file** (the report escapes punctuation, so the JSON scan
    carries the check).

  Run `pnpm --filter @specter/api exec vitest run test/dogfood/checks.test.ts` and **confirm it fails**
  (module not found).
- [X] T004 [P] Create `TEST/patterns.ts`: a data module with **no logic**, exporting the table of research
  #9 as `{ name, pattern, description }` entries: email address; IPv4 address (four dotted groups of 0 to
  255); 12-digit cloud account identifier (`\b\d{12}\b`); AWS access key id (`AKIA` or `ASIA` then 16
  capitals or digits); JSON web token (`eyJ…` three dot-separated groups); bearer credential (`Bearer `
  then 20 or more token characters); private key block (`-----BEGIN … PRIVATE KEY-----`); hosting-provider
  token (`gh[pousr]_` then 36 characters); an assignment to `password`, `secret`, `token` or `api_key`
  followed by `=` or `:` and a non-empty value. Constitution Principle IV: heuristics are data.
- [X] T005 Implement `TEST/checks.ts` until T003 passes: `interface Finding { check; file; message; fix }`,
  `formatFinding`, `checkForm(text)`, `checkTies(file)`, `checkShape(file)`, `checkFolder(names)`,
  `checkPatterns(fileName, text)`.
  Pure, no I/O, no database. A message names a title, an element or a rule, **never a description or a
  reason** (contracts/checks.md, "Messages"). `checkForm` requires the text to equal
  `serializeExport(JSON.parse(text))`.
- [X] T006 Add failing tests to `TEST/checks.test.ts` for the pure functions of checks 2, 6 and 7:
  - **`classifyRegeneration(before, afterThreats, afterElements)`** returns `{ stale, behind }`. Rule
    threats are keyed by (element type, element name, `library_ref`), never by id. `stale` holds each
    threat with a `stale` mark after the run **and** each threat already carrying one in `before`;
    `behind` holds each rule threat present after and absent before, naming the rule and the element. A
    non-empty `skipped_elements` is a `stale`-class failure. An edited text, status or mitigation is
    **not** drift.
  - **`checkRoundTrip(summary, file, exportedFile)`** (check 2's pure half): fails a summary with a
    note, with a name issue, or whose counts of elements, threats or mitigations differ from the file's;
    fails when `canonical()` (from `apps/api/test/exchange/fixtures.ts`) of `file` and `exportedFile`
    differ, for example in one threat's status; passes two files that differ only in ids, `exported_at`
    and the project name.
  - **`compareReport(committed, built, file)`** sets aside only the `**Project:**` line and the
    `**Exported:**` line (research #5); fails one changed line (the message names the **line number**,
    not the text); passes a changed project line and a changed export time; fails a committed report whose
    project line does not name `file.project.name`, whose title does not name the threat model, or that
    lacks a fenced ```` ```mermaid ```` block.

  Run and confirm it fails.
- [X] T007 Implement `checkRoundTrip`, `classifyRegeneration` and `compareReport` in `TEST/checks.ts`
  until T006 passes.
  Run the whole `TEST/checks.test.ts` and confirm it is green.

**Checkpoint**: five of the seven checks exist as pure functions and are shown to fail.

---

## Phase 3: User Story 3 - The committed files are real, valid and loadable, and the build says so (Priority: P2, built first)

**Goal**: the checks over the committed files, through the real operations, and the proof that they can
fail.

**Independent test**: with deliberately broken inputs each check fails with a message of the contract's
shape; with the committed files (US2) every check passes and the run reports no warning.

- [X] T008 [US3] Write the database-backed cases of contracts/checks.md "Tests of the checks themselves"
  into `TEST/checks.test.ts`, in a **second `describe` that starts the app** (`startTestServer(app)`,
  `login`, `client` from `apps/api/test/contract/helpers.ts`, `uniqueName` and `seedUs1Model` from
  `apps/api/test/contract/v1/`), with an explicit `beforeAll` timeout (commit 23c5990 shows the default
  5 s is not a contract). Cases:
  - check 2: a file the import refuses (a threat with origin `ai`; a flow with no target) → the check
    reports the refusal **with its place in the file**. (The summary and `canonical()` comparisons are
    the pure `checkRoundTrip`, tested in T006.)
  - check 6: the Milestone 6 seeded model, exported, has a stale rule threat → 6a fails; a diagram with no
    generated threats yet → 6a passes and 6b warns; a model already generated and unchanged → neither.
  - **2, 6b and 7 together**: a committed file whose diagram has no generated threats yet. With **model A
    (never generated against)** and **model B (generated against)**, checks 2 and 7 **pass** on A and 6b
    **warns** on B. This pins the two-model arrangement (contracts/checks.md, "Two scratch imports"); it
    is the case your clarification chose to warn on.
  - check 7: a report with one changed line fails; one with only the project line or the export time
    changed passes; one without the diagram fence fails.

  Run and confirm the new cases fail (the orchestration helper they call does not exist yet).
- [X] T009 [US3] Implement the orchestration the tests of T008 use, in a new `TEST/operations.ts`
  (it calls the operations; `TEST/checks.ts` stays free of I/O): `importTwice(client, file)` (model A, and model B under another name, in one
  scratch project with a **unique** name, never `Specter`: research #5); `exportOf(model)`;
  `reportOf(model)` (`GET …/report?format=markdown`); `regenerate(model)`
  (`POST …/threats/generate`, then `GET …/threats` and `…/elements`, which return each threat's `stale`).
  Use the existing operations only. Run `TEST/checks.test.ts` and confirm it is green.
- [X] T010 [US3] Write `TEST/threat-model.test.ts`: reads `DOC/threat-model.specter.json`, `DOC/report.md`
  and `DOC/README.md` **relative to the test file** (`import.meta.url`, as `apps/api/test/global-setup.ts`
  does), and a missing file is a **failure** whose message names the fix, never a skip (research #13).
  A `beforeAll` with an explicit timeout imports the file twice (T009) and generates against B only. One
  `it` per check of contracts/checks.md: 1 `form`; 2 `round-trip` on A; 3 `ties`; 4 `shape` and
  `folder` (list `DOC/` with `readdir`); 5 `patterns`
  over the Specter file, the report and the README; 6a `stale` on B (blocks); 6b `behind-rules` on B (a
  **passing** test that raises one warning annotation per threat, collapsed to the first 10 and a count,
  with the mechanism T002 chose); 7 `report` on A. Every failure goes through `formatFinding`.
- [X] T011 [US3] Run `pnpm --filter @specter/api exec vitest run test/dogfood` and **confirm
  `threat-model.test.ts` fails because `DOC/` does not exist yet**, with the message naming the missing
  file and the fix, and that `checks.test.ts` is green. Record it in `SCRATCH/notes.md`.

**Checkpoint**: the build can already tell the files are missing. T029 turns it green.

---

## Phase 4: User Story 1 - A threat model of Specter that is true to Specter (Priority: P1)

**Goal**: the model, built in a running Specter, from the blueprint of data-model.md.

**Independent test** (spec US1): walk the constitution's Threat Model section and check each asset,
boundary and risk against the model (T022).

Everything here happens in a local install, through the documented API (`API.md`) and the web app, with
scripts in `SCRATCH`. Nothing is written into the repository until Phase 5.

- [X] T012 [US1] Start the app: `docker compose up --build`; `GET http://localhost:3000/health` returns
  200; sign in as `admin` / `admin`; take a bearer token from `POST /api/login` (`API.md`). Create
  `SCRATCH` outside the repository with `notes.md` for findings. Do **not** wipe the volume (T001).
- [X] T013 [US1] **Check the blueprint against the repository before drawing anything.** For every
  element in data-model §2.2 to §2.5, open its "Evidence" file and confirm the component exists and does
  what the table says; decide each flag from the code and `deployment.md` / `README.md`. A flag whose
  answer you cannot establish **stays unassessed** (spec FR-003: "is left unassessed, and is never
  guessed"). Any correction to the blueprint, and each unassessed flag, goes into `SCRATCH/notes.md` as a
  **finding**. Output: `SCRATCH/diagram.json`, the final list of elements with type, name, tags, flags,
  parent and flow ends.

  **Then verify the controls the register will cite**, because they become public mitigation text
  (spec FR-008). For each of the 43 rows of data-model §4, confirm that every file, symbol and document
  it names exists and does what the row says (for example `DUMMY_HASH` in `apps/api/src/auth.ts`,
  `requireV1Token`, `session/throttle.ts`, `session/cookie.ts`, `v1/write-log.ts`,
  `.github/rulesets/main.json`), by reading it. For each row you intend to mark `verified`, find the
  automated test that covers the control and note its path; a row with no such test is `implemented`,
  never `verified`. A row whose control **cannot be found or does not do what the register says** is
  not written as mitigated: correct the row (open or accepted, with the true reason) and record a
  **finding**. Output: `SCRATCH/controls.json`, row id → verified paths and tests, with the corrections.
  T017, T019 and T020 use this file, not data-model §4, as their source of control references.
- [X] T014 [US1] Create the project `Specter` and the threat model `Specter application`, methodology
  `STRIDE`, with the API. Then the elements in dependency order, using the batch operation
  `POST /api/v1/threat-models/{id}/elements/batch` (at most 200 operations; one transaction): trust
  boundaries outermost first, then external entities and processes and data stores, then data flows
  (a flow's source and target must already exist, and a flow has no parent boundary). Constraints to
  respect: element names unique within a type; at most 20 tags of at most 50 characters each; flags only
  those that belong to the element's type (`ELEMENT_FLAGS`); positions on the 200 by 120 grid with 40 px
  inside every boundary (data-model §2.6). The model must have **41 elements** unless T013 changed it.
- [X] T015 [US1] Open the threat model in the web app and check the layout by eye (spec FR-004): no
  element hides another, every node is inside the boundary it belongs to, the four boundaries nest as in
  data-model §2.1. Fix positions in the editor, or through the API, until it reads well. Take a
  screenshot into `SCRATCH/` for the pull request.
- [X] T016 [US1] Run **Generate threats** once (`POST /api/v1/threat-models/{id}/threats/generate`).
  Record the counts (`created`; `skipped_elements`, a list, must be empty). Dump every threat to
  `SCRATCH/generated.json` with its element name and `library_ref`. Do not delete any to make the model
  smaller: **every generated threat is kept and triaged** (data-model §3).
- [X] T017 [US1] Build the triage table `SCRATCH/triage.json`, keyed by (element name, `library_ref`),
  never by id: for each generated threat, one disposition of data-model §5, tried in order. (1) the same
  risk as a register row (§4) → that row's status, reason and mitigations; (2) a control addresses it →
  `mitigated` with an `implemented` or `verified` mitigation naming the control and where it is
  documented (take control references from `SCRATCH/controls.json`, T013); (3) it cannot happen here → `not_applicable` with a reason stating the fact; (4) a known,
  deferred gap → `accepted` with a reason that says why and until when; (5) an unrecorded real gap →
  `open`, **and a finding**. Constraints: a reason is at most 10,000 characters; an `accepted` or
  `not_applicable` threat **needs** a reason and any other status must have none; `verified` only where
  an automated test covers the control (name the test in the text); `proposed` only for a remedy
  `plan.md` schedules; `external_ref` stays empty. Likelihood and impact are Low, Medium or High and are
  confirmed or changed (a change that contradicts the rule's default is a finding). The table must cover
  **every** generated threat: stop and ask if one has no disposition.
- [X] T018 [US1] Map each register row of data-model §4 (43 rows) to a generated threat or mark it
  "manual". A row whose risk **is** a generated threat is applied to that threat (no manual twin,
  data-model §3 "One risk, one threat"). Output `SCRATCH/register-map.json`: row → generated threat or
  manual. Rows of group M are always manual and model-level.
- [X] T019 [US1] Apply `SCRATCH/triage.json` through the API, in this order for each threat: create its
  mitigations first, then `PATCH` the status (a threat cannot be created `mitigated`; a move to
  `mitigated` needs an implemented or verified mitigation; the API enforces both). Fix any refusal by
  correcting the table, not by loosening a rule.
- [X] T020 [US1] Create the manual threats of T018 (control references from `SCRATCH/controls.json`,
  T013) with `POST /api/v1/threats` (`origin` is always
  `manual`; the API refuses any other): on their element, or with `element_id` empty for the pipeline
  risks T10, T11, T12, I4, E5 (**these five stand for the CI/CD boundary**, spec FR-003). Give each its
  likelihood and impact, its mitigations, and its status and reason per the register. Titles unique within
  an element and category; mitigation text unique within a threat.
- [X] T021 [US1] Self-check before exporting: no ties (element names per type, threat titles per element
  and category, mitigation text per threat); all six STRIDE categories present; every `mitigated` threat
  has an implemented or verified mitigation; every `accepted` or `not_applicable` threat has a reason;
  no threat is `ai`. Run the pure checks on a scratch export: save `GET …/export?format=specter` to
  `SCRATCH/draft.specter.json` and run `checkTies`, `checkShape` and `checkPatterns` from
  `TEST/checks.ts` against it (a one-off script in `SCRATCH`). Fix the model until clean.
- [X] T022 [US1] Build the **traceability list** `SCRATCH/traceability.md` by walking the constitution's
  Threat Model (STRIDE) section **top to bottom**, not by trusting data-model §4: one row per asset
  (Assets, current), per trust boundary (Trust boundaries, current, with the CI/CD boundary pointing at
  its five whole-model threats), and per risk, giving the element or threat that represents it and the
  constitution's wording next to the model's status. "Planned" items and "No widening" notes are listed
  as "not in the model, by design". Where they disagree, **the model is corrected**, because the
  constitution governs (spec FR-020). Result: 0 rows without a counterpart (spec SC-003).
- [X] T023 [US1] Consolidate `SCRATCH/notes.md` into the findings list: what was tried, what happened,
  the work-around. Include every unassessed flag, every disposition-5 gap, everything the editor or the
  rules could not express, and the id-churn cost of the update procedure. **If a finding is an
  exploitable, unfixed vulnerability in released code, stop**: it goes through `SECURITY.md` first and
  is not written into the model until it can be public (spec FR-011). Tell the user.

**Checkpoint**: the model is complete in the local install.

---

## Phase 5: User Story 2 - Read it in the repository, without installing anything (Priority: P1)

**Goal**: the two exports are committed unchanged, with a README, reachable from the front page.

**Independent test** (spec US2): from the repository's front page reach the report in two steps or
fewer and read the diagram and the threats; validate the Specter file against the published schema.

- [X] T024 [US2] Set the threat model's status to `in_review` (not `approved`: only a maintainer who has
  read the traceability list sets that, spec Assumptions), then **export both files back to back with no
  edit between**: the Specter file (`GET …/export?format=specter`, or the **Download Specter file**
  button), then the Markdown report (`GET …/report?format=markdown`, or the button). Save to
  `SCRATCH/export/`.
- [X] T025 [US2] Create `DOC/` and copy the exports in **unchanged**, with exactly these names:
  `DOC/threat-model.specter.json` and `DOC/report.md`. No reformatting, no editor re-save, no line-ending
  change. Verify with `cmp SCRATCH/export/<file> DOC/<name>` (byte-identical) and, for the JSON,
  `git diff --stat` shows one new file with no whitespace warning.
- [X] T026 [US2] Write `DOC/README.md` with the eleven headings and content of contracts/model-files.md §2
  (including the six-step update procedure, the five-line status table of data-model §5, the statement
  that **every id in the Specter file changes on every update and the report is the file to review**, the
  scope statement, and the `SECURITY.md` rule). Use the fixed headings: "Specter's own threat model",
  "The files", "How it was produced", "Reading it", "Loading it into Specter", "Which document governs",
  "Updating the model", "What the checks do", "How to decide a status", "Found a vulnerability while
  modelling?", "What the Specter file's ids mean". No host, address, account or secret in it (spec FR-010).
- [X] T027 [P] [US2] Edit `README.md` under **Security**: add the sentence of contracts/model-files.md §3
  linking `docs/threat-model/` and its report. Do not rewrite the "Current status" paragraph; it is not
  this milestone's to change.
- [X] T028 [US2] Look at it: import `DOC/threat-model.specter.json` into a **fresh project of a local
  install** and check the diagram in the editor; push the branch (ask the user first, pushing is
  outward-facing) or use any CommonMark-with-Mermaid previewer to confirm `DOC/report.md` shows the
  diagram, headings, lists and the summary, and that a name containing Markdown shows as typed; from the
  repository's front page, count the steps to the report (must be 2 or fewer). Put screenshots in
  `SCRATCH/`.
- [X] T029 [US2] Run `pnpm --filter @specter/api exec vitest run test/dogfood` and **confirm it is green
  with no warning annotation**. If a check fails, **fix the model and re-export** (T024 to T025), never
  the check and never the file by hand. If 6b warns, the model is behind the shipped rules: generate,
  triage the new threats (T017 rules) and re-export. This is US3's checkpoint: the failing tests of T011
  now pass.

**Checkpoint**: the model is public in the repository and the build holds it.

---

## Phase 6: User Story 4 - Keep the model current, and know which document governs (Priority: P2)

**Goal**: a contributor knows when and how to update the model, and which document wins.

**Independent test** (spec US4): someone who did not write the procedure follows only the README to add
one threat; the result passes the checks and the report's diff is that threat only.

- [X] T030 [P] [US4] Edit `CONTRIBUTING.md`: add the section **Specter's own threat model** after
  **Threat rules** (a change that adds an entry point, an asset or a trust boundary updates the
  constitution's section **and** the model in the same change; a retired or changed rule makes the checks
  fail until the model is updated, while an added rule only warns; link to `DOC/README.md`), and one
  sentence in **Threat rules** that a retirement shows up as a stale threat so the same pull request
  updates the model.
- [X] T031 [P] [US4] Edit `.github/pull_request_template.md`, the `## Threat Model` comment: append
  "…and, if you added an asset, an entry point or a trust boundary, or retired or changed a rule, whether
  `docs/threat-model/` was updated (see its README)." (spec FR-019).
- [X] T032 [P] [US4] Edit `docs/ci.md`, in the section on the `test` check: a short paragraph naming
  `apps/api/test/dogfood/`, what fails the build (a file that is not what Specter exports, a stale threat,
  a secret pattern, a tie), what only warns (a rule that would add a threat) and where the warning shows
  on a pull request.
- [X] T033 [US4] Amend `.specify/memory/constitution.md` as contracts/model-files.md §3 says, **by editing
  the file only** (not the `.claude/skills/` files): add the paragraph to **Principle V**; the sentence to
  the preface of **Threat Model (STRIDE)**; the clause to **Development Workflow & Quality Gates**; a new
  Sync Impact Report at the top for **1.11.0 → 1.12.0** (MINOR; rationale Phase 2 Milestone 7; modified
  principles: V, applied and text extended; Threat Model changes: none; added and removed sections:
  none); `**Version**: 1.12.0` and `**Last Amended**` set to the date of the change. Keep the report's
  existing style.
- [X] T034 [US4] Dry-run the update procedure (quickstart §7), following **only** `DOC/README.md`,
  "Updating the model": import the committed file into a fresh project, add one new manual threat to one
  element, export both files, replace the committed ones, run the checks. Confirm they pass, and that
  `git diff DOC/report.md` shows only that threat's section, the summary counts that depend on it and the
  export time (spec SC-007), and that every id in the JSON changed. Then **restore**:
  `git checkout -- docs/threat-model/` for the two files if they were already committed, otherwise copy
  `SCRATCH/export/` back (T025). Note anything the README left out as a finding and fix the README.
  (Spec SC-005 asks for someone who did not write it: ask the user to repeat this step once.)
- [X] T035 [US4] Show that each check fails on the real files, on a scratch copy of `DOC/` (quickstart §5):
  each mutation in that table must produce the failure or warning it lists, with a message of the
  contract's shape. Then the annotation proof (quickstart §6): with the last row applied, run
  `GITHUB_ACTIONS=true pnpm --filter @specter/api exec vitest run test/dogfood` and confirm a `::warning`
  line with the message of contracts/checks.md and that the build step still passes. Restore the files and
  re-run green.

---

## Phase 7: User Story 5 - What building it taught us (Priority: P3)

**Goal**: everything the exercise exposed is written down, fixed with a test, or filed.

**Independent test** (spec US5): every finding is either fixed in this milestone with a test or recorded
as an issue; none lives only in someone's memory.

- [X] T036 [US5] Write `SPEC/pr-description.md` (as Milestone 6 did) with: the summary; "How this
  satisfies Principles I to VI" (the table of plan.md's Constitution Check); the security implications
  (none new; the model is public by design; FR-011); the Threat Model note (**No change** to the
  section's entries, and why; the Principle V amendment); the **traceability list** (T022); the
  **findings** (T013, T023, T034 and anything since), each marked *fixed here, with this test* or
  *recorded as an issue*; the statement that the Specter file's ids change on every update and the report
  is the file to review; and the manual checks done (quickstart §3, §5, §6).
- [X] T037 [US5] Fix every finding that **stops the model being accurate** (spec FR-021), if there is
  any: a failing test first (Principle II), then the fix, then the model re-exported (T024 to T025) and
  T029 re-run. A finding that is not blocking is **not** built here (Principle III): write the issue text
  into `SPEC/pr-description.md` and **ask the user before filing it** on GitHub (it is outward-facing).
  If there is no blocking finding, mark this task done and say so in the pull request description.

---

## Phase 8: Polish and gates

- [X] T038 Run the whole gate and confirm green: `pnpm typecheck`, `pnpm lint` (ESLint and the license
  check; it does not rewrite the committed files, so `git status` shows `DOC/` unchanged afterwards),
  `pnpm test`, `pnpm build`. A new test file must not stall or be stalled by the trigger test
  (commit 23c5990): if the suite times out, move the dogfood `beforeAll` timeout up, never skip a check.
- [X] T039 Confirm spec FR-022: `git diff main --stat` touches **only** `docs/threat-model/`,
  `apps/api/test/dogfood/`, `README.md`, `CONTRIBUTING.md`, `docs/ci.md`,
  `.github/pull_request_template.md`, `.specify/memory/constitution.md` and `specs/phase-2/milestone-7-dogfood/`
  (and a test-first fix of T037, if any). No product code, no migration, no `package.json`, no lockfile.
  `git ls-files docs/threat-model` lists **exactly** `README.md`, `report.md` and
  `threat-model.specter.json` (spec FR-012: no OTM or HTML export, no script, no image); the folder check
  of T010 enforces the same on every pull request.
- [X] T040 Final review of the three committed files for spec FR-010 and SC-006: read
  `DOC/threat-model.specter.json`, `DOC/report.md` and `DOC/README.md` end to end for a credential,
  secret, personal data, account name, address or identifier of a real deployment, and for any element,
  threat or wording of Phase 3 or later; the automated scan is a heuristic, not proof. Then tick the
  boxes of quickstart §10 and update `SPEC/spec.md` **Status** from Draft to Implemented, and
  `SPEC/checklists/requirements.md` if anything changed.
- [X] T041 Report to the user, **without committing or pushing**: what was built, the counts (elements,
  threats by status, mitigations, manual versus generated), the findings, which checks warn or block,
  and that the model is `in_review` pending a maintainer's read of the traceability list. The user decides
  when to commit and open the pull request.

---

## Dependencies and order

```text
T001 → T002 ──────────────────────────────────────────────┐ (T002 decides T010's warning mechanism)
T003 → T004[P] → T005 → T006 → T007                       (Phase 2, strictly red then green)
T007 → T008 → T009 → T010 → T011                          (US3: checks, red until T029)
T011 → T012 → T013 → T014 → T015 → T016 → T017 → T018 → T019 → T020 → T021 → T022 → T023   (US1)
T023 → T024 → T025 → T026 → T028 → T029                   (US2; T027 [P] after T025)
T029 → T030[P] T031[P] T032[P] → T033 → T034 → T035       (US4)
T035 → T036 → T037                                        (US5)
T037 → T038 → T039 → T040 → T041                          (Polish)
```

- **Setup** has no dependency; **T002 must precede T010**.
- **Foundational** blocks everything else.
- **US3 first** is deliberate (test-first). Its checkpoint (T011) is red by design; **T029 turns it
  green**, and no later task may start while T029 is red.
- **US1 → US2** is a strict chain: the files exist only after the model does.
- **US4's documents (T030, T031, T032)** can be written in parallel, but they link to `DOC/README.md`,
  so they follow T026. **T033** follows them so its wording matches the contribution guide.
- **A change to the model after T025 re-runs T024, T025 and T029**, in that order, every time.

### Parallel opportunities

- T004 with T003 (different files, no dependency until T005).
- T027 with T026 (different files).
- T030, T031 and T032 together (three different files).
- Nothing else in US1 or US2: they are one authoring session against one install.

---

## Requirement coverage

| Spec | Tasks |
|---|---|
| FR-001 to FR-003 (the diagram) | T013, T014, T015, T022 |
| FR-004 (unique names, readable layout) | T003 (ties), T015, T021 |
| FR-005 (assets) | T022 |
| FR-006, FR-007 (threats, statuses) | T016 to T022, T003 (shape) |
| FR-008, FR-009 (mitigations, reasons) | T013 (controls verified), T017, T019, T020 |
| FR-010 (no secrets) | T004, T005, T040 |
| FR-011 (vulnerabilities) | T023, T026, T037 |
| FR-012 (only the two files, plus the README) | T003, T005, T010 (`folder`), T039 |
| FR-013 (built in Specter, unchanged) | T024, T025 |
| FR-014 (valid, round trip) | T003 (form), T006, T007 (`checkRoundTrip`), T008 to T010, T029 |
| FR-015 (report) | T006, T007, T010, T029 |
| FR-016 (stale blocks, new warns) | T002, T006, T008 to T010, T035 |
| FR-017 (in the required check, clear messages) | T003, T010, T038 |
| FR-018 (the folder's description) | T026, T034 |
| FR-019 (front page, guide, template) | T027, T030, T031 |
| FR-020 (constitution governs) | T022, T033 |
| FR-021 (findings) | T023, T036, T037 |
| FR-022 (no product change) | T039 |
| SC-001 to SC-002 | T029, T035 |
| SC-003 (traceability) | T022 |
| SC-004 (two steps) | T028 |
| SC-005 (follow the procedure) | T034 |
| SC-006 (no secrets) | T005, T040 |
| SC-007 (small report diff) | T034 |
| SC-008 (findings) | T036, T037 |

---

## Implementation strategy

**MVP = Foundational + US3 + US1 + US2** (T001 to T029): the model, its two committed files, a README
and checks that hold them. That already satisfies the plan's line ("Build Specter's own threat model in
Specter and commit its export to the repo") and is a mergeable increment. US4 and US5 are what make it
last, and are small after it.

**Order of risk**: the annotation spike (T002) and the blueprint check (T013) come first because each can
change later tasks. The long task is T017 to T019 (triaging about 100 to 200 generated threats); keep
the table keyed by names so it survives a regeneration.

**Rules for the whole milestone**: the model is changed only in Specter, never in the file; a failing
check means the model or the checks' own bug is fixed, never a check loosened; nothing is committed or
pushed without the user asking.

---

## Phase 9: Convergence

**Purpose**: the work still unmet after `/speckit-implement`, found by assessing the repository against `spec.md`,
`plan.md`, this file and the constitution. Ordered by severity. Nothing here changes the design; each task closes a
gap between what the artifacts call for and what the repository holds now.

**Model changes follow one procedure.** Any task below that changes the model changes it **in Specter**: import
`docs/threat-model/threat-model.specter.json` into a project named `Specter` (rename or delete an earlier model of that
name first), make the change, download the Specter file and the Markdown report back to back, save them unchanged over
the committed ones, and run `pnpm --filter @specter/api exec vitest run test/dogfood` until it is green
(`docs/threat-model/README.md`, "Updating the model"). Never edit the committed files by hand.

- [X] T042 HIGH: Review the likelihood and impact of the 205 generated threats that are not open (55 mitigated, 82 accepted, 68 not applicable) in Specter, and confirm or change each rule-library default for this system, using the threat's own reason or mitigation as the evidence; record each change you make as a finding in `specs/phase-2/milestone-7-dogfood/pr-description.md` (the table after F23). Re-export both files and run the checks (procedure above). Then edit the "Every threat has a likelihood and an impact" bullet under "Reading it" in `docs/threat-model/README.md` and the F22 row of `pr-description.md` to say all threats were reviewed, not only the open ones; keep the sentence about the six Critical plain-HTTP threats per FR-006, T017, data-model.md §3 (partial)
- [X] T043 MEDIUM: Reconcile the model with FR-008, which says `proposed` is for a remedy the plan schedules, while 98 of the 131 `proposed` mitigations are rule-library suggestions on open threats that name no plan, phase or guide. Ask the maintainers which to do, then do exactly one. (a) In Specter, delete those 98 mitigations (the ones whose text names none of `plan.md`, a Phase, `step10` or "not yet planned"), re-export both files and run the checks (procedure above), and update F19 in `pr-description.md` and "How to decide a status" in `docs/threat-model/README.md` so `proposed` means only a scheduled remedy. Or (b) amend FR-008 in `spec.md` and the "Mitigations (FR-008)" paragraph of `data-model.md` §3 to say `proposed` also covers the rule library's own suggestions, and change nothing else per FR-008 (contradicts)
- [X] T044 MEDIUM: Record the five non-blocking findings as issues. Show the user the five drafts under "Issue drafts" in `specs/phase-2/milestone-7-dogfood/pr-description.md`, ask which to open (filing is outward-facing; do not file without their answer), open the chosen ones with `gh issue create --title … --body …` (body from the draft, with a link to the pull request and to `specs/phase-2/milestone-7-dogfood/`), and write each issue's number into the findings table of `pr-description.md` (draft 1 is F4, draft 2 is F6, draft 3 is F7, draft 4 is F10 and F18, draft 5 is F15) and mark the ones the user declined as "declined" per FR-021, SC-008 (partial)
- [x] T045 MEDIUM: View `docs/threat-model/report.md` on the hosted repository. Ask the user to push the branch (do not push yourself), open the report on the host and confirm the Mermaid diagram draws, the headings and lists display, and no name acts as markup; starting from the repository's front page, count the steps to the report (must be 2 or fewer: the root `README.md`'s Security section links to it). Record the result and a screenshot reference in `specs/phase-2/milestone-7-dogfood/pr-description.md`, under "Manual checks done", replacing the unchecked box per US2/AC2, SC-004, quickstart §3 (partial)
- [ ] T046 MEDIUM: Have someone other than the author follow only "Updating the model" in `docs/threat-model/README.md` to add one new manual threat to one element (quickstart §7), then record that the checks passed, that the report's diff was that threat only, and any step they found missing; fix the README for each gap. Restore the committed files afterwards unless the change is wanted. Tick the matching box in `pr-description.md` per SC-005, US4 (partial)
- [X] T047 MEDIUM: After the first CI run of the pull request, confirm in the `test` job that the dogfood tests pass with **0 warnings**, and that a `::warning` annotation, when one is raised, is attached to `apps/api/test/dogfood/threat-model.test.ts` on the pull request's Checks tab (locally the reporter prints `file=` as an absolute path). To check the attachment, temporarily remove one generated threat and its mitigations from a scratch copy of the Specter file in a throwaway branch, as quickstart §5 row 7 does; do not commit that to the pull request. If it does not attach, set the reporter's `onWritePath` option in `apps/api/vitest.config.ts` to return a path relative to the repository root, and re-run. Then tick "Checks green on CI, with the warning count at 0" in `quickstart.md` §10 per FR-016, FR-017 (partial)
- [X] T048 LOW: Review, as unrequested scope, the two wording corrections the 1.12.0 constitution amendment makes beyond FR-020 (`.specify/memory/constitution.md`: Dependabot's cooldown is 3 days, not 2; with the admin settings unset no account is seeded, so a new install cannot be signed in to). Both are listed in its Sync Impact Report and in findings F3 and F5 of `specs/phase-2/milestone-7-dogfood/pr-description.md`. Confirm the maintainers accept them in the pull request review, or revert them with a note per FR-020 (unrequested)
