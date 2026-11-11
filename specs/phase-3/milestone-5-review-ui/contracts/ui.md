# Contract: the web app

## The Draft tab (`/threat-models/:id/draft`), reviewing

Everything of Milestone 4's tab stays: the notice, the start control, the progress, the banner "Draft proposed by AI. It is not part of
this threat model.", what was read, the diagram, the list, the selection panel, "Discard draft". The review is added to the draft:

1. **Every item shows its state** in the list and the diagram: undecided, accepted (with who and when), rejected (dimmed). An accepted
   element's node is drawn as in the draft, with an "in the model" mark; it is not the threat model's own diagram.
2. **Every undecided or rejected item shows its comparison**: "New", "Already in the model" with a list of differences (flags, boundary,
   endpoints, holders), or "Several in the model; treated as new". It links to the matching record.
3. **An undecided element shows what it needs**: "Needs <name> in the model first", naming the draft items, with its Accept disabled and
   the reason in text. Selecting the needed items too enables it.
4. **The selection** may hold several items (click, shift-click, space on a focused row). The toolbar over the list acts on the
   selection: **Accept**, **Reject**, **Return to undecided** (each enabled only where it applies), and a count. Everything works by
   keyboard.
5. **"Accept…" on one item** opens `AcceptEditor`: the item's values, editable as FR-013 allows (name; one yes/no/not-assessed control
   per flag that the type allows, with each proposed value marked; boundary and endpoints from a list of the draft's items being accepted
   and the model's elements; an asset's description and holders; an assumption's statement). Rationale, citations and kind are shown
   and cannot be edited. Its **Accept** sends the edits; **Cancel** sends nothing.
6. **After an accept**, a status line says how many records were created and changed, and names holders left unlinked ("Held by
   <name> was not linked: it is not in the threat model"). It is not kept: it is what the answer said.
7. **A refusal** is shown as its message and the draft is read again: an out-of-date draft, an already decided item, a missing
   dependency, a limit.
8. **The replacement warning** (M4 FR-052) says, when any decision has been made, "A new extraction replaces this draft and the
   decisions on it. Records you accepted stay in the threat model."
9. **Sources changed** and "Source deleted" warnings (M4) are shown beside the items they concern and never disable a decision.

Every text, including the editor's fields when shown back, is rendered as text.

## The Assets tab (`/threat-models/:id/assets`, "Assets and assumptions")

After Diagram in the tab order.

- **Assets**: a list of name, description and holders (each holder's name linking to the diagram with that element selected), the
  provenance notice where there is one, **Add asset**, and **Edit** and **Delete** (with the confirmation dialog the app uses) on every
  row. The form: name, description, holders (a multiple choice of the threat model's processes, data stores and external entities).
- **Assumptions**: the same, with one text field.
- Empty states say what the section is and that an accepted draft item or **Add** fills it.
- A name that repeats and a full section answer with the API's message beside the field.

## The provenance notice (`ProvenanceNotice`)

Shown on the Assets tab and in the diagram's properties panel for the selected element: "Proposed by AI, accepted by <name> on <date>",
the rationale, and the citations (source name, location, the quoted passage, "Open in source", or "Source deleted"). On an element,
each flag that an accept set shows a small mark and the same detail on focus or expansion, and the element itself is not marked as AI's
if only flags were filled in. A hand-drawn record shows nothing.

## Elsewhere

- **The diagram** refetches its elements when a decision invalidates them, and replays unsaved changes on top as it always does.
- **The export menu** needs no change; the files carry the new records ([file-format.md](./file-format.md)).
- **Import preview** shows the two new counts.
