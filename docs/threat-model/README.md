# Scrylux's own threat model

Scrylux is a threat modeling tool, so it keeps a threat model of itself, built in Scrylux and kept here as two files. It covers the system as it is implemented, through Phase 2 Milestone 8: the API, the web app, the database, the optional secrets manager and the optional proxy or load balancer, and the release pipeline that publishes the image (its risks are threats of the model as a whole, because a pipeline cannot be drawn with the five element types). Nothing planned and not shipped is drawn as if it existed. Phase 3's last milestone (AI security hardening) updates it for document uploads and LLM providers, and Phases 4 and 5 do the same for theirs ([`plan.md`](../../plan.md)).

**Start with [the report](report.md).**

## The files

| File | What it is |
|---|---|
| [`report.md`](report.md) | The Markdown report Scrylux writes: a risk summary, the data-flow diagram, every element with its threats and mitigations, and the threats that belong to no single element. Read this one. |
| [`threat-model.scrylux.json`](threat-model.scrylux.json) | The same threat model as a Scrylux file, the lossless export: [format and schema](../formats/scrylux-file.md). Load this one into Scrylux, or read it with a script. |

This folder holds these two files and this description, and nothing else. A check fails the build if it holds another.

## How it was produced

The model was built in a running Scrylux, through its documented API and its web app: the diagram, then "Generate threats", then a decision for every generated threat, then the threats the rules cannot derive. The two files are what Scrylux's **Download Scrylux file** and **Download Markdown report** write for that threat model, saved unchanged. They are not written by hand and the report is not edited. A check holds them to that (see [What the checks do](#what-the-checks-do)).

The diagram describes the reference deployment the repository documents: one app container, one PostgreSQL, an optional secrets manager and an optional proxy or load balancer. It names no cloud account, host or address. The build and release pipeline and the supply chain cannot be drawn with the five element types, so their risks are threats of the model as a whole, listed under "Threats not linked to an element" in the report.

## Reading it

