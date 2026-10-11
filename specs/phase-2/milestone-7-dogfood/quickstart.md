# Quickstart: validating the dogfood milestone

How to prove, end to end, that the milestone works. Each section says what to run and what to expect.
Details live in [data-model.md](./data-model.md) (what the model holds), [contracts/checks.md](./contracts/checks.md)
(what the checks do) and [contracts/model-files.md](./contracts/model-files.md) (the folder).

## 0. Prerequisites

```sh
corepack enable
docker compose up -d db            # the database; CONTRIBUTING.md, Setup
pnpm install --frozen-lockfile
cp .env.example .env.test          # once; then edit it as CONTRIBUTING.md says
```

Authoring (§1) also needs the app itself: `docker compose up --build`, then
<http://localhost:3000> (`admin` / `admin`, the compose defaults). Do **not** wipe the compose volume to
get a clean start (`docker compose down -v` deletes the developer's local data, and it is the database
the test suite runs against too). A clean start is not needed: a new project holds only what you create,
and ids do not matter (research #1). The model's ids are those of the install that exports it.

## 1. Author the model

1. Create the project `Specter` and the threat model `Specter application` (STRIDE).
2. Draw the diagram of data-model §2 through the documented API (`API.md`), with a throwaway script kept
   **outside** the repository. The batch operation writes up to 200 elements in one request and is
   one transaction.
3. Run **Generate threats** once. Note the count (about 100 to 200 threats).
4. Apply the triage of data-model §5 and the register of §4: statuses and reasons first, then
   mitigations. A threat cannot be created `mitigated`: add its implemented mitigation, then change its
   status.
5. Add the manual threats of §4 that no generated threat covers, and the threats of the whole model.
6. Set every flag only from evidence (data-model §2); leave an unknown one unassessed.
7. Export the **Specter file** and then the **Markdown report**, one right after the other.

Expected: 41 elements; every threat with a status that agrees with its register row; no generated threat
still `open` for lack of a decision (an `open` one is in §4, or is a finding).

## 2. Put the files where they belong

```sh
mkdir -p docs/threat-model
cp <the exported specter file> docs/threat-model/threat-model.specter.json
cp <the exported report>       docs/threat-model/report.md
```

Write `docs/threat-model/README.md` (contracts/model-files.md §2) and make the edits of its §3.

## 3. Look at it

These are the checks no test can make (checks.md, "What the checks do not do").

- **The editor.** Import the file into a fresh project of a local install and open the threat model:
  no element hides another, every node sits inside the boundary it belongs to, and the four boundaries
  nest as in data-model §2.1. Screenshot it for the pull request.
- **The report on the repository host.** Push the branch and open `docs/threat-model/report.md` on the
  host: the diagram draws, the headings and lists are as designed, a name with Markdown in it shows as
  typed. Until the branch is pushed, any CommonMark-with-Mermaid previewer shows the same.
- **From the front page.** Starting at the repository's front page, reach the report in two steps or
  fewer (SC-004).

## 4. Run the checks

```sh
pnpm --filter @specter/api exec vitest run test/dogfood
```

Expected: every check passes, **no warning annotation**, and the run takes a few seconds. Then the
whole gate:

```sh
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Expected: all green. `pnpm lint` is ESLint, so it does not rewrite the committed files; `git status`
shows them unchanged afterwards.

## 5. Show that each check can fail

Do these on a scratch copy of the folder or revert afterwards. Each must fail with a message of the
shape in checks.md, naming the file, the check and the fix. (`checks.test.ts` proves the same on
crafted inputs, and runs on every pull request.)

| Do | Expect |
|---|---|
| Add a space inside `threat-model.specter.json` | `form`: the text is not what Specter writes |
| Change one threat's `status` to `accepted` and set its `status_reason` to `null` (do not delete the key: every key is always present, and `form` would fail first) | `shape`: a threat lacks what its status needs |
| Rename two processes to the same name | `ties` |
| Change one word of a threat title in `report.md` | `report`: a line differs |
| Paste `contact@example.org` into a mitigation text | `patterns`: an email address |
| Edit a generated threat's `library_ref` to an id that is not in the library | `stale` (blocks): `rule_unknown` |
| Delete one generated threat, with its mitigations, from the file | `behind-rules` warns (the `report` check also fails, and says so) |

## 6. The warning reaches the pull request (the annotation spike's proof)

```sh
GITHUB_ACTIONS=true pnpm --filter @specter/api exec vitest run test/dogfood
```

with the last row of §5 applied. Expected: the output contains a line starting `::warning` with the
file and line of the test and the message of checks.md, and the run still reports the other checks as
passed. If it does not, use the fallback of research #4, and record it as a finding.

## 7. The update procedure works for someone else (SC-005)

Someone who did not write it follows only `docs/threat-model/README.md`, "Updating the model", to add
one new manual threat to one element. Expected: the checks pass; the report's diff shows that threat's
section, the summary counts that depend on it and the export time, and nothing else (SC-007); the
Specter file's ids have all changed, as the README says they will.

## 8. The constitution and the other documents

- `.specify/memory/constitution.md`: version 1.12.0, a Sync Impact Report that says what changed, the
  Principle V and preface sentences of contracts/model-files.md §3.
- `README.md`, `CONTRIBUTING.md`, the pull request template and `docs/ci.md`: each has its edit, and no
  link is broken (open each link).

## 9. The traceability list (the one thing a reviewer must do)

Walk the constitution's **Threat Model (STRIDE)** section top to bottom and fill one row per asset, per
current trust boundary and per risk: the element or threat that represents it, and the two statuses
side by side. Put it in the pull request description with the findings. Expected: 0 rows without a
counterpart; the statuses agree by the mapping of research #10; all six STRIDE categories are covered
(SC-003). A disagreement is fixed in the model, because the section governs.

## 10. Before merging

- [ ] Checks green on CI, with the warning count at 0.
- [x] `git diff main --stat` touches only `docs/`, `apps/api/test/dogfood/`, the four documents,
  `.github/pull_request_template.md` and the constitution: **no product code** (FR-022).
- [x] The pull request carries the traceability list, the findings, and the statement "the model's ids
  change on every update; review the report" (spec Assumptions).
- [x] The model's status is `in_review`, or `approved` only if a maintainer has read the traceability
  list.
