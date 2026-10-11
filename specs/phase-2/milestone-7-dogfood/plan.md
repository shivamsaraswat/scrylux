# Implementation Plan: Dogfood, Specter's Own Threat Model

**Branch**: not yet created (spec directory `phase-2/milestone-7-dogfood`) | **Date**: 2026-10-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/phase-2/milestone-7-dogfood/spec.md`

## Summary

Build Specter's own threat model in a running Specter, export it twice (the Specter file and the
Markdown report), commit both under `docs/threat-model/`, and add the checks and the documentation
that keep them true.

This milestone is mostly **content and verification**, and adds no product code. The deliverables:

1. **The model** (spec FR-001 to FR-011): one project and one threat model, authored through the
   documented API of a local install, from the blueprint in [data-model.md](./data-model.md): the
   system inventory, the layout, the risk register that maps every risk of the constitution's Threat
   Model section to a threat and a status, and the triage policy for generated threats.
2. **Two committed files and a folder description** (FR-012, FR-013, FR-018): the exports of that
   model, untouched, in `docs/threat-model/`, with a `README.md` that says what they are and how to
   update them ([contracts/model-files.md](./contracts/model-files.md)).
3. **The checks** (FR-014 to FR-017): one new test directory in `apps/api/test/`, which loads the
   committed files through the real import, export, generate and report operations, exactly as the
   existing exchange tests do, so they run in the required `test` check with no new job
   ([contracts/checks.md](./contracts/checks.md)). A stale threat fails the build; a threat a new rule
   would add is a warning annotation on the pull request (research #3, #4).
4. **The links and the rule** (FR-019, FR-020): the README, the contribution guide and the pull request
   template point to the model; the constitution says which document governs and amends Principle V.

Two facts from the earlier milestones shape the design, and both are recorded rather than worked around:

- The Specter file holds stored ids, and an import gives every record a new one, so the "import, edit,
  export" update procedure rewrites every id. The Markdown report depends on content only, so it is the
  file to review (research #1). Checks must therefore never compare ids, and the model must have no ties
  that only an id could break (research #2).
- The shipped rules are read by generation, so the drift check can be the real "Generate threats" run
  on the imported model, with no second implementation of "stale" (research #3).

## Technical Context

**Language/Version**: TypeScript (strict), Node.js 22+. Test code only; the documentation is Markdown
and the committed model is JSON and Markdown.

**Primary Dependencies**: none added. The checks use what `apps/api` already has: Vitest, the Express
app under test, `ajv` and the published Specter file schema, and `micromark` with its GFM extension.
Authoring uses the running app's documented API (`API.md`) and throwaway scripts kept outside the
repository (research #6).

**Storage**: PostgreSQL, through the existing operations only. No table, column or migration (FR-022).
The committed files are plain files in the repository.

**Testing**: Vitest in `apps/api` (the `api` project, with the existing Postgres service container in
CI). New tests: `apps/api/test/dogfood/` for the committed files and for the checks themselves
(deliberately broken inputs, so each check is shown to fail).

**Target Platform**: the existing CI `test` check, and a developer's machine with the database from
CONTRIBUTING's Setup.

**Project Type**: monorepo (pnpm workspaces); this milestone touches `apps/api/test`, `docs/`, the
contribution documents and the constitution.

**Performance Goals**: the new tests add well under 10 seconds to the API suite: one model of roughly
200 threats is imported, generated against, exported and reported once.

**Constraints**:
- No product change, no endpoint, no table, no migration, no dependency (FR-022).
- The checks must not depend on ids, on the clock, or on the project name of the authoring install
  (research #1, #5).
- The committed files are byte-for-byte what Specter exports: no reformatting by a tool, no hand edit
  (FR-013). Lint is ESLint only (`pnpm lint`), so nothing rewrites them.
- A throwaway test project must not collide with a developer's real project: names are unique
  install-wide, and tests share the local database (research #5).

**Scale/Scope**: 41 elements (4 boundaries, 16 nodes and 21 flows), about 100 to 200 threats (generated
and manual) and about 150 to 300 mitigations. Far below every limit (1,000 elements, 64 MiB).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Check | Result |
|---|---|---|
| **I. Secure coding** | No new input path, SQL or credential. The new tests read two committed files and call existing authenticated operations. FR-010's scan strengthens it: the committed model is checked for credentials, personal data and deployment identifiers on every pull request. | Pass |
| **II. Test-first** | The checks are written first and fail while the files are absent (the order of the tasks, which `/speckit-tasks` must keep: checks before the files). Each check also has a test against a deliberately broken input, so a check that can never fail cannot pass review. The generation, report and exchange operations are already covered by their own milestones. | Pass |
| **III. Simplicity** | No dependency, abstraction, option or later-phase content. One test directory. The authoring scripts are throwaway and not committed, because a committed script would be a second source of truth for the model. | Pass |
| **IV. Maintainability** | No environment variable, no log line. The secret-scan patterns live in a data module with no logic, as Milestone 6's mappings do, so they can be read and diffed without reading test code. The checks name file, check and fix. | Pass |
| **V. Threat-aware design** | No new endpoint, asset or trust boundary. The milestone adds a committed artefact and a duty to keep it current, and the constitution is amended in the same change (FR-020). Publishing open risks adds nothing: the constitution already lists them (spec, Assumptions). FR-011 covers an unfixed vulnerability found while modelling. | Pass |
| **VI. AI output is a draft** | No AI feature. The model holds no AI-origin threat and none of Phase 3's content (FR-001); the import refuses an AI-origin threat anyway. | Pass |

Post-design re-check: unchanged. Nothing in Phase 1 design adds an entry point, a dependency or a
rule outside the table above.

## Project Structure

### Documentation (this feature)

```text
specs/phase-2/milestone-7-dogfood/
├── plan.md              # This file
├── research.md          # Phase 0: decisions and the alternatives rejected
├── data-model.md        # Phase 1: the model's blueprint, the risk register, the triage policy
├── quickstart.md        # Phase 1: how to author, check and update, and what to expect
├── contracts/
│   ├── model-files.md   # The folder: files, names, form, the README's required content
│   └── checks.md        # The checks: inputs, rules, failure and warning messages
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks, not created by this command)
```

### Source Code (repository root)

```text
docs/
└── threat-model/
    ├── README.md                      # NEW  what the files are, how produced, how to read and update
    ├── threat-model.specter.json      # NEW  the Specter file exported from the authoring install
    └── report.md                      # NEW  the Markdown report exported from the same model
