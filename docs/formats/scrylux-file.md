# The Scrylux file

The Scrylux file is Scrylux's own format for one threat model. It is **lossless**: exporting a threat model and
importing the file again gives the same diagram, the same threats in the same states and the same mitigations. Use it
to back a threat model up, move it to another Scrylux install, commit it next to the code it describes, or ship it as a
demo.

- **Export** it from a threat model's page (**Download Scrylux file**), or with
  `GET /api/v1/threat-models/{id}/export?format=scrylux`.
- **Import** it from a project's page (**Import threat model**), or with
  `POST /api/v1/projects/{id}/imports` (and `…/imports/check` to preview). See [API.md](../../API.md).
- **Schema**: [`scrylux-file-v1.schema.json`](./scrylux-file-v1.schema.json), JSON Schema 2020-12. It is generated from
  the same rules the import checks, and a test fails if the committed copy is out of date. Regenerate it with
  `pnpm --filter @scrylux/api formats`.

## Example (abridged)

```json
{
  "format": "scrylux",
  "format_version": 1,
  "exported_at": "2026-10-10T09:30:00.000Z",
  "project": { "name": "Payments" },
  "threat_model": { "name": "Checkout", "methodology": "STRIDE", "status": "in_review" },
  "elements": [
    {
      "id": "0b9c…",
      "type": "trust_boundary",
      "name": "VPC",
      "properties": {},
      "layout": { "x": 40, "y": 40, "width": 600, "height": 400 },
      "parent_boundary_id": null,
      "source_element_id": null,
      "target_element_id": null
    }
  ],
  "threats": [
    {
      "id": "5e1d…",
      "element_id": "0b9c…",
      "category": "Tampering",
      "title": "…",
      "description": "…",
      "likelihood": "Medium",
      "impact": "High",
      "status": "accepted",
      "status_reason": "…",
      "origin": "rule",
      "library_ref": "…",
      "stale": null
    }
  ],
  "mitigations": [
    { "id": "77aa…", "threat_id": "5e1d…", "description": "…", "status": "implemented", "external_ref": "https://…" }
  ]
}
```

## What the file holds

| Part | Fields |
|---|---|
| Header | `format` (`"scrylux"`), `format_version` (`1`), `exported_at`, and `project.name` (for information) |
| `threat_model` | `name`, `methodology`, `status` (`draft`, `in_review` or `approved`) |
| `elements[]` | `id`, `type`, `name`, `properties` (`tags`, `flags`), `layout`, `parent_boundary_id`, and for a data flow `source_element_id` and `target_element_id` |
| `threats[]` | `id`, `element_id` (or `null` for a threat on no element), `category`, `title`, `description`, `likelihood`, `impact`, `status`, `status_reason`, `origin`, `library_ref`, `stale` |
| `mitigations[]` | `id`, `threat_id`, `description`, `status`, `external_ref` (a ticket link, or `null`) |

- **Every key is always present**, `null` where empty, so a diff shows every change on its own line. The one exception:
  `properties` holds `tags` only when there is at least one, and `flags` only for the flags that were assessed. A flag
  that is absent means *not assessed*; `false` means *no*.
- **Positions**: a node has `{ x, y }`, a trust boundary `{ x, y, width, height }`, and an element that was never placed,
  and every data flow, has `null`. `x` and `y` are relative to the parent boundary, or to the diagram origin when there
  is none.
- **Ids** are opaque: any string of 1 to 100 characters, unique across the file. An import gives every record a new id,
  so the same file can be imported more than once, and into any install.
- **Order**: records are written in a fixed order that depends only on what they are (boundaries, external entities,
  processes, data stores, data flows, each by name; threats by element, STRIDE category and title; mitigations by
  threat and description), never on when they were stored. Two exports of an unchanged threat model differ only in
  `exported_at`.
- **Format**: UTF-8 JSON with two-space indentation, `\n` line endings and one final newline.

## What is not in the file

- **Risk** is derived from likelihood and impact on import.
- **Timestamps** (`created_at`, `updated_at`): the file changes only when the threat model does, and an import does not
  pretend to restore when a record was made.
- **Accounts**: no account name, account id or credential. An import belongs to the account that makes it.
- **Ids of the threat model and the project.**

## What an import checks

An import applies the same rules as creating the same records in the app, and refuses a file that breaks one, naming the
rule and its place (`file.threats.12.status_reason: …`). Nothing is created in that case. The schema states each field's
type and limits; these rules need more than a schema can say:

- the flags allowed depend on the element type;
- every reference (a boundary, the two ends of a flow, a threat's element, a mitigation's threat) points to a record of
  the same file, and no id appears twice;
- flows connect external entities, processes and data stores, have no parent boundary, and do not start and end at the
  same element; trust boundaries nest without a cycle;
- a threat model holds at most 1,000 elements;
- `status_reason` only on an `accepted` or `not_applicable` threat; `stale` only on a `rule` threat;
- a `rule` threat has an element and a `library_ref`, and no two `rule` threats share an element and a rule;
- ticket links are `http` or `https` addresses.

Two rules are *not* applied to an import, because a file restores a decision as it was made:

- a threat may arrive `mitigated` with no implemented or verified mitigation, or `accepted` or `not_applicable` with
  no reason. It keeps its status and is shown as *missing what its status needs*, as Milestone 4 describes.
- `origin` may be `rule`: a generated threat stays generated, with its `library_ref` and `stale` mark, so
  **Generate threats** recognises it afterwards and creates no duplicate. (A file can claim `rule` for any threat;
  Scrylux cannot check it.)

A file with a threat whose `origin` is `ai` is **refused**: AI-drafted threats cannot be imported yet.

An element saved before today's rules (for example with a flag that no longer exists) is exported as it is stored, and
importing that file is refused with a message naming the element, so you can correct it in Scrylux and export again.

## Size

An import accepts a file of up to **64 MiB**, nested at most **64 levels** deep and holding at most **2,000,000**
values. That holds the largest threat model Scrylux allows (1,000 elements, about 15,000 threats and about 49,000
mitigations). A model whose every text field is at its maximum length can be larger than that and cannot be imported
in one file.

Exporting or importing a model of that size takes about 500 to 650 MB of the server's memory while it runs, on top of
what the app uses at rest, so a host that will hold models like it needs at least **2 GiB** (see
[Deployment in the README](../../README.md#deployment)). A smaller host is fine for ordinary threat models.

## Versioning

Any change to this format raises `format_version` and publishes the new schema next to this one. An import reads every
version listed here and refuses any other, naming both versions (`file.format_version: must be 1; this file is version 2`; the list grows with the versions).

| Version | Schema |
|---|---|
| 1 | [`scrylux-file-v1.schema.json`](./scrylux-file-v1.schema.json) |
