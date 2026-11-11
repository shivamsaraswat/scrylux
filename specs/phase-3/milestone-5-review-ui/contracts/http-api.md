# Contract: the HTTP API

Ten new operations under `/api/v1`, and one change to an existing answer. Each is defined with `defineOperation`, so the router and the
OpenAPI document agree. All need sign-in and answer errors as `{ error }` with fixed text that holds no name, statement or text of a
draft. The operation count in `auth.test.ts` and `validation.test.ts` goes from 49 to 59, and `openapi.json` is regenerated.

## `GET /threat-models/{id}/draft` (changed)

`DraftRecord` gains `review`: a map from draft item id to `ItemReview` ([data-model.md](../data-model.md)), for every element, asset and
assumption. Nothing else about the answer changes. `404` when the threat model or its draft does not exist, as before.

## `POST /threat-models/{id}/draft/decisions`

Decides one or more items of the threat model's draft. Answers `200` with `DecisionResult`. Logs one line (account, action, threat
model, counts). Body limit: the default.

```text
{ "draft_id": "<uuid>", "action": "accept",
  "items": [ { "id": "<item id>", "seen": "new" | "matched" | "several", "edits": { … } } ] }
{ "draft_id": "<uuid>", "action": "reject" | "undecide", "items": [ { "id": "<item id>" } ] }
```

**`edits`** (accept only, every field optional, strict): `name`; `flags` (`{ "<flag>": true | false | null }`, null clears); `boundary`
(a reference or `null`); `source`, `target` (a reference); `description` (an asset); `statement` (an assumption); `holders` (an array of
references). A **reference** is `{ "item": "<draft item id>" }` or `{ "element": "<element id>" }`. A field the item's kind does not
take (a `statement` on an element, a `source` on a process) is a `400`.

**What an accept does** (FR-007 to FR-013):

- A new element, asset or assumption is created from the stored item with the edits applied. An element has no stored position.
- A matched element has only its unassessed flags set; a matched asset gains only the holders it lacked; a matched assumption changes
  nothing. In each case the item is accepted with outcome `matched`.
- Provenance rows are written for what the accept created or set (research #8).
- Everything is one transaction under the threat model's lock; any refusal leaves nothing.

**Errors**

| Status | Cause | Message (fixed) |
|---|---|---|
| 400 | A body that fails the schema, an edit that does not apply to the kind, an edit that breaks a rule of the record (a flag that does not apply, a boundary cycle, a flow to itself, a flow endpoint that is not a node, a name over 200 characters, a reference to an element of another threat model) | the schema's, or the existing element and record rule messages |
| 404 | The threat model does not exist, or an item id is not an item of its draft | `Threat model not found`, `Draft item not found` |
| 409 | The threat model has no draft, or its id is not `draft_id` | `This draft was replaced or discarded` |
| 409 | An item is already accepted (accept, reject) or is not rejected (undecide) | `N of the items were already decided` |
| 409 | An item's `seen` differs from the comparison now | `N of the items are out of date; the threat model changed` |
| 409 | An element needs a boundary or an endpoint that is neither in the model nor in the request | `N items need elements that are not in the threat model` |
| 409 | The request would pass the limit on elements, assets or assumptions | `A threat model can hold 1,000 elements; 3 more fit` |
| 409 | An asset or an assumption would repeat one that exists | `An asset with this name already exists`, `This assumption already exists` |

The numbers are counts of the request and of the database; no name, statement or quote appears in any message.

**`DecisionResult`**: `{ draft: DraftRecord, created: n, changed: n, unlinked_holders: [{ asset_item_id, element_item_id }] }`.
`created` counts new records, `changed` counts matched records that were filled in.

## `GET /threat-models/{id}/provenance`

Every `ProvenanceRecord` of the threat model, oldest first, ties by id: its rows for elements, assets, assumptions and flags, each with
its citations as the draft's `CitationRecord` (source name, location, quote read from the chunk by its span, or `chunk: null` for a
deleted source). `404` for an unknown threat model. An empty list when nothing was accepted. Never includes a hand-made record.

## Assets: `/threat-models/{id}/assets` and `/assets/{id}`

| Operation | Path | Body | Answer |
|---|---|---|---|
| `listAssets` | `GET /threat-models/{id}/assets` | | `200` `AssetRecord[]`, oldest first |
| `createAsset` | `POST /threat-models/{id}/assets` | `AssetInput` | `201` `AssetRecord` |
| `updateAsset` | `PATCH /assets/{id}` | `AssetUpdate` | `200` `AssetRecord` |
| `deleteAsset` | `DELETE /assets/{id}` | | `204` |

A holder in `holder_ids` must be a process, a data store or an external entity of the same threat model, else `400`. A name that repeats
another asset's (ignoring case and surrounding whitespace) is `409`. The 201st asset is `400` ("A threat model can hold at most 200
assets"). A client cannot send provenance: the schemas are strict. Create, update and delete write the router's one-line write log
(`type: asset`).

## Assumptions: `/threat-models/{id}/assumptions` and `/assumptions/{id}`

The same four operations (`listAssumptions`, `createAssumption`, `updateAssumption`, `deleteAssumption`) with `AssumptionInput` and
`AssumptionUpdate` (`statement`). A repeated statement is `409`; the 201st is `400`.

## What does not change

- `POST /jobs` and the extraction routes, `DELETE /threat-models/{id}/draft`.
- Every element, threat and mitigation operation and its record. One internal change: an element update that changes or removes a flag
  also deletes that flag's provenance row, in the same transaction (research #8).
- The export routes' paths; their files change ([file-format.md](./file-format.md)).
