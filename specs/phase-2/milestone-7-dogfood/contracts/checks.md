# Contract: the checks

The conditions of spec FR-014 to FR-017, as the test suite runs them. They live in
`apps/api/test/dogfood/`, join the `api` Vitest project, and so run in the required `test` check of
every pull request, against the Postgres service container, with no new job and no new dependency.

## What they read and what they call

| Input | Where from |
|---|---|
| The Specter file | `docs/threat-model/threat-model.specter.json`, found relative to the test file, never relative to the working directory |
| The report | `docs/threat-model/report.md` |
| The folder's description | `docs/threat-model/README.md` (only the pattern scan reads it) |
| The published schema | `docs/formats/specter-file-v1.schema.json` (JSON Schema 2020-12), through the existing `ajv2020()` helper in `apps/api/test/exchange/ajv.ts`, which `schema-current.test.ts` uses for the same file. Not `ajvDraft07`, which is for OTM |
| The app | `startTestServer(app)`, `login`, `client` from `apps/api/test/contract/helpers.ts`, as the exchange tests use them |

A missing file is a **failure** with the fix in the message, never a skip (research #13).

Operations used, all existing and all behind the sign-in: `POST /api/v1/projects`,
`POST /api/v1/projects/{id}/imports/check`, `POST /api/v1/projects/{id}/imports`,
`GET /api/v1/threat-models/{id}/export?format=specter`,
`GET /api/v1/threat-models/{id}/report?format=markdown`,
`POST /api/v1/threat-models/{id}/threats/generate`, `GET /api/v1/threat-models/{id}/threats` and
`GET /api/v1/threat-models/{id}/elements`. The scratch project has a unique name (research #5) and is
removed by the suite's own teardown, which deletes every project created during the run.

## The seven checks

Checks 1, 3, 4 and 5 are **pure functions** in `checks.ts` over text or a parsed file, so each can be
shown to fail on a crafted input. Checks 2, 6 and 7 call the operations (`operations.ts`, used by
`threat-model.test.ts`) and hand their results to pure functions in `checks.ts`:
`checkRoundTrip(file, summary, data, again)` for check 2 (`data` is the committed file, `again` the export of the imported model), `classifyRegeneration` for check 6 and
`compareReport` for check 7.

| # | Name | Rule | Blocks? | Spec |
|---|---|---|---|---|
| 1 | `form` | The file parses as JSON; validates against the shared zod schema and the published JSON Schema; and its text equals what the real exporter writes for the same content, `serializeExport(buildSpecterFile(snapshotOf(file), exported_at))` (the bytes, the key order and the order of the records). Writing the parsed value again would not do: `JSON.parse` keeps the order it is given. | yes | FR-013, FR-014 |
| 2 | `round-trip` | The import check accepts the file (a refusal is the failure, and its message names the place in the file); its summary has no note and no name issue, and the file's counts of elements, threats and mitigations (a Specter file imports with no note today, so this guards a future change). Importing it and exporting the new model gives a file whose `canonical()` form (ids replaced by position, export time and project name dropped) equals the committed file's. | yes | FR-014 |
| 3 | `ties` | No two elements of one type share a name (case-insensitive, trimmed); no two threats of one element (or of none) share a category and title; no two mitigations of one threat share a description. | yes | FR-004 |
| 4 | `shape` | `project.name` is `Specter` and `threat_model.name` is `Specter application`; the methodology is STRIDE; the status is `in_review` or `approved`; no threat has origin `ai`; each of the six STRIDE categories has at least one threat; no threat lacks what its status needs (an `accepted` or `not_applicable` threat without a reason; a `mitigated` threat without an implemented or verified mitigation); there is a trust boundary and a threat of the whole model. Also `folder`: `docs/threat-model/` holds exactly `README.md`, `report.md` and `threat-model.specter.json` (`checkFolder(names)`, pure; the test lists the directory). | yes | FR-001, FR-006, FR-007, FR-009, FR-012 |
| 5 | `patterns` | None of the patterns in `patterns.ts` (research #9) matches the Specter file, the report or the folder's README. | yes | FR-010 |
| 6a | `stale` | After "Generate threats" on the imported model, no threat carries a `stale` mark, and the committed file carries none. | **yes** | FR-016 |
| 6b | `behind-rules` | "Generate threats" on the imported model creates no threat; each one it would create is a warning. | **no, warns** | FR-016 |
| 7 | `report` | The report Specter builds for the imported model equals the committed report once the project line and the export line are set aside; the committed report's project line names the file's project and its title names the file's threat model; it contains the fenced `mermaid` diagram. | yes | FR-015 |

### Two scratch imports, so the warning cannot become a failure

The committed file is imported **twice**, into two scratch models of the one scratch project (the
second under another name), and **generation is run on only one of them**:

- **Model A** is imported and never generated against. Checks 2 and 7 export and report **this** one.
- **Model B** is imported and then generated against. Check 6 uses **this** one.

The order matters. Generation creates a threat for every rule the model is behind on. If it ran on the
model that is then exported or reported, those threats would appear in the export and the report, and
checks 2 and 7 would fail on exactly the case the build is meant only to warn about (a rule added
later). With two models a model that is behind its rules **passes** checks 2 and 7 and **warns** in 6b,
which is what the clarification decided (spec FR-016). A test of the checks pins it (below).

The two imports are done once, in the file's `beforeAll`, with an explicit timeout (the suite has been
stalled before by heavy transactions waiting for each other, commit 23c5990; these two are small, but
the default 5 s is not a contract). The committed files are never written by a test.

## How 6a and 6b tell the cases apart

The test reads model B's threats and elements after the run (`GET /threat-models/{id}/threats` returns
each threat's `stale`, which is part of the threat record), and the file's rule threats before it. It
keys a rule threat by (element type, element name, `library_ref`), never by id (#2 makes the key unique).

- **Stale (6a, blocks)**: a threat of the model whose `stale` is set after the run, or already set in the
  file. The message names the threat, its element, its rule and the engine's reason
  (`rule_retired`, `rule_unknown` or `conditions_unmet`), so the reader knows whether a rule was
  retired or an element changed.
- **Behind the rules (6b, warns)**: a rule threat present after the run and absent from the file. The
  message names the rule and the element.
- **Skipped elements** (the run's `skipped_elements` is not empty): a blocking failure of 6a. It means
  an element's stored properties are outside the vocabulary, which the import already refuses, so it
  should not be reachable; it is checked so it cannot be silent.

## Messages

A failing check names the file, the check and the fix. The shape is fixed so a pull request's reader
learns it once:

```text
docs/threat-model/threat-model.specter.json: <check>: <what is wrong>.
Fix: <the smallest thing to do>. See "Updating the model" in docs/threat-model/README.md.
```

Examples:

```text
docs/threat-model/report.md: report: line 112 differs from the report Specter builds for this file.
Fix: export the report again from the same threat model as the Specter file, without editing it. See "Updating the model" in docs/threat-model/README.md.

docs/threat-model/threat-model.specter.json: stale: the threat "Anonymous callers reach the process" on "Threat model API" would be flagged stale: rule p-spoofing-anonymous-callers-internet was retired (replaced by …).
Fix: import the file into Specter, run "Generate threats", review the stale threat, export again. See "Updating the model" in docs/threat-model/README.md.
```

The warning of 6b is a pass with an annotation (research #4):

```text
Specter's own threat model is behind its rules: rule p-… would add "…" to "Reverse proxy". The build passes.
Update docs/threat-model/ in this or a later change. See "Updating the model" in docs/threat-model/README.md.
```

A message never contains the content of a long text field (a description or a reason) and never a
secret: it names a title, an element and a rule. A line of the report is named by its number, not
quoted, so a failing pull request cannot echo something it should not.

## The warning annotation

Raised with the test context's `annotate(message, 'warning')` inside a test that passes, one per
threat, collapsed to the first 10 and a count when there are more. On GitHub Actions Vitest's own
reporter turns it into a `::warning file=…,line=…::message` on the pull request. **Verified** (the milestone's first task, 2026-10-11; research #4): under this repository's Vitest configuration the annotation reaches the reporter and is printed as `::warning file=…,line=…::message`. The fallback is in research #4 and is not needed. Either way the contract is the same: the message
above, no failure.

## Tests of the checks themselves (`checks.test.ts`)

Each check is shown to fail, so a check that can never fail cannot be merged. They use small crafted
inputs and the pure functions, and need no database except where noted.

| Check | Case shown to fail (and one that passes) |
|---|---|
| 1 `form` | A file with the keys reordered; one with CRLF line endings; one without the final newline; one that breaks the schema (a threat with an unknown status) |
| 2 `round-trip` | *Database.* A file the import refuses (a threat with origin `ai`, or a flow with no target): the check reports the refusal with its place in the file. *Pure.* The summary comparison: a summary with a note, a name issue or a wrong count; and `canonical()` of two files that differ in one threat's status |
| 3 `ties` | Two processes named alike (different case, extra space); two threats with one category and title on one element; two mitigations with one description on one threat |
| 4 `folder` | An extra file (`threat-model.otm.json`, `report.html`, a script, an image); a missing file |
| 4 `shape` | A project named otherwise; an `ai` threat; a missing STRIDE category; an accepted threat without a reason; a mitigated threat with only a proposed mitigation |
| 5 `patterns` | For each pattern, one sample that matches and one near-miss that does not (research #9). The samples are text of the **JSON file**: the report escapes punctuation (`\@`, `\.`), so a pattern may not match there, and the JSON scan is the one that carries the check |
| 6 `stale`, `behind-rules` | *Database.* The Milestone 6 seeded model (`seedUs1Model`) has a stale rule threat: export it as the "committed" file and expect 6a to fail; a diagram with no generated threats yet expects 6b to warn and 6a to pass; a model already generated and unchanged expects neither |
| 2, 6b, 7 together | *Database.* **The case the clarification chose to warn on**: a committed file whose diagram has no generated threats yet (so the shipped rules would add some). With the two-model arrangement, checks 2 and 7 **pass** and 6b **warns**; run on one shared model they would fail, which is why the arrangement is a requirement |
| 7 `report` | A report with one changed line; one with the project line changed (passes); one with the export time changed (passes); one without the diagram fence |

## What the checks do not do

- They do not compare the model with the constitution's prose (FR-007's mapping). That is the
  traceability list in the pull request and a rule of review (spec Assumptions).
- They cannot tell a hand edit that keeps the canonical form from an export (spec Edge Cases).
- They do not check that the report displays on the repository host; that is a visual check
  (quickstart §3).
- They do not run any AI feature or any browser. The Playwright tests are unchanged.
