# OWASP Threat Dragon

[OWASP Threat Dragon](https://owasp.org/www-project-threat-dragon/) is an open source threat modeling tool. Scrylux
**imports** Threat Dragon **version 2** models, so a team that modeled there can bring its diagrams and threats over
without redrawing them. Import only: Scrylux does not export Threat Dragon files.

- **Import**: **Import threat model** on a project's page, or `POST /api/v1/projects/{id}/imports` with
  `{ "format": "threat-dragon", "file": … }` (and `…/imports/check` to preview). See [API.md](../../API.md).
- **Version 2 only.** A version 1 model keeps its diagram in `diagramJson`; open it in Threat Dragon 2 and save it,
  which converts it, then import that file. Scrylux refuses a version 1 file and says so.

Threat Dragon files hold no documents, and an import creates none. Documents added to a Scrylux threat model (Phase 3 Milestone 3) are not
carried by any export or import format.

## One threat model per diagram

A Threat Dragon file can hold several diagrams; a Scrylux threat model has one. So an import creates **one threat model
per diagram**, all of them or none:

- a file with one diagram creates one model, named after the file's title;
- a file with several creates one per diagram, named `‹file title› – ‹diagram title›`.

Every model is a draft with the methodology STRIDE. The preview lets you change the names before anything is created,
and a name already used in the project, empty, over 200 characters or repeated in the file is shown on its field until
you change it.

## Cells

A diagram's cells map by their `shape`:

| Threat Dragon `shape` | Scrylux |
|---|---|
| `actor` | external entity (`external_entity`) |
| `process` | process (`process`) |
| `store` | data store (`data_store`) |
| `flow`, attached to two different nodes of the diagram | data flow (`flow`, from the source cell to the target cell) |
| `trust-boundary-box` | trust boundary |
| `trust-boundary-curve` | **not imported** (a line holds no elements in Scrylux), and listed |
| `td-text-block` | **not imported**, and listed |
| any other shape | **not imported**, and listed as `shape` |

A flow that is not attached to a node at both ends, or starts and ends at the same node, is not imported and is listed;
a flow attached to a cell the diagram does not contain refuses the file. The threats of a cell that was not imported
become threats of the model, and say so.

A cell with no name is named `Unnamed external entity`, `Unnamed process` and so on; a name over 200 characters is
shortened. Both are listed.

## Trust boundaries come from where things are drawn

Threat Dragon does not record what a cell is inside: a trust boundary box is only a rectangle drawn around other cells.
So Scrylux works the nesting out from the picture:

- a node is in the **smallest box that holds its centre**;
- a box is in the **smallest other box that holds all of it**;
- where areas are equal, the box earlier in the file wins.

Positions become relative to the box they are in, as Scrylux stores them. A position beyond ±100,000 leaves the element
for the canvas to place, and a box smaller than 40 is enlarged to 40; each is listed. A node's size is not kept: Scrylux
draws every node at one size.

## Properties

Threat Dragon's yes/no properties cannot tell **no** from **not considered**, and Scrylux's threat library treats the two
differently. So a `true` sets the Scrylux flag, and a **`false` leaves it not assessed**. It never becomes a "no".

| Cell | Threat Dragon property | Scrylux flag |
|---|---|---|
| `actor` | `providesAuthentication` | `authenticated` |
| `store` | `isEncrypted` | `encrypted_at_rest` |
| `store` | `storesCredentials` | `stores_sensitive_data` |
| `flow` | `isEncrypted` | `encrypted_in_transit` |

Two properties become technology tags: a flow's `protocol` becomes a tag, and a process with `isWebApplication` gets the
tag `web application`. Any other property that is `true` and has no place (`isPublicNetwork`, `isBidirectional`,
`isALog`, `isSigned`, `handlesCardPayment`, `handlesGoodsOrServices`, `storesInventory`, or one of the above on a cell
that does not map it), a non-empty `privilegeLevel`, `outOfScope` and a non-empty `description` are listed.

## Threats

| Threat Dragon | Scrylux |
|---|---|
| `type` | the STRIDE category, matched ignoring case (`Information disclosure` is Information Disclosure) |
| `title`, `description` | the title and description (shortened to 200 and 10,000 characters, and listed if so) |
| `severity` | the **impact**: `High`, `Medium` or `Low`; the **likelihood** is Medium |
| `status` | `Open` → open, `Mitigated` → mitigated, `Accepted` → accepted, `NA` (also `N/A` and `NotApplicable`) → not applicable |
| `mitigation` | one mitigation, when it is not empty: implemented for a Mitigated threat, proposed otherwise |
| `score` | not imported, and listed |

- A severity that is not High, Medium or Low (`TBA`, for example) becomes Medium impact, and is listed.
- A status Scrylux has no equivalent for (`Transferred`, `Avoided`, `Eliminated`, or any other) becomes **open**, and is
  listed with the original status.
- Every threat is imported as **manual**. A Mitigated threat with no mitigation, or an Accepted one, arrives with no
  reason, and keeps its status: it is shown as *missing what its status needs*, as for any imported decision.
- The threats of a diagram whose type is not STRIDE (a CIA or LINDDUN diagram, for example) are **not imported** and
  are listed one by one. The diagram's elements are.

Threat Dragon's threat statuses are these words, compared ignoring case and everything that is not a letter: `open`,
`mitigated`, `accepted`, `na`, `notapplicable`; and these have no Scrylux equivalent: `transferred`, `avoided`,
`eliminated`. Its severities are `high`, `medium`, `low` and `tba`.

## What an import does not carry over

Everything in the file that says something about the system and has no place in a Scrylux threat model is listed in the
summary, with where it was and why. Besides the cells and properties above, these are listed: the file's `description`
and `owner`, its `contributors`, a diagram's `description`, and the `description` of a cell. Their names, as the summary
gives them, are `description`, `owner`, `contributors`, `privilegeLevel`, `outOfScope`, `shape` and `score`.

These are ignored **without** a note, because they are presentation data or the file's own identifiers: `attrs`,
`zIndex`, `vertices`, `connector`, `visible`, `size of a node`, `thumbnail`, `placeholder`, `hasOpenThreats`, `number`,
`threatId`, `modelType`, `version` and `id`.

Every one of Threat Dragon's own demo models imports; the CIA and LINDDUN demos import their diagrams and list their
threats.