apps/api/test/dogfood/                 # NEW  the checks (contracts/checks.md)
├── patterns.ts                        # NEW  the secret and personal-data patterns, as data
├── checks.ts                          # NEW  pure checks over the files and over a regeneration result
├── operations.ts                      # NEW  the calls to the real operations: import twice, export, report, regenerate
├── checks.test.ts                     # NEW  each check against a deliberately broken input
└── threat-model.test.ts               # NEW  the committed files through the real operations
.github/pull_request_template.md       # EDIT  the Threat Model section asks about the committed model
CONTRIBUTING.md                        # EDIT  a section on the model; the rule section notes the check
README.md                              # EDIT  a link under Security
docs/ci.md                             # EDIT  what the new checks do, and the warning annotation
.specify/memory/constitution.md        # EDIT  Principle V, the section preface, Sync Impact Report
```

**Structure Decision**: the model lives in `docs/threat-model/`, next to `docs/formats/` and
`docs/ci.md`, because it is documentation of the project that happens to be machine-readable. The
checks live with the API's tests because they need the app and Postgres, and because the existing
exchange tests (`apps/api/test/exchange/`, `apps/api/test/contract/v1/`) already show how to start the
app, sign in and call the operations. A `dogfood` directory keeps them apart from those tests without a
new Vitest project: they join the `api` group and run with it (they are small and need no heavy
transaction, unlike `exchange-bound.test.ts`, which is why that one has its own group).

## Complexity Tracking

No constitution violations. Nothing to justify.
