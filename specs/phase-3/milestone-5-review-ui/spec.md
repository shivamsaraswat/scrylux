# Feature Specification: Review UI

**Feature Branch**: not yet created (spec directory `phase-3/milestone-5-review-ui`; work is on `feat/phase-3`)

**Created**: 2026-11-10

**Status**: Draft

**Input**: User description: "start on milestone 5 of phase 3". This covers Phase 3 / Milestone 5 of `plan.md`, the review UI:
"A diff-style view of the draft against the current model: accept, edit or reject each element. Nothing enters the threat
model until accepted."

Milestone 4 proposes a system from a threat model's documents and keeps it as a **draft**, read-only and apart from the
threat model. (Here "draft" always means that extraction output. It has nothing to do with the `draft` status a threat
model can have.) This milestone adds the human step Principle VI requires. A signed-in person compares each proposed item
with the threat model as it stands, then accepts it, accepts it with changes, or rejects it. Only an accepted item becomes
part of the threat model, and it keeps its rationale and citations so that a reviewer can still see why it is there.

The items are the diagram's **elements** (processes, data stores, external entities, data flows, trust boundaries) and,
as clarified below, the draft's **assets** and **assumptions**, which become new kinds of threat-model record in this
milestone. This milestone does not propose threats (Milestone 6), change a prompt or the extraction (Milestone 7 measures
them), or add roles (Phase 6).

## Clarifications

### Session 2026-11-10

- Q: Can the draft's assets and assumptions be accepted? Milestone 4 left it to this milestone. → A: Yes. They become new
  kinds of threat-model record, so this milestone also gives them a place to be read, created, edited and deleted, and carries them
  into the Scrylux file and the reports (FR-006, FR-020 to FR-022). The Scrylux file's version changes with it (FR-023).
- Q: What does accepting an element that is already in the model do? → A: It fills in only the flags the existing element has
  not assessed and changes nothing else. The same spirit applies to an asset (it adds the holders the asset lacks) and to
  an assumption (nothing to add) (FR-008).
- Q: What provenance does an accepted item carry? → A: A mark on it and a stored copy of its rationale and citations, kept as
  spans of chunks as in Milestone 4, so that it survives the draft and a deleted source still reads "source deleted" and
  leaves none of its text. Exports carry no provenance (FR-017, FR-023).
- Q: Should a person be able to create an asset or an assumption by hand, or only get them by accepting a draft item? → A:
  Also by hand. Assets and assumptions are ordinary records with two origins (drawn by a person, or accepted from a draft),
  and only the second carries provenance (FR-017, FR-021).
- Q: When accepting a match fills in an existing element's unassessed flags, should Scrylux record that those values came
  from AI? → A: Yes. The element carries provenance for the flags that were filled in, each with its rationale and citations,
  and is not marked as AI-created as a whole (FR-017).

### Session 2026-11-10 (during planning)