- **Status** of a threat: `open` means it is a known gap and is still there; `mitigated` means a control is in place and the threat names it; `accepted` means the project has chosen to live with it, and the reason says why and until when; `not applicable` means it cannot happen in this system, and the reason says why.
- A risk that is **partially mitigated** is an `open` threat that carries the controls already in place, with what is missing as a `proposed` mitigation. Scrylux has no status in between.
- A mitigation is **`verified`** only where an automated test covers the control, and its text names the test. It is **`implemented`** where the control exists with no such test. It is **`proposed`** where it is a remedy that `plan.md`, a phase or a guide schedules and that is not in place yet.
- Every threat has a likelihood and an impact (Low, Medium or High), and **every one was reviewed against this system**, not left at the rule library's default. The rating is the threat's **inherent** one, before the control that decided it: a mitigated threat keeps it; an accepted threat is rated for what its reason says (traffic inside the operator's private network is Low likelihood, for instance); and a threat that is not applicable is rated **Low likelihood**, because it cannot happen here, with the library's impact kept to show what would be at stake. The report's risk summary counts the **open** threats by that rating. The six *Critical* ones are the plain-HTTP threats of the baseline deployment, kept at High likelihood and High impact because the AWS guide itself says passwords and the token cross the internet in cleartext; the flooding threats on Threat model API and Accounts API are Medium likelihood, because those routes refuse a request without a valid token before reading its body.
- The model is marked **approved**. Phase 2 Milestone 8 added the release pipeline's nine threats and corrected two mitigations (the write permissions and the action pins, which a test now holds), and the maintainer approved it on 2026-10-18, for everything through that milestone, after reading those against the constitution's Threat Model section. It had been approved on 2026-10-11 for everything before. Approved never means the system has no open risk: the open threats are listed in the report's summary.

## Loading it into Scrylux

On a project's page choose **Import threat model** and pick `threat-model.scrylux.json`, or use the API (`POST /api/v1/projects/{id}/imports`, with `…/imports/check` to preview). See [the Scrylux file](../formats/scrylux-file.md) and [`API.md`](../../API.md). An import creates a new threat model and never changes an existing one.

## Which document governs

The **Threat Model (STRIDE)** section of [the constitution](../../.specify/memory/constitution.md) governs. This model is its structured counterpart, and where the two disagree, the model is corrected. A change that updates the section updates the model in the same change (Principle V), except that a change which only adds a rule to the threat library may follow with the update, because the checks then only warn.

## Updating the model

1. Start Scrylux locally (`docker compose up --build`, see the [README](../../README.md)) and sign in.
2. Create a project named `Scrylux` (project names are unique in an install, so use the one you have if there is one) and **import** `threat-model.scrylux.json` into it from the project's page. Keep the project's name `Scrylux` and the threat model's name `Scrylux application`: the checks refuse the files if either changed. If the project already holds a threat model of that name, for example one you imported before, the import's preview says the name is taken: rename or delete the earlier one first, so that the imported one keeps its name.
3. Make the change in the editor: elements, flows, boundaries, threats, mitigations. If the diagram changed, run **Generate threats** and decide each threat it created, by the table in [How to decide a status](#how-to-decide-a-status). Keep names unique within an element type, threat titles unique within an element and a category, and mitigation texts unique within a threat.
4. From the threat model's page, download the **Scrylux file** and the **Markdown report**, one right after the other, with no edit between. Save them as `threat-model.scrylux.json` and `report.md`, replacing the committed ones.
5. Run the checks. They need the database of [CONTRIBUTING.md](../../CONTRIBUTING.md)'s Setup:

   ```sh
   pnpm --filter @scrylux/api exec vitest run test/dogfood
   ```

6. Commit both files together, with the change that needed them. In the pull request, review the report's diff.

## What the checks do

They live in [`apps/api/test/dogfood/`](../../apps/api/test/dogfood/) and run in the required `test` check of every pull request.

**They fail the build** when:

- a file is not what Scrylux writes, or does not match the published schema;
- Scrylux's import refuses the file, leaves something out, or the model does not export back to the same content;
- two records of one kind could only be ordered by their ids (a tie, see below);
- the project or the model has another name, a STRIDE category has no threat, a threat has a status its reason or mitigations do not support, or a threat is AI-drafted;
- the folder holds a file other than the three;
- a file holds something that looks like a credential, an email address, an IP address or a cloud account identifier;
- "Generate threats" on the imported model flags a threat of the model as **stale**, which happens when a rule is retired or changed so that a threat no longer matches it;
- the report is not the one Scrylux builds for the Scrylux file.

**They only warn** when "Generate threats" would **add** threats: a rule was added, or widened, and the model does not have its threats yet. The warning is an annotation on the test file, raised by a CI step of its own (*Threat model warnings*), naming the rule and the element; the build still passes. Update the model in that change or a later one.

## How to decide a status

For each threat a rule generates, try these in order and stop at the first that fits.

| # | If | Then |
|---|---|---|
| 1 | It is the same risk as one the constitution's section already records | The status, reason and mitigations that section gives |
| 2 | A control in this system addresses it | `mitigated`, with an `implemented` or `verified` mitigation that names the control and where it is documented |
| 3 | It cannot happen because of how this system is built | `not applicable`, with a reason that states that fact |
| 4 | It is a real gap the project knows and has put off | `accepted`, with a reason that says why and until when |
| 5 | It is a real gap nobody had written down | `open`, and say so in the pull request |

A reason is needed for `accepted` and `not applicable`, and for nothing else. A threat is `mitigated` only when it has an implemented or verified mitigation. The mitigations the rules suggest arrive as `proposed`. Keep one only if `plan.md`, a phase or a guide schedules the remedy, and say where in its text; delete the rest, on every threat, so that `proposed` always means a scheduled remedy not yet in place. Likelihood and impact are Low, Medium or High.

A tie is two records the report and the export order by content alone: two elements of one type with the same name, two threats of one element and category with the same title, two mitigations of one threat with the same text. An import gives every record a new id, so it could order them the other way. Rename one.

## Found a vulnerability while modelling?

Report it by [`SECURITY.md`](../../SECURITY.md) first, privately. A vulnerability in released code that is not yet fixed is written into this model only when it can be public.

## What the Scrylux file's ids mean

Nothing outside the file. Every import gives every record a new id, so **every id in `threat-model.scrylux.json` changes on every update**, and its diff is the whole file. Review the **report's** diff instead: its order and numbering depend on the content alone, so a change of one threat shows as one threat.
