# Contract: the Scrylux file, the import and the reports

## The Scrylux file, version 2

`format_version` is `2`. Everything of version 1 is unchanged, and two keys are added, always present, so a diff shows every change on its
own line:

```text
assets:      [ { id, name, description, holder_ids: [<element id of this file>] } ]   sorted by name, by code point, then id
assumptions: [ { id, statement } ]                                                    sorted by statement, by code point, then id
```

An `id` in a file is opaque, as for every record: any string of 1 to 100 characters, unique across the file's records of that kind.
`holder_ids` are sorted by the element's position in the file's `elements`. The strict schema allows no other key, so **no provenance,
rationale, citation, draft or decision is in a file** (FR-023).

A file's version message names the versions this install reads: `must be 1 or 2; this file is version N` (the shared
`formatVersionMessage` takes the list of versions to name; the OTM mark's own message stays `must be 1`). The import parses a file by
its `format_version`: version 1 by its own strict schema and planned with empty lists, version 2 by the schema above; any other
version is refused with that message. The OTM export's own `attributes.scrylux.format_version` mark stays `1`: the OTM export does not change.
`docs/formats/scrylux-file.md` gains the section and `docs/formats/scrylux-file-v2.schema.json` is generated beside version 1's.

## Everything else that reads the version

The committed Scrylux files (`docs/threat-model/threat-model.scrylux.json` and `docs/demo/notes-app.scrylux.json`) are checked by
the dogfood and demo checks, which import a file, export it again, compare the two and validate the file against the published
schema. Both files therefore move to version 2 in this change, and both checks read the version 2 schema. The release smoke run
only imports the demo file, which a version 1 or a version 2 file satisfies, so it needs no change. The export operation's OpenAPI
description names the version 2 schema file as the current one.

## The import

- The plan gains `assets` and `assumptions`. `checkPlan` applies the rules across records before anything is written: a holder is an
  element of the file and a node; names (and statements) are unique after trimming and ignoring case; at most 200 of each; the same
  fixed messages with a place in the file, never a value from it.
- `runImport` inserts them after the elements, in the same transaction, with new ids, and **without provenance**, however the file
  describes them.
- The import summary's per-model counts gain `assets` and `assumptions`, so the preview and the dogfood check count them as they count
  elements.
- OTM and Threat Dragon plans carry empty lists. Their documentation says that assets and assumptions are not carried.

## The reports

The Markdown and the HTML report gain two sections after **Elements**, when there is something to list:

- **Assets**: each asset's name (a heading), its description (a quote), and "Held by" with each holder's reference and name as the
  Elements section writes them.
- **Assumptions**: each statement as a list item.

Every text goes through the report's existing escapers (`escape.ts`, `htmlText`), so a name or a description can never become a
heading, a list, a link, markup or a script (Phase 2 Milestone 5). **The contents line is unchanged**: it counts elements, threats and
mitigations, so a report of a threat model with no asset and no assumption is byte for byte what it was before, and no existing
report test or committed report changes except where a model has such records. The diagram (Mermaid, SVG) is unchanged. A report
holds no provenance.

## The OTM export and the Threat Dragon import

Unchanged. `docs/formats/otm.md` says that assets and assumptions are not exported.
