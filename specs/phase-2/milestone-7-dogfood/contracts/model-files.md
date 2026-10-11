# Contract: the committed model and what points to it

What lands in the repository, in what form, and the exact content the documents that point to it must
carry. The checks that hold the files to this are in [checks.md](./checks.md).

## 1. The folder

```text
docs/threat-model/
├── README.md                    what these files are and how to change them
├── threat-model.specter.json    the Specter file (format version 1)
└── report.md                    the Markdown report
```

No other file: no OTM or HTML export (spec FR-012), no script, no image, no dated copy (git is the
history).

### The Specter file

- Exported with `GET /api/v1/threat-models/{id}/export?format=specter` (the **Download Specter file**
  button) from the authoring install, then saved **unchanged** as `threat-model.specter.json`. Not
  reformatted, not edited, not re-saved by an editor that changes line endings (check 1 fails on any
  of these).
- Its header: `format: "specter"`, `format_version: 1`, `exported_at` (the instant of the export),
  `project.name: "Specter"`, `threat_model.name: "Specter application"`, methodology `STRIDE`, status
  `in_review` or `approved` (data-model §1).
- Its content: the blueprint of [data-model.md](./../data-model.md): 41 elements, and the
  threats and mitigations of its §3 to §5.
- Its ids are those of the authoring install. They change in every update (research #1) and nothing
  reads them.

### The report

- Exported with `GET /api/v1/threat-models/{id}/report?format=markdown` (the **Download Markdown
  report** button) from the **same threat model** and **the same state** as the file, then saved
  unchanged as `report.md`. Exporting the file and the report between two edits would make them
  disagree and check 7 would say so.
- It has the sections Specter writes: title, header (project, methodology, status, export time,
  contents), risk summary, the fenced `mermaid` diagram, the elements grouped by trust boundary, and
  "Threats not linked to an element", which holds the pipeline's threats (data-model §4, group M).
- Its text is escaped by Milestone 5's escaper: a name that contains Markdown shows as typed.

## 2. `docs/threat-model/README.md`

Required content (spec FR-018). The headings are fixed so other documents can link to them.

1. **Specter's own threat model**: one paragraph. What it is: Specter's threat model, built in
   Specter, kept as two files. What it covers: the system as implemented through Phase 2 Milestone 6,
   and nothing planned (Phase 3's milestone 8 updates it for document uploads and LLM providers).
2. **The files**: a table of the two, one line each, with a link to the report that says "start here".
3. **How it was produced**: built in a running Specter through its documented API and web app, then
   exported unchanged; the model is not written by hand and the report is not edited. Which version of
   Specter exported it is the commit it was committed in.
4. **Reading it**: the report is the one to read; it draws the diagram, groups threats by element, and
   starts with a risk summary. Statuses: what `open`, `mitigated`, `accepted` and `not applicable`
   mean here, and that a *partially mitigated* risk is an open threat carrying its implemented
   controls (research #10).
5. **Loading it into Specter**: **Import threat model** on a project's page, or the API
   (`POST /api/v1/projects/{id}/imports`), with a link to `docs/formats/specter-file.md`.
6. **Which document governs**: the constitution's Threat Model section. If the two disagree, the model
   is corrected (spec FR-020). The model is not a second opinion.
7. **Updating the model**: the numbered procedure below.
8. **What the checks do**: what fails the build (a file that is not what Specter exports, a stale
   threat, a secret) and what only warns (a rule that would add a threat), and where the checks are
   (`apps/api/test/dogfood/`).
9. **How to decide a status**: the five-line triage table of data-model §5, so a contributor does not
   need the specs of this milestone.
10. **Found a vulnerability while modelling?** Report it by `SECURITY.md` first. It is written into the
    model only when it can be public (spec FR-011).
11. **What the Specter file's ids mean**: every id changes on every update, by design; review the
    report's diff, not the JSON's.

### The update procedure (item 7)

1. Start Specter locally (`docker compose up --build`, README) and sign in.
2. Create a project named `Specter`, or use the one you have, and **import** `threat-model.specter.json`
   into it from the project's page. Keep the project's name `Specter` and the threat model's name
   `Specter application`: the checks refuse the files if either changed (check 4).
3. Make the change in the editor: elements, flows, boundaries, threats, mitigations. If the diagram
   changed, run **Generate threats** and triage what it created by the table in "How to decide a
   status". Keep names unique within a type, and threat titles unique within an element and category
   (check 3).
4. From the threat model's page, download the **Specter file** and the **Markdown report**, one right
   after the other, with no edit between. Save them as `threat-model.specter.json` and `report.md`,
   replacing the committed ones.
5. Run the checks: `pnpm --filter @specter/api exec vitest run test/dogfood` (it needs the database of
   CONTRIBUTING's Setup).
6. Commit both files together, with the change that needed them. In the pull request, review the
   report's diff.

## 3. Documents that point to it

Each edit is small and exact.

| Document | Edit |
|---|---|
| `README.md`, under **Security** | A sentence after the `SECURITY.md` sentence: "Specter's own threat model, built in Specter, is in [`docs/threat-model/`](docs/threat-model/); [start with the report](docs/threat-model/report.md)." |
| `CONTRIBUTING.md` | A new section **Specter's own threat model**, after **Threat rules**: that a change which adds an entry point, an asset or a trust boundary updates the constitution's Threat Model section **and** the model in the same change; that retiring or changing a rule makes the checks fail until the model is updated, while adding one only warns; and the link to the folder's README. In **Threat rules**, one sentence: a retired rule shows up as a stale threat in the model, so a retirement updates the model in the same pull request. |
| `.github/pull_request_template.md`, `## Threat Model` | The comment gains: "…and, if you added an asset, an entry point or a trust boundary, or retired or changed a rule, whether `docs/threat-model/` was updated (see its README)." |
| `docs/ci.md`, the `test` check | A short paragraph: the new checks, what blocks, what warns, where the warning appears. |
| `.specify/memory/constitution.md` | See research #12 and below. |

### The constitution's wording

Added to **Principle V** (after its last sentence about broadening what an authenticated user can do),
in the document's own voice:

> Specter's own threat model is committed in `docs/threat-model/` (a Specter file and its Markdown
> report, built in Specter). The Threat Model section below governs: if the two disagree, the model is
> corrected. A change that updates the section MUST update the model in the same change; a change that
> only adds a rule to the threat library may follow with the update, because the checks then only warn.

Added to the preface of the **Threat Model (STRIDE)** section, one sentence: "`docs/threat-model/`
holds the same threat model as a Specter file and a report, kept in step with this section; this
section governs."

**Sync Impact Report**: version 1.11.0 → 1.12.0, MINOR; rationale (Phase 2 Milestone 7,
`specs/phase-2/milestone-7-dogfood/`: adds a committed artefact and the duty to keep it current,
including the case where a rule is retired); modified principles: V (applied, text extended); Threat
Model changes: none (no endpoint, asset or trust boundary, and the model discloses nothing the section
does not); added and removed sections: none; the **Last Amended** date.

**Development Workflow & Quality Gates**: the pull-request duty to "update the Threat Model section if
it changes an entry point, asset, or trust boundary" gains "and `docs/threat-model/`".

The constitution is amended by editing the file; the spec-kit skill files under `.claude/skills/` are
untouched (a spec-kit upgrade would overwrite them).
