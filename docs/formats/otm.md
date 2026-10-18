# Open Threat Model (OTM)

[Open Threat Model](https://github.com/iriusrisk/OpenThreatModel) is an open format for threat models that several tools
read and write. Scrylux **exports** a threat model as OTM and **imports** OTM files, so a threat model is not locked
into Scrylux. Scrylux writes and reads **OTM 0.2.0 in JSON**. OTM 0.1.0 and YAML files are not read; a YAML file can be
converted to JSON first by any common tool.

- **Export**: **Download OTM file** on a threat model's page, or
  `GET /api/v1/threat-models/{id}/export?format=otm`.
- **Import**: **Import threat model** on a project's page, or `POST /api/v1/projects/{id}/imports` with
  `{ "format": "otm", "file": … }` (and `…/imports/check` to preview). See [API.md](../../API.md).

A file's own identifiers are replaced on import, so the same file can be imported twice.

## Exporting

An OTM file Scrylux writes describes the model in OTM's own terms, so other tools can read it, and carries everything
Scrylux has that OTM has no field for in `attributes.scrylux` of each object, so Scrylux can read its own file back
without losing anything.

| Scrylux | OTM |
|---|---|
| threat model | `project`: `name`, `id` (the model's id), `description: null`, and `attributes.scrylux` (the **Scrylux mark**: `format_version`, `exported_at`, `status`, `methodology`) |
| (none) | `representations`: one `diagram` |
| trust boundary | `trustZones[]`: `type: "trust-boundary"`, `risk.trustRating`, `parent.trustZone` when nested, a representation when placed |
| a node outside every boundary | a `trustZones[]` entry `scrylux-outside`, "Outside any trust boundary", written only when needed, as OTM requires every component to be in a zone |
| external entity, process, data store | `components[]`: `type` `external-entity`, `process` or `data-store`, `parent.trustZone`, `tags` (technology tags), a representation when placed, and its threats |
| data flow | `dataflows[]`: `source`, `destination`, `bidirectional: false`, `tags`, and its threats |
| threat | `threats[]`: `name` (the title), `description`, `categories` (the STRIDE category), `risk.likelihood` and `risk.impact` |
| threat on an element | a reference on that element: `{ threat, state, mitigations: [{ mitigation, state }] }` |
| mitigation | `mitigations[]`: `name` (the first line of its description, at most 200 characters), `description`, `riskReduction` |

A threat on a trust boundary, and a threat on no element, have no reference: OTM trust zones cannot carry threats. Their
element is in `attributes.scrylux.element_id`.

### Values OTM requires and Scrylux does not have

OTM requires a few values Scrylux has no notion of. Each is a constant, so the file is valid, and none claims anything:

| Constant | Value | Meaning |
|---|---|---|
| `trustRating` of every zone | `50` | Scrylux does not rate trust; 50 is the middle of OTM's scale |
| `riskReduction` of every mitigation | `0` | Scrylux does not rate mitigations; 0 claims no reduction |
| `risk` of a threat | Low `25`, Medium `50`, High `75` | Scrylux's three levels as OTM's 0 to 100 |
| `bidirectional` of every flow | `false` | a Scrylux flow has one direction |
| the outside zone | `scrylux-outside` | see above |

### States

| Scrylux threat status | OTM state | Scrylux mitigation status | OTM state |
|---|---|---|---|
| `open` | `exposed` | `proposed` | `required` |
| `mitigated` | `mitigated` | `implemented` | `implemented` |
| `accepted` | `accepted` | `verified` | `implemented` |
| `not_applicable` | `not-applicable` | | |

The OTM state is for other tools. When Scrylux reads its own file back it uses the exact status in `attributes.scrylux`.

### Order and bytes

Records are written in the same fixed order as the [Scrylux file](./scrylux-file.md), and the file is UTF-8 JSON with
two-space indentation and one final newline. Two exports of an unchanged threat model differ only in
`project.attributes.scrylux.exported_at`.

## Importing a file Scrylux wrote

A file is Scrylux's when `project.attributes.scrylux.format_version` is present. It is then read **strictly**, as a
Scrylux file would be: every field comes from `attributes.scrylux`, every rule of the Scrylux file applies, and a broken
rule refuses the whole import. Each trust zone, component, data flow, threat and mitigation must carry its
`attributes.scrylux`, or the import is refused with a message saying the file was changed outside Scrylux. Nothing is
carried over incompletely, so the summary lists nothing.

To import an OTM file that was edited by hand in ways that break this, remove `project.attributes.scrylux`: it is then
imported as another tool's file, with notes.

## Importing another tool's file

| OTM | Scrylux |
|---|---|
| `project.name` | the name of the new threat model (status `draft`) |
| `trustZones[]` | trust boundaries, nested by `parent.trustZone` |
| `components[]` | external entities, processes or data stores, by the table below |
| `dataflows[]` between two components | data flows |
| a threat reference on a component or flow | one threat on that element, with the state given there |
| a threat nothing refers to | a threat of the model, open |
| the mitigations a reference lists | mitigations of that threat, with the state given there |
| `risk.likelihood`, `risk.impact` (0 to 100) | Low (under 34), Medium (34 to 66), High (67 and over) |

A threat is always imported as **manual**: its rule, stale mark and origin are never read from another tool's file. The
first of its `categories` that is a STRIDE category is used, whatever its capitalisation and punctuation (`information
disclosure`, `Information_Disclosure`); a threat with none is left out and listed. A threat with **more than one**
category keeps the first STRIDE one, and the other categories are listed (`categories`), because a Scrylux threat has one. A component, zone or flow with no
name is named `Unnamed …`; names over 200 characters are shortened; tags are trimmed, de-duplicated ignoring case, cut
to 50 characters and capped at 20.

### Component types

A component's `type` is matched ignoring case. The first row that matches wins:

1. **An exact spelling**: `external-entity`, `external_entity`, `externalentity` → external entity; `process` →
   process; `data-store`, `data_store`, `datastore` → data store.
2. **A keyword in the type** → external entity: `external`, `client`, `user`, `actor`, `browser`, `third-party`,
   `thirdparty`, `partner`.
3. **A keyword in the type** → data store: `database`, `db`, `store`, `storage`, `bucket`, `queue`, `cache`, `table`,
   `file`.
4. **Anything else** → process, and the summary says so.

A component inside another component goes to the nearest trust zone above it, and the summary says so.

### States

States are compared with everything that is not a letter ignored, so `Not-Applicable`, `not applicable` and `N/A` meet
their words. A state in none of these gives the default, and the summary says so.

| Threat status | OTM states |
|---|---|
| `open` | `exposed`, `expose`, `open`, `new` |
| `mitigated` | `mitigated`, `mitigate` |
| `accepted` | `accepted`, `accept` |
| `not_applicable` | `notapplicable`, `na`, `hidden` |

| Mitigation status | OTM states |
|---|---|
| `implemented` | `implemented` |
| `verified` | `verified` |
| `proposed` | `required`, `recommended`, `proposed`, `planned` |

### Positions

Positions are read from the first `diagram` representation, **relative to the parent trust zone**, as Scrylux writes
them. OTM does not define this, so a file from another tool may draw differently. A position Scrylux cannot hold
(beyond ±100,000) is left for the canvas to place; a trust zone smaller than 40 is enlarged to 40; each is listed.

### Mitigation text

A mitigation's text is its `description` when that starts with its `name`; otherwise the `name`, a blank line, then the
`description`; and the `name` alone when there is no description.

## What an import does not carry over

Everything in the file that says something about the system and has no place in a Scrylux threat model is listed in the
summary, with where it was and why, and nothing is dropped without it (FR-016). These are listed:

- **Assets**, and every representation after the first `diagram`.
- **Fields**: a project's `description`, `owner`, `ownerContact`, `tags` and `attributes`; the `description` and
  `attributes` of zones, components, flows, threats and mitigations; a zone's `trustRating` other than 50; a flow's
  `bidirectional`; a threat's `cwes`, `tags`, `likelihoodComment` and `impactComment`; a mitigation's `riskReduction`
  other than 0; and a mitigation that no threat refers to. Their names, as the summary gives them, are
  `description`, `owner`, `ownerContact`, `tags`, `attributes`, `trustRating`, `bidirectional`, `cwes`,
  `likelihoodComment`, `impactComment`, `riskReduction`, `unreferencedMitigation` and `categories`.
- **Flows** not between two components, and the threats on them (which become threats of the model).

These are ignored **without** a note, because they are presentation data or the file's own identifiers:
`id`, `representation id`, `representation name`, `representation size of a component` and `trust zone type`.