- **A match counts as "in the model" for dependencies.** A flow whose endpoint matches exactly one existing element attaches to
  it, with no decision on that endpoint (FR-009; research #5).
- **A request that includes an item already decided is refused as a whole**, so a double click gets a `409` and creates nothing
  (FR-010, FR-011; research #4). The page sends the comparison it showed with each item, and a different comparison now refuses
  the request as out of date (FR-011).
- **"Same name" is decided in the database**, with the expression of the unique indexes, so the comparison and the uniqueness of
  FR-021 can never disagree (FR-002; research #3).
- **A flag has no rationale of its own** (Milestone 4 gave a flag citations only), so a flag's provenance keeps its item's
  rationale with the flag's citations (FR-017; research #8).
- **The Scrylux file is version 2**, still reading version 1. The OTM export is unchanged and keeps its own mark. The import
  preview's counts gain assets and assumptions, and the committed `docs/threat-model/` file moves to version 2 in the same change
  (FR-023; research #10).
- **Assets and assumptions have their own tab**, and the limit is 200 of each, as constants (FR-019, FR-020; research #6, #12).
- **Which holders were left unlinked is said in the accept's answer** and shown by the page then; it is not stored (FR-009).

## User Scenarios & Testing *(mandatory)*

Three kinds of person rely on this milestone. A reviewer decides, item by item, what of the model's proposal belongs in
the threat model. A later reader of the threat model needs to tell what a person accepted from what a person drew.
Milestone 6 starts from the accepted elements. The stories are written from the reviewer's side.

### User Story 1 - See the draft against the current model (Priority: P1)

A reviewer opens the Draft tab of a threat model that has a draft. Each proposed item shows how it relates to the threat
model: new, already in the model, or ambiguous because several records share its name. For one that is already in the
model, the differences are listed. Each item also shows its review state (undecided, accepted or rejected) and what it
needs first: a flow needs its two endpoints, and a member needs its boundary if the draft puts it in one. M4's selection
panel (rationale, flags, citations) stays.

**Why this priority**: The reviewer decides by comparing. Without the comparison the draft is a list to retype by hand.

**Independent Test**: Seed a threat model with two elements that the draft also proposes (one with a differing flag), one
name that two existing elements share, and one asset the draft also proposes. Open the Draft tab and check that each item
shows the right relation, that differences and readiness are shown, and that nothing in the threat model changed.

**Acceptance Scenarios**:

1. **Given** a proposed item with no existing record of its kind and name, **When** the tab is shown, **Then** it says the
   item is new (FR-002).
2. **Given** a proposed item with exactly one existing record of its kind and name, **When** it is shown, **Then** it says
   it is already in the model and lists what differs: for an element, flags the draft proposes that the element lacks or has
   differently and a different boundary or endpoints; for an asset, holders it lacks (FR-002).
3. **Given** a proposed element whose type and name match several existing elements, **When** it is shown, **Then** it says
   so and treats it as not matched (FR-002). An asset or an assumption can match at most one record, because names and
   statements are unique (FR-021).
4. **Given** a flow whose endpoint is neither in the model nor accepted, **When** it is shown, **Then** it says what is
   missing and that it cannot be accepted yet (FR-003).
5. **Given** a draft whose sources changed, or an item with a citation to a deleted source, **When** it is shown, **Then**
   it keeps M4's warnings and the item can still be decided (FR-005).

---

### User Story 2 - Accept items into the threat model (Priority: P1)

A reviewer accepts one item or several. Scrylux creates the records from the draft it holds, in one step that either fully
succeeds or changes nothing, and the review marks them accepted. The threat model's diagram shows the accepted elements,
and its assets and assumptions section shows the rest. No threat or mitigation is created, and nothing the reviewer did
not accept enters the model.

**Why this priority**: It is the milestone, and the phase's Definition of Done ("accept a subset into the threat model
and export it").

**Independent Test**: With a draft of a dozen elements, a few assets and a few assumptions, accept a subset that has its
dependencies. Check that the model now holds exactly those records, valid, with elements unplaced on the canvas, that the
rest are untouched, that exporting the threat model includes them, and that nothing else changed.

**Acceptance Scenarios**:

1. **Given** a new element whose dependencies are in the model, **When** a reviewer accepts it, **Then** an element of its
   type, name, flags, boundary and endpoints exists, and the item shows as accepted by that account and when (FR-007,
   FR-008).
2. **Given** a flow and its two endpoints, all undecided, **When** a reviewer accepts the three together, **Then** all
   three are created, with the flow connected to the created endpoints (FR-009).
3. **Given** a flow whose endpoint is not in the model and not part of the request, **When** a reviewer accepts it,
   **Then** the request is refused, says what is missing without quoting the draft, and creates nothing (FR-009, FR-010).
4. **Given** an asset that names elements as holders, some of them in the model and some not, **When** a reviewer accepts
   it, **Then** it is created, linked to the holders that are in the model or in the request, and the review says which
   holders were left unlinked (FR-009).
5. **Given** any accept that fails, **When** the answer returns, **Then** the threat model holds none of its records
   (FR-010).
6. **Given** two reviewers who accept the same item at once, **When** both finish, **Then** one record exists (FR-011).
7. **Given** a draft that was discarded or replaced after the page loaded, **When** a reviewer accepts an item, **Then**
   it is refused as an out-of-date draft, creates nothing, and the page reloads (FR-011).
8. **Given** an accept that would take the model past a limit on elements, assets or assumptions, **When** it is
   requested, **Then** it is refused and the answer says how many more fit (FR-012).

---

### User Story 3 - Edit an item while accepting it (Priority: P1)

A reviewer finds the model's proposal nearly right: a name, a flag or a boundary is wrong. They change it in the same
step in which they accept it. The change follows the rules every record follows, and the draft keeps what the model
proposed so the reviewer can still compare.

**Why this priority**: plan.md names "edit" as one of the three decisions, and a draft that can only be taken whole or
refused would be refused too often.

**Independent Test**: Accept an element with a changed name, a cleared flag, a different boundary and, for a flow,
different endpoints, an asset with another description and an assumption with another statement. Check that the created
records have those values and the draft items do not. Try an edit that breaks a rule and check that it is refused with
nothing created.

**Acceptance Scenarios**:

1. **Given** an item and an edit of an editable field, **When** it is accepted, **Then** the created record has the edited
   values (FR-013).
2. **Given** an edit that breaks a rule (a flag that does not apply to the type, a boundary inside itself, a flow from an
   element to itself, a name over 200 characters, an endpoint that is not a process, data store or external entity),
   **When** it is requested, **Then** it is refused and nothing is created (FR-013).
3. **Given** an edit, **When** it is requested, **Then** it cannot change the item's kind, rationale or citations (FR-013).
4. **Given** an accepted item that was edited, **When** the draft item is shown, **Then** it still shows the model's
   original values (FR-013).

---

### User Story 4 - Reject items, and change one's mind (Priority: P1)

A reviewer rejects items that the documents do not support. A rejected item stays in the draft, dimmed, and a reviewer can
return it to undecided. Rejecting writes nothing to the threat model.

**Why this priority**: Rejecting is the other half of "accept, edit or reject", and it is how a reviewer works through a
draft to an end.

**Independent Test**: Reject some items and check that the model is unchanged, that they show as rejected, and that
returning one to undecided makes it acceptable again. Accept an item, delete its record, and check that the item is
undecided again.

**Acceptance Scenarios**:

1. **Given** an undecided item, **When** a reviewer rejects it, **Then** it shows as rejected, with who and when, and
   nothing in the threat model changes (FR-014, FR-015).
2. **Given** a rejected item, **When** a reviewer returns it to undecided, **Then** it can be accepted again (FR-014).
3. **Given** an accepted item whose created record is later deleted, **When** the Draft tab is shown, **Then** the item is
   undecided again (FR-014).
4. **Given** an undecided element that depends on a rejected one, **When** it is shown, **Then** it says what is missing,
   and the reviewer can edit it to depend on something else, or reject it (FR-003, FR-013).

---

### User Story 5 - Read, create, edit and delete assets and assumptions (Priority: P1)

Assets and assumptions are now records of the threat model. A person opens the threat model and finds them in their own
section, apart from the diagram: each asset with its description and the elements that hold it, each assumption with its
statement. A person can add one by hand, correct one or delete one, whether it was accepted from a draft or drawn by hand.
An asset's holders are shown by name and link to the element.

**Why this priority**: Accepting into a record that nobody can see, correct or remove would make acceptance a one-way door,
and a record that only AI can create would be an odd kind of record.

**Independent Test**: Accept an asset and an assumption, and create one of each by hand. Open the threat model and check
that all are listed with what they hold, and that only the accepted ones show provenance. Edit an asset's description and
holders and an assumption's statement, check the rules hold, and delete each. Delete a holder element and check that the
asset stays and loses that holder.

**Acceptance Scenarios**:

1. **Given** assets and assumptions, accepted or created by hand, **When** a person opens the threat model's section for
   them, **Then** it lists them, each asset with its holders (FR-019).
2. **Given** a person who creates an asset or an assumption, **When** it is saved, **Then** it follows the rules of FR-021
   and carries no provenance (FR-017, FR-021).
3. **Given** an asset or an assumption, **When** a person edits or deletes it, **Then** the change follows the rules of
   FR-021 and is logged without its text (FR-021, FR-022).
4. **Given** an asset whose holder element is deleted, **When** the section is shown, **Then** the asset remains and no
   longer lists that holder (FR-021).

---

### User Story 6 - Know later where an accepted item came from (Priority: P2)

Someone reading the threat model a month later can tell which elements, assets and assumptions a person drew and which
were proposed by AI and accepted, and can read why the model proposed one and what it cited. This holds after the draft
was discarded or replaced.

**Why this priority**: Principle VI requires provenance on AI-proposed content. Milestone 6 generates threats for accepted
elements, and Milestone 7 measures. It is P2 because US1 to US5 deliver a review; this makes it last.

**Independent Test**: Accept an element and an asset, discard the draft, and check that both still show that they came from
AI and still show their rationale and citations (those whose source still exists say so, and the others say "source
deleted").

**Acceptance Scenarios**:

1. **Given** an accepted item, **When** a person looks at it (an element in the diagram editor, an asset or assumption in
   its section), **Then** it shows that it came from AI, and its rationale and citations (FR-017).
2. **Given** a drawn element and an accepted one, **When** both are looked at, **Then** the two are told apart (FR-017).
3. **Given** an accepted item whose draft was discarded, **When** it is looked at, **Then** the provenance is still there
   (FR-017).
4. **Given** a hand-drawn element whose unassessed flags an accept filled in, **When** it is looked at, **Then** it is not
   marked as AI-created, and those flags, and only those, show where they came from and why (FR-017).

---

### User Story 7 - Scrylux's own threat model stays in step (Priority: P2)

A reviewer reading Scrylux's threat model finds that accepted draft content and the new records are current assets, the
decision and record operations are entry points, and the risks of letting AI-proposed text into the model, and how each is
handled, are described.

**Why this priority**: Principle V requires the same change to update the Threat Model section and `docs/threat-model/`.

**Independent Test**: Read the Threat Model section and the committed threat model after the change and check that each
item of FR-027 is there and that the threat model's checks pass on the pull request.

**Acceptance Scenarios**:

1. **Given** the change, **When** the Threat Model section is read, **Then** it lists the items of FR-027 (FR-027).
2. **Given** the change, **When** `docs/threat-model/` is checked on the pull request, **Then** it matches the section and
   its checks pass (FR-027).

---

### Edge Cases

- **Two accounts review one draft.** Decisions are the draft's, not an account's. Each decision names who made it. An item
  already decided when a second request reaches it is answered as already decided, and creates nothing (FR-011).
- **The draft is replaced or discarded while someone reviews.** Their next decision fails as an out-of-date draft, and the
  page reloads. Records already accepted stay in the threat model. Decisions go with the draft (FR-011, FR-016).
- **An existing record is deleted after the comparison was shown.** An item that said "already in the model" is compared
  again when the decision is made. If its match is gone, the request is refused as out of date and the page shows the item
  as new (FR-002, FR-011).
- **The same name twice in the model.** A draft item that matches more than one is treated as new, never matched at
  random. The reviewer may accept it as new (which adds another record with that name) or reject it (FR-002).
- **A flow to an element that exists only in the model.** A reviewer can edit a flow's endpoint to an existing element, so
  a flow can join a proposed element to one that is already drawn (FR-013).
- **A boundary that is rejected.** Its proposed members can still be accepted, with the boundary cleared or replaced by
  an edit, and are refused otherwise (FR-009, FR-013).
- **An asset whose holders are not accepted.** It is created without those links, and the review says which (FR-009).
- **The model is nearly full.** Acceptance is refused as a whole when it would pass a limit, so no half of a flow and its
  endpoints is created (FR-010, FR-012).
- **Sources changed, or a citation's source deleted.** Items can still be decided. The page says what M4 says (FR-005).
- **No generation provider, no embedding provider, no worker.** Reviewing a draft that exists needs none of them (FR-024).
- **Many accepts.** Accepting a whole draft (at most 40 elements, 15 assets and 15 assumptions) is one request and is
  bounded by the draft's size (FR-007, SC-005).
- **Exports, imports and reports.** Accepted elements, assets and assumptions are in the Scrylux file and the reports.
  Drafts, decisions and provenance are not (FR-023).
- **A deleted threat model or project.** Its draft and decisions go with it, as in M4. Its accepted records go with it, as
  every element does.

## Requirements *(mandatory)*

### Functional Requirements

**What the reviewer sees**

- **FR-001**: Every proposed item of a draft (an element, an asset or an assumption) MUST have one review state: undecided
  (the state on creation), accepted or rejected. A decided item MUST record the account that decided it and when. The
  states live with the draft, apart from the threat model.
- **FR-002**: The Draft tab MUST compare each proposed item with the threat model's current records of its kind when it is
  shown and when a decision is made, and show one of: *new* (no record of the same kind has the same name), *already in the
  model* (exactly one does) or *several in the model* (more than one does, treated as not matched and never chosen for the
  reviewer; only an element can match several, because assets and assumptions are unique, FR-021). An element's kind is its type. Names are compared ignoring case and surrounding whitespace, and an
  assumption is compared by its statement the same way. For one already in the model, it MUST list what differs: for an
  element, flags the draft proposes that the element has not assessed or has with another value, a different boundary and,
  for a flow, different endpoints; for an asset, holders it lacks. data-model.md ("What a difference is") defines each: a
  proposed flag differs when the element has not assessed it or has another value; a boundary or an endpoint differs when
  the draft names one and it is not in the model or is another element than the existing one's; a holder is lacking when
  the draft's holder is in the model and does not hold the asset. The comparison is derived each time, is not stored, and is
  given only for an item that is not accepted.
- **FR-003**: The Draft tab MUST show what each undecided element needs before it can be accepted: a data flow needs both
  endpoints, and a member of a proposed boundary needs that boundary or an edit that gives it another or none (FR-009).
  An unmet need MUST say what is missing and that acceptance is not offered yet.
- **FR-004**: The diagram and the list of M4 MUST show every item's review state, keep M4's marking as proposed by AI, and
  keep its selection panel (rationale, flags, citations). Every text of the draft stays text (M4 FR-066).
- **FR-005**: An item of a draft whose sources have changed, or one whose citations include a deleted source, MUST remain
  open to every decision, with the warnings of M4 (FR-053, FR-054) shown beside it.
- **FR-006**: Accepting an asset MUST create an asset of the threat model, and accepting an assumption MUST create an
  assumption of it. An asset has a name, a description and the elements that hold it. An assumption has a statement. Neither
  is a diagram element, and neither has a position.

**Deciding**

- **FR-007**: Any signed-in person MUST be able to accept one or more undecided proposed items of a threat model's draft in
  one request, up to the whole draft, and MUST be able to reject them and return a rejected one to undecided. The server
  MUST build each record from the draft it stores. A request carries item identifiers and the edits of FR-013 and nothing
  else, so no client can put content or provenance of its own into a record.
- **FR-008**: Accepting a *new* element MUST create an element of its type with the draft's name, flags, boundary and
  endpoints (edits applied), with no stored position, so that the diagram places it as it places any element that has
  none. Accepting an element *already in the model* MUST fill in only the flags the existing element has not assessed, and
  MUST change nothing else (never a flag already set, its name, its boundary or its endpoints). Accepting an asset
  *already in the model* MUST add only the holders it lacks. Accepting an assumption *already in the model* changes
  nothing, and the item is marked accepted. Accepting a *new* asset or assumption creates it with the draft's values
  (edits applied).
- **FR-009**: An element MUST be accepted only if everything it needs is in the threat model, or is created by the same
  request: a flow's endpoints (each an element of the model, a matched element or an item accepted together) and its
  boundary when it has one, unless an edit clears the boundary or points it at an element of the model. An asset is not
  held back by its holders: it MUST be linked to those that are in the model or in the request, and the review MUST say
  which were left unlinked. A refusal says what is missing as a count, never the draft's text.
- **FR-010**: One accept request MUST be all or nothing: if any record in it is refused, nothing is created or changed.
- **FR-011**: A decision MUST be made against the draft the reviewer saw. If that draft was discarded or replaced, the
  request MUST be refused as out of date and create nothing. An item already accepted MUST NOT create a second record when
  asked again, even by two requests at the same moment. A match that disappeared since the comparison was shown (FR-002)
  MUST be refused as out of date.
- **FR-012**: Accepting MUST respect the threat model's limits on elements (1,000, Phase 2 Milestone 1) and on assets and
  assumptions (FR-020), counting the records it would create, and when one would be passed MUST refuse the whole request
  and say how many more fit.
- **FR-013**: When accepting, a person MUST be able to change: an element's name, flags (set, change or clear), boundary
  (a proposed boundary being accepted with it, an element of the model, or none) and, for a flow, endpoints (the same
  choices); an asset's name, description and holders; an assumption's statement. The result MUST obey every rule the
  record obeys elsewhere: for an element, the diagram's rules (Phase 2 Milestone 1: the type allows the flag, a boundary is
  not nested in itself, a flow joins a process, data store or external entity and not one to itself, a name is 1 to 200
  characters); for an asset or assumption, FR-021's rules. An edit MUST NOT change an item's kind, rationale or
  citations. The draft item MUST keep the model's original values.
- **FR-014**: Rejecting MUST write nothing to the threat model. A rejected item MUST remain in the draft, marked, and MUST
  be returnable to undecided. An accepted item whose created record is later deleted MUST become undecided again. An
  accepted item cannot be undone from the review: its record is deleted where it lives (the diagram editor, or the
  assets and assumptions section). An item accepted as a match created nothing, so it stays accepted.
- **FR-015**: Nothing enters the threat model except through an accept. Reading, comparing, rejecting and returning to
  undecided MUST NOT create, change or delete any element, asset, assumption, threat or mitigation. An accept MUST create
  or change only what FR-008 names: no threat, no mitigation, no change to a threat model's status.
- **FR-016**: A new extraction replaces the draft and the decisions on it, and discarding the draft deletes them
  (M4 FR-052, FR-055). Records already accepted MUST stay. Where the Draft tab says a new extraction will replace the
  draft, it MUST also say, when any decision has been made, that decisions are lost and accepted records stay.

**Where an accepted item came from**

- **FR-017**: Every record created by an accept (a new element, asset or assumption) MUST carry a mark that it was proposed
  by AI and accepted, and a stored copy of the rationale and citations of its draft item, including the citations of each flag the item proposed, so that a person can read them
  after the draft is gone (Principle VI). A later edit MUST NOT remove the mark. Citations MUST be kept as spans of chunks, as in M4, so that a citation whose
  source was deleted says "source deleted" and no text of a source outlives it. A record a person creates or imports MUST
  carry none, and the mark MUST NOT be settable by a client. An element that an accept filled in as a match (FR-008) MUST
  NOT be marked as AI-created, but MUST carry provenance (a mark, and the rationale and citations of the flag's proposal,
  kept as above) for each flag the accept filled in, and a person who reads the element MUST be able to tell which of its
  flags those are. A later edit of such a flag by a person removes that flag's provenance, since the value is then theirs.
- **FR-018**: A decision MUST record the account that made it and when, and a created record MUST be traceable to the
  decision that created it.

**Assets and assumptions as records**

- **FR-019**: The threat model's page MUST have a section for assets and assumptions, apart from the diagram. It MUST list
  every asset with its description and holders (each holder by name, linked to its element) and every assumption with its
  statement, show the provenance of FR-017 on each that has it, and show every text as text.
- **FR-020**: A threat model MUST hold at most a documented number of assets and of assumptions, large enough that a
  whole draft always fits an empty threat model.
- **FR-021**: A signed-in person MUST be able to create an asset or an assumption by hand, edit an asset's name,
  description and holders and an assumption's statement, and delete either, whatever its origin. An asset's name MUST be 1
  to 200 characters and unique within the threat model ignoring case and surrounding whitespace, and so MUST an
  assumption's statement, so that a draft item matches at most one of them (FR-002). A description and a statement MUST be
  non-empty and of a documented maximum length. A holder MUST be an element of the same threat model that is not a data
  flow or trust boundary. A record created by hand MUST carry no provenance, and an edit MUST NOT add, change or remove
  provenance. Deleting a holder element MUST leave the asset in place and remove that holder. Deleting a threat model
  deletes its assets and assumptions.
- **FR-022**: Each accept, reject and return to undecided, and each create, edit and delete of an asset or an assumption, MUST log
  one line: account, action, threat model and counts or the record's id. No log line, error answer or record outside the
  draft and the provenance MUST hold the text of a draft item (M4 FR-065).
- **FR-023**: The Scrylux file and the reports (Phase 2 Milestones 5 and 6) MUST include a threat model's assets and
  assumptions, as they include its elements, and the Scrylux file's format version MUST change with it (Scrylux keeps
  reading version 1 files, which have none). Report text MUST be escaped as every other report text is. Elements, assets and
  assumptions MUST be created from a file as ordinary records, with no provenance, however the file describes them. The OTM
  export and the Threat Dragon import MUST stay as they are, and their documentation MUST say that assets and assumptions
  are not carried (an OTM import already notes the assets it does not read). No file or report MUST include a draft, a decision, a rationale, a citation or a provenance mark.

**API, UI and the rest**

- **FR-024**: The decisions, and the reading, creating, editing and deleting of assets and assumptions, MUST be operations under
  `/api/v1` that need sign-in, check their input at the boundary, answer errors in the API's usual form, and appear in the
  generated OpenAPI document. Reading a draft MUST include each item's state, who decided and when. Reviewing an existing
  draft MUST work with no generation provider, no embedding provider and no worker.
- **FR-025**: The UI MUST show the review on the Draft tab, so that a reviewer can accept, edit and reject from the list
  and from the diagram, select several items to accept together, and work by keyboard. Every text stays text.
- **FR-026**: Any signed-in account MUST be able to review any threat model's draft, and to create, edit and delete its assets
  and assumptions, as any account can already edit any threat model, until Phase 6 brings roles (M4 FR-068).
- **FR-027**: The constitution's Threat Model section and `docs/threat-model/` MUST be updated in the same change
  (Principle V, a MINOR amendment with its Sync Impact Report) to list: the accepted parts of a draft, and the new asset
  and assumption records with their provenance, as current assets (they were planned); the decision operations and the
  asset and assumption operations as entry points; the AI-proposed-edits item of Tampering as now current and how it is
  mitigated (the human accept, the server building records from the stored draft, one transaction, the rules of each record,
  a mark no client can set); the Spoofing item that says a reviewer reads a draft "in Milestone 5" as now in place; the
  widening of FR-026 as justified and what is not widened; the report and file now carrying AI-derived text as ordinary
  records; and the risks that remain (a reviewer accepting without reading; the model proposing what the documents do not
  say, which a reviewer sees as a quote).
- **FR-028**: `API.md` MUST document the new operations and the file's new version, and the plan's roadmap entry for
  Milestone 5 MUST say what was built.
- **FR-029**: The tests MUST run without any real provider and without any repository secret. No prompt, provider adapter
  or extraction pipeline changes in this milestone, so Principle II's eval gate does not apply to it.
- **FR-030**: Review states, assets, assumptions and provenance MUST live in Scrylux's existing database, with no new
  service, and any schema change MUST follow the project's forward-only rule (Principle IV).

### Key Entities *(include if feature involves data)*

- **Review decision**: an item's state in a draft (undecided, accepted or rejected), who decided it and when, and, for an
  accepted one that created a record, that record. Lives and dies with the draft.
- **Comparison**: how a proposed item stands against the threat model now: new, already in the model, or several in the
  model, with its differences. Derived when shown or decided, never stored.
- **Accepted element**: an ordinary element of the threat model (Phase 1 Milestone 3) that was created from a draft item,
  with the provenance of FR-017.
- **Asset**: a thing of value in the system: a name, a description, the elements that hold it, and, when it came from a
  draft, provenance. New in this milestone.
- **Assumption**: a statement the design relies on and, when it came from a draft, provenance. New in this milestone.
- **Provenance**: the AI mark on a record, or on the flags an accept filled in on an existing element, with the rationale and
  the citations (as spans of chunks) copied from their draft item. It outlives the draft and is never exported.
- **Draft, proposed item, citation**: as in Milestone 4. Not changed by this milestone except to carry decisions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of the tests, reading, comparing, rejecting and returning to undecided leave a threat model's
  elements, assets, assumptions, threats and mitigations exactly as they were, and no record exists that a person did not
  accept.
- **SC-002**: In 100% of the tests, an accepted subset gives a threat model that follows every diagram and record rule,
  holds exactly the accepted records (with their edits) beside what it already had, and none of the rest of the draft.
- **SC-003**: In 100% of the tests, an accept that is refused in any part creates no record, and the same item accepted
  twice, including by two requests at once, creates one record.
- **SC-004**: In 100% of the tests with a draft discarded or replaced between a page load and a decision, the decision is
  refused, creates nothing, and records accepted earlier remain with their provenance.
- **SC-005**: Accepting a whole draft of the largest size (40 elements, 15 assets and 15 assumptions) takes under 2 seconds
  on the CI host, whatever the size of the threat model it joins, up to its limits.
- **SC-006**: A recognizable fake draft text, run through every decision and every create, edit and delete, appears in 0 log lines
  and 0 error answers, and in no file or report.
- **SC-007**: In the browser tests, a reviewer opens a draft, accepts a subset, edits one element and one asset, rejects
  one item, and sees the diagram editor show exactly the accepted elements and the assets and assumptions section show the
  accepted ones, each with its provenance.
- **SC-008**: The phase's flow works: a threat model with a draft is accepted in part, exported as a Scrylux file and as a
  report, and both hold the accepted elements, assets and assumptions and nothing of the draft; the file imports back to an
  equal threat model without provenance, and a version 1 file still imports.
- **SC-009**: The v0.1, Milestone 2, 3 and 4 test suites, including the browser tests, pass with this milestone merged,
  and review needs no worker and no provider.
- **SC-010**: The updated threat model passes its pull-request checks, and a reviewer can find the accepted parts of a
  draft, the new records, the decision operations and the revised Tampering and Spoofing items in both the constitution
  and `docs/threat-model/`.

## Assumptions

- **Match by kind and name.** Two records are "the same" when kind and name agree, ignoring case and surrounding
  whitespace (for an assumption, the statement). Fuzzier matching is not part of this milestone. A flow matches by its name
  like any element, and its endpoints appear among the differences.
- **Decisions belong to the draft** and are lost when it is replaced or discarded. The page says so before a new
  extraction. A rejected item can come back in a later extraction; Scrylux does not remember rejections across drafts.
- **Dependencies are explicit.** Scrylux does not accept an element's dependencies behind the reviewer's back. It tells
  the reviewer what is missing, and accepting several items together is how a flow and its endpoints go in at once. An
  asset's holders are the exception, because a holder is an optional link and the review says which were left out.
- **Edits are made when accepting**, not saved separately beforehand. The draft keeps the model's values.
- **Holders added to a matched asset are plain links.** Provenance covers a record the accept created and the flags it
  filled in. A holder an accept adds to an existing asset is not marked, and the decision that added it is visible only
  while the draft exists.
- **Placement is the diagram's.** An accepted element has no stored position, and the editor places it as it places any
  element without one (Phase 2 Milestone 1).
- **Assets and assumptions are ordinary records.** A person can create one by hand as well as accept one (clarified
  2026-11-10), so the milestone ships the whole of their management and not only the accept path. A hand-made record has
  no provenance, and nothing but an accept can add it.
- **Limits.** The plan sets the per-threat-model limits on assets and assumptions. A starting point is 200 of each, which
  holds any draft (at most 15 of each) many times over.
- **Files.** The Scrylux file gains optional lists of assets and assumptions and moves to version 2, still reading version
  1. OTM and Threat Dragon are not changed, because OTM's assets are a different shape and Threat Dragon has no place for
  either; the planning step may decide to map assets to OTM, and that is not required here.
- **A source change or a deleted citation does not block acceptance.** It is a warning, because a reviewer may know the
  documents are still right.
- **No threat generation.** Proposing threats for accepted elements is Milestone 6. Whether Milestone 6 also reads assets
  and assumptions is its own decision.
- **Smallest change.** Under the constitution's Principle III (1.18.0) this milestone adds no file, option or abstraction
  that its requirements do not need, and reuses the element write rules, the draft's records and its page. The two new
  record kinds are the milestone's largest cost and follow from the decision of 2026-11-10.
