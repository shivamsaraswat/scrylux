# Feature Specification: System Extraction

**Feature Branch**: not yet created (spec directory `phase-3/milestone-4-system-extraction`; work is on `feat/phase-3`)

**Created**: 2026-11-08

**Status**: Draft

**Input**: User description: "let's start on milestone 4 of phase 3". This covers Phase 3 / Milestone 4 of `plan.md`,
system extraction. A signed-in person asks Scrylux to read a threat model's sources (Milestone 3) and propose the system
they describe: its components (processes), data stores, external entities, data flows, trust boundaries, assets and
assumptions. A background job (Milestone 2) sends the sources' text to the configured generation model through
Scrylux's provider layer (Milestone 1). The model answers in a fixed structure, in which every proposed item carries its
rationale and citations to the chunks it came from. Scrylux checks the answer against that structure and against the
chunks it sent. An answer that fails is retried, then rejected, and never stored. A valid answer is stored as the
threat model's **draft** and shown as a draft data-flow diagram, apart from the threat model itself. When the sources
are small enough, the model reads all of them. When they are not, Scrylux chooses the chunks most relevant to a system
model, using the embeddings Milestone 3 stored, and this milestone adds the index that search needs.

This milestone proposes, checks, stores and shows a draft. It does not change the threat model: it writes no element
and no threat, and it offers no way to accept, edit or reject a proposed item. Comparing the draft with the current model
and accepting items into it is Milestone 5 (review UI). Proposing threats is Milestone 6. This is also the first
milestone that sends a document's text to a generation model, so the untrusted-input handling that the constitution
left to "Milestone 4" ships and is verified here (Principle VI).

## Clarifications

### Session 2026-11-08

- Q: Where do proposed assets and assumptions go? Scrylux's threat model has no place for them today. → A: In the draft
  only, shown beside the diagram. This milestone adds no record for them to the threat model. Whether accepting them adds
  a new kind of record is Milestone 5's decision (FR-023).
- Q: What makes a citation valid? → A: The identifier (sent as its label, clarified at planning) of a chunk that was sent in the request, plus a short passage
  quoted from that chunk. Scrylux checks that the passage is really in the chunk, ignoring differences in whitespace, so
  a citation that points at the wrong chunk makes the answer invalid before anything is stored. This makes part of
  Milestone 7's "a real chunk that supports it" checkable by machine, at the cost of more retries on weak models
  (FR-032).
- Q: The constitution requires a change to a prompt or an extraction pipeline to pass the eval harness, which arrives
  in Milestone 7. What applies to this milestone? → A: Principle II is amended in the same change so that the eval
  gate applies from Milestone 7, when the harness exists. Until then, this milestone is verified by tests with simulated
  answers and by a recorded manual run against a hosted model and, where the maintainer has hardware for one, a local model (FR-084; amended 2026-11-09: the maintainer's hardware cannot run a local model large enough, so the local run was waived and SC-002 is verified for a hosted model only).
- Q: When someone starts an extraction while some of the threat model's sources are still waiting or being processed,
  should Scrylux run it on the ready sources only, or refuse until every source has finished? → A: Refuse while any
  source is waiting or processing, naming them and saying to wait. Failed sources do not block, and the draft names
  them as left out (FR-004).
- Q: When the model proposes a security flag on an element, does that flag need a citation of its own, or are the
  element's citations enough? → A: Each proposed flag carries its own citation with a checked quote. A flag with no
  citation makes the answer invalid, and a flag the documents do not mention stays "not assessed" (FR-022).

### Session 2026-11-08 (during planning)

- **No approximate vector index.** plan.md said this milestone "adds the vector index it queries". Planning found that
  choosing chunks always filters to one threat model's chunks, at most 10,000 at the default limits, and an approximate
  index over the whole install is at its weakest under such a filter (it can return too few rows). Scrylux compares
  the query embeddings with every chunk of the threat model, exactly, in one pass that reaches the chunks through the
  existing index on a source's chunks. It finds the true nearest chunks, works for every dimension, and is measured
  under 2 seconds at the largest default size (FR-013, FR-090, FR-091, SC-006, research #6). plan.md and the roadmap
  are updated to say so.
- **The model sees labels, not identifiers.** Chunks are sent as `c1`, `c2`… in the order sent, and items name each
  other by short references the model chooses. Scrylux maps them back. No chunk identifier or database identifier
  reaches the model, so a citation outside the request cannot even be written (FR-032, FR-036, research #3).
- **A cut-off answer is not retried.** The provider layer fails an answer cut off at the output limit at once as
  "output limit reached" (Milestone 1). Retrying it is refused until the operator's output limit or the generation model
  changes, as for "input too large" (FR-045, research #9).
- **Some local servers shorten input silently.** Ollama cuts an input longer than its context without an error, so
  Scrylux cannot detect it. The documentation makes the context length a requirement for extraction, and the
  pre-release run records the context setting and the input tokens the provider reported (FR-016, FR-082, FR-084,
  research #8).
- **Starting again is retrying.** One route starts an extraction. When the threat model's latest extraction failed, the
  start applies FR-045's retry rules to that failure (FR-045, FR-064).
- **A quote is stored as its place in the chunk, not as a copy.** Deleting a source then leaves none of its text in a
  citation (FR-054, research #4).
- **The retry note must not echo the answer.** The provider layer's note on an invalid answer quoted zod's message for
  an unknown field, which names the field. That note goes to the model outside the marked content section, so a
  document could plant text there. The layer now uses fixed text for every issue (FR-036, research #2).
- **A long answer from a local model takes time.** A full draft may pass `LLM_TIMEOUT`'s 5 minutes on a local model,
  and a timeout is retried and paid for again. The guide says to raise it, and SC-002's 5 minutes is measured for a
  local model on a host with a GPU (FR-082, research #8).

### Session 2026-11-08 (during analysis)

- **Who names unfinished sources.** The page names the sources still being processed; the API's refusal counts them,
  so no source name is in an error answer (FR-004).
- **The running extraction is shown, not named in the error.** A second start is refused in the API's `{ error }`
  form, and the page reads the running job from the extraction status (FR-042).

## User Scenarios & Testing *(mandatory)*

This milestone has three kinds of user. People signed in to Scrylux start an extraction on a threat model and read the
draft it makes. Operators who self-host Scrylux choose the generation model and the budget of what it may read. Later
milestones rely on the guarantees about the draft below: Milestone 5 accepts its items into the threat model, Milestone 6
proposes threats for them, and Milestone 7 measures them. The stories are written from their side.

### User Story 1 - Get a draft of the system from its documents (Priority: P1)

A signed-in person opens a threat model with ready sources and starts an extraction. Scrylux answers at once that the
extraction is queued, and the page shows its progress without a reload. When it ends, the threat model's page shows the
draft: the proposed components, data stores, external entities, flows and trust boundaries as a diagram, clearly marked
as a draft that is not part of the threat model, with the proposed assets and assumptions beside it. The threat model's
own diagram and threats are unchanged.

**Why this priority**: It is the milestone. Every later Phase 3 milestone starts from a draft, and the phase's
Definition of Done starts with "upload a design doc, get a draft DFD".

**Independent Test**: With a worker running and a simulated generation provider that answers with a valid system
model, add two sources, start an extraction, and check that the page shows its progress and then the draft as a
diagram, marked as a draft, with every item the answer held. Check that the threat model's elements and threats are
the same before and after.

**Acceptance Scenarios**:

1. **Given** a threat model with at least one ready source and a configured generation provider, **When** a signed-in
   person starts an extraction, **Then** Scrylux answers at once that it is queued, and its job runs on the worker
   (FR-001, FR-040).
2. **Given** an extraction that is queued or running, **When** its progress changes, **Then** the threat model's page
   shows the change within 5 seconds, without a reload (FR-063).
3. **Given** an extraction that succeeded, **When** the threat model's page is opened, **Then** it shows the draft as a
   diagram of the proposed elements, with boundaries around their members and flows between their endpoints, and the
   proposed assets and assumptions beside it (FR-060, FR-061).
4. **Given** a draft, **When** it is shown, **Then** it is marked as a draft that is not part of the threat model, and
   it cannot be mistaken for the threat model's own diagram (FR-061).
5. **Given** any extraction, whatever its outcome, **When** it ends, **Then** the threat model's elements, threats and
   mitigations are exactly as they were (FR-050).
6. **Given** no generation provider configured, or no ready source, **When** a person opens the threat model, **Then**
   starting an extraction is not offered, and the page says what it needs (FR-002, FR-003).
7. **Given** a threat model with a source that is waiting or processing, **When** a person tries to start an
   extraction, **Then** it is not offered and the page names the unfinished sources and says to wait, and the API
   refuses it with an answer that counts them without naming them. A failed source does not block it (FR-004).

---

### User Story 2 - Check where each proposed item came from (Priority: P1)

A signed-in person selects an item of the draft and sees why the model proposed it and the passages it came from: each
citation names its source and where in the source it is (page, lines, heading), and opens the cited chunk's text. A
reviewer can tell, item by item, whether the documents really say what the draft claims.

**Why this priority**: Principle VI: an AI-proposed item without rationale and citations is an unreviewed guess.
Milestone 5's reviewer decides on each item by reading its citations, and the phase's Definition of Done asks that every
item have a working citation.

**Independent Test**: Run an extraction against a simulated answer whose items cite known chunks. Select each item,
and check that its rationale is shown and that each citation names the right source and location and opens the right
chunk text. Run one whose answer cites a chunk that was not sent, one whose item has no citation, and one whose quoted
passage is not in the cited chunk, and check that none is stored.

**Acceptance Scenarios**:

1. **Given** a draft, **When** a person selects an item, **Then** they see its rationale and every citation, each with
   its source's name and the chunk's location in it (FR-021, FR-062).
2. **Given** a citation, **When** a person opens it, **Then** they see the cited chunk's text, shown as text (FR-062,
   FR-066).
3. **Given** an answer in which an item has no rationale or no citation, or cites a chunk that was not sent in that
   request, **When** it is checked, **Then** it is invalid, and it is retried or rejected, never stored (FR-031,
   FR-032).
4. **Given** a citation whose quoted passage is not in the cited chunk, even though the chunk was sent, **When** the
   answer is checked, **Then** it is invalid (FR-032).
5. **Given** a citation, **When** it is shown, **Then** its quoted passage is shown with it, so a reviewer sees what
   the model relied on before opening the chunk (FR-062).

---

### User Story 3 - The model's answer is checked before it is kept (Priority: P1)

The model answers in a fixed structure. An answer that does not match it, or that describes an impossible system (a
flow between two boundaries, a flow from an element to itself, a boundary nested in itself, an item whose name is too
long, a flag that does not apply to its type, more items than the draft may hold), is sent back to the model, up to the
layer's attempt limit, and then rejected. A rejected extraction ends as failed with a message that says the model did
not return a usable answer, and the previous draft, if any, stays as it was.

**Why this priority**: Principle VI and plan.md: output that fails validation is retried or rejected, never written to
the database. Milestone 5 will accept draft items into the threat model, so a draft item that the threat model would
refuse must never be stored.

**Independent Test**: Run extractions against simulated answers that each break one rule of FR-030 to FR-034, first
once and then on every attempt. Check that an answer that is fixed on a later attempt is stored, and that one that is
never fixed ends as failed "invalid output", stores nothing, and leaves the earlier draft unchanged.

**Acceptance Scenarios**:

1. **Given** an answer that breaks any rule of FR-030 to FR-034, **When** it is checked, **Then** the request is made
   again, up to the attempt limit (FR-035).
2. **Given** answers that break a rule on every attempt, **When** the attempts run out, **Then** the extraction fails
   as "invalid output", nothing is stored, and the earlier draft stays (FR-035, FR-052).
3. **Given** a valid answer, **When** it is stored, **Then** every item in it could be added to the threat model as it
   stands, without breaking a rule of the threat model's diagram (FR-033).

---

### User Story 4 - Know what the model read (Priority: P1)

A threat model whose sources fit the operator's budget is read whole. One whose sources do not is read in part: Scrylux
chooses the chunks most relevant to a system model, and the draft says so, how many of the chunks it read, and which.
A person can tell whether a missing component is missing from the documents or was not read.

**Why this priority**: plan.md: "for small inputs, skip retrieval and send the full context". Retrieval reads a part
of the documents, and a draft that silently describes part of a system looks complete when it is not.

**Independent Test**: Run an extraction on sources that fit the budget, and check that every chunk was sent and that
the draft says it read all of them. Lower the budget so the same sources do not fit, run again, and check that the
chunks sent are within the budget, in document order, that the draft says it read part of the sources, names how many
of how many, and that a person can see which chunks were read.

**Acceptance Scenarios**:

1. **Given** ready sources whose text fits the budget, **When** an extraction runs, **Then** it sends all of their
   chunks and needs no embeddings (FR-010, FR-011).
2. **Given** ready sources whose text does not fit the budget, **When** an extraction runs, **Then** it sends only the
   chunks chosen by relevance, within the budget, in the order they appear in their sources (FR-012, FR-013).
3. **Given** a draft made from part of the sources, **When** it is shown, **Then** it says that the sources were read in
   part, how many chunks were read of how many, and which ones (FR-014, FR-062).
4. **Given** ready sources that do not fit the budget and whose embeddings are from another model, or with no embedding
   provider configured, **When** a person starts an extraction, **Then** it is refused with a message that says to
   refresh the embeddings or configure an embedding provider, and nothing is queued (FR-015).

---

### User Story 5 - Know before extracting that document text leaves the install (Priority: P1)

A signed-in person about to start an extraction sees, next to the control that starts it, whether the threat model's
documents will be sent outside the install, to which provider, and that this is the generation provider. With a local
generation model, it says that the text stays in the install.

**Why this priority**: Principle VI requires the notice wherever user content can reach a hosted provider. This is the
first milestone that sends document text to generation, a different provider and a much larger amount of text than the
embeddings of Milestone 3.

**Independent Test**: Configure a hosted generation provider and check that the notice, naming it, is on screen before
the start control can be used. Configure a local one and check that it says the text stays in the install.

**Acceptance Scenarios**:

1. **Given** a hosted generation provider, **When** a person can start an extraction, **Then** the notice that the
   threat model's document text will be sent outside the install, naming the provider, is shown before they can start it,
   on every visit (FR-070).
2. **Given** a local generation provider, **When** a person can start an extraction, **Then** the page says that the
   text stays in the install (FR-071).

---

### User Story 6 - A document cannot steer Scrylux (Priority: P1)

A document may hold text written to steer a model: "ignore your instructions", a fake end of the document section, a
request to cite another threat model's chunks, to add a component that is not in the design, or to call a tool. Scrylux
sends every document only inside the marked section for untrusted content, gives the model no tool, accepts only the
fixed structure, accepts only citations to chunks it sent, and shows everything the model wrote as text. The most such
a document can do is change what is proposed, and nothing proposed enters the threat model without a person accepting
it (Milestone 5).

**Why this priority**: Principle VI and the constitution's Threat Model section: indirect prompt injection is the new
risk of this milestone, and its handling "MUST be verified before that milestone ships".

**Independent Test**: Add sources that hold each of the injection attempts above, run an extraction with a simulated
provider that records what it was sent, and check that the document text appears only inside the marked section, that
the request offers no tool, and that a simulated answer which follows the injection (a citation outside the request, a
field outside the structure, markup in a name) is rejected or shown as text.

**Acceptance Scenarios**:

1. **Given** any extraction, **When** its request is built, **Then** every source's text, name and chunk label sent is
   inside the marked section for untrusted content, nothing from a source is in the instruction position, and no chunk
   or database identifier is sent at all (FR-036).
2. **Given** a document that holds a fake end marker, **When** it is sent, **Then** it cannot close the marked section
   (FR-036).
3. **Given** an answer that cites a chunk of another threat model, or of a source that was not sent, **When** it is
   checked, **Then** it is invalid (FR-032).
4. **Given** an answer that holds markup or script in a name, a rationale or an assumption, **When** it is shown,
   **Then** it is shown as text, never rendered or run (FR-066).
5. **Given** any extraction, **When** it runs, **Then** the model is offered no tool, and no answer can cause Scrylux to
   take any action other than storing a draft (FR-037).

---

### User Story 7 - Run extraction again and discard a draft (Priority: P2)

A person adds a source, or decides a draft is not useful, and runs the extraction again. The new draft replaces the old
one only when the new extraction succeeds. A person can also discard a draft. A draft says when the sources have changed
since it was made, and a citation whose source was deleted says so instead of disappearing.

**Why this priority**: Documents change, and models vary from run to run. It is P2 because US1 to US6 deliver one
extraction end to end.

**Independent Test**: Make a draft, add a source, and check that the draft says the sources changed since it was made.
Run again and check that the new draft replaced it. Run again against a provider that fails, and check that the
previous draft stays. Delete a cited source, and check that its citations say the source was deleted and that an item
left with no citation says so. Discard the draft and check that it is gone.

**Acceptance Scenarios**:

1. **Given** a threat model with a draft, **When** a new extraction succeeds, **Then** its draft replaces the earlier
   one, and the UI says before starting that it will (FR-052).
2. **Given** a threat model with a draft, **When** a new extraction fails or is cancelled, **Then** the earlier draft
   stays as it was (FR-052).
3. **Given** a draft, **When** a source is added to or deleted from the threat model, or a source it read is deleted,
   **Then** the draft says the sources have changed since it was made (FR-053).
4. **Given** a draft that cites a source that was then deleted, **When** it is shown, **Then** each such citation says
   the source was deleted, and an item with no remaining citation says it has none (FR-054).
5. **Given** a draft, **When** a signed-in person discards it, **Then** it is deleted (FR-055).
6. **Given** a threat model with a running extraction, **When** a person tries to start another, **Then** it is refused,
   and the page shows the running extraction (FR-042).

---

### User Story 8 - The same flow works with a hosted and a local model (Priority: P2)

An operator who runs Scrylux fully offline, with a local generation model, gets a draft from the same documents, within
the same limits, as one who uses a hosted provider. The operator's guide says what a local model needs (its context, its
timeout and its size, and how to check them) and what budget suits it, and names the models known to work where the
maintainer has hardware to verify one (amended 2026-11-09: none has been verified).

**Why this priority**: plan.md's Phase 3 goal is that the flow works with a hosted provider and with a fully local model,
and Principle VI requires a local model to remain a supported path. It is P2 because the code path is the same; what
differs is the defaults and the documentation.

**Independent Test**: Where the maintainer has hardware for a local model (amended 2026-11-09: they had none large enough, so this
was not run), run an extraction with it and the default budget on a committed sample document in the manual pre-release run
and check that it yields a valid draft. Check that the default budget fits that model's context with the answer.

**Acceptance Scenarios**:

1. **Given** a local model that has been verified (where the maintainer has hardware for one; none has been) and the default
   settings, **When** an extraction runs on a committed sample document, **Then** it yields a valid draft (FR-016, SC-002).
2. **Given** an operator's budget larger than the model's context, **When** an extraction runs, **Then** it fails with a
   message that the model could not take the input and a hint to lower the budget, and nothing is stored (FR-016).

---

### User Story 9 - Extraction is in Scrylux's own threat model (Priority: P2)

A reviewer reads Scrylux's threat model and finds the draft as a current asset, the routes that start an extraction,
read a draft and discard it, the boundary through which document text now reaches prompts as current, the outbound
provider boundary now carrying document text to generation, and how each risk, prompt injection first, is handled.

**Why this priority**: Principle V requires the Threat Model section, and `docs/threat-model/`, to be updated in the same
change that adds an asset, an entry point or a trust boundary. The section names this milestone three times as the one
that must verify the handling of untrusted document content.

**Independent Test**: Read the Threat Model section and the committed threat model after the change, check that each
item of FR-080 is there, and that the threat model's checks pass on the pull request.

**Acceptance Scenarios**:

1. **Given** the change, **When** the constitution's Threat Model section is read, **Then** it lists the items of
   FR-080, and the items that named this milestone are resolved.
2. **Given** the change, **When** `docs/threat-model/` is checked on the pull request, **Then** it matches the section
   and its checks pass.

---

### Edge Cases

- **Sources still being ingested.** Starting an extraction is refused while any source is waiting or processing, and
  the page names them (the API's answer counts them), so a draft is not made from part of the documents by accident. A failed source does not
  block it: it is left out, and the draft names it. A source added after the start, while the job waits in the queue,
  is left out too, and the draft says its sources changed (FR-004, FR-053).
- **All ready sources deleted before the job runs.** The extraction fails as "no ready source" and is not retried
  (FR-044).
- **A source deleted while the extraction runs.** The draft is stored only if every chunk it cites still exists when it
  is stored. Otherwise the extraction fails as "sources changed", may be retried, and the earlier draft stays (FR-051).
- **The embedding model changes between start and run.** On the retrieval path, the extraction fails as "embeddings out
  of date", with a hint to refresh them, and is not retried until they are refreshed (FR-015, FR-044).
- **Ready sources with embeddings from two models.** On the retrieval path, embeddings from two models, or of two
  dimensions, are never compared. Every ready source must have embeddings from the configured model, or the extraction
  is refused (FR-015).
- **A model that cannot produce structured output, or a context too small for the budget.** The layer reports the
  failure (Milestone 1), the extraction fails with its fixed message and hint, and nothing is stored (FR-016).
- **An answer that is cut off by its output limit.** The provider layer fails it at once as "output limit reached",
  with a hint that the draft was larger than the output limit. Nothing is stored, and retrying is refused until the
  operator raises the output limit or changes the model (FR-045).
- **A local server that shortens the input silently.** Ollama cuts an input longer than its context, without an error,
  and the model then reads part of the sources while the draft says it read them whole. Scrylux cannot see it. The
  operator's guide makes the context length a requirement of extraction (FR-016, FR-082).
- **An answer with no items.** Documents that describe no system give an empty answer. It is valid only if the model
  also says why, and the draft shows that nothing was found, rather than an empty diagram with no explanation (FR-024).
- **A quote that is almost right.** A model may change a word, a quotation mark or the case of a passage it quotes.
  Only runs of whitespace are treated as equal, so such a quote makes the answer invalid and it is retried. A model
  that keeps misquoting fails as "invalid output", and the hint says that this model does not quote its sources
  reliably (FR-032, FR-035).
- **Two items with the same name and type.** The answer is invalid, so that an item can be referred to without doubt
  (FR-034).
- **A proposed flag the model cannot support.** Every proposed flag value cites its own passage. An answer with a
  flag that cites nothing, or quotes a passage not in its chunk, is invalid and retried. A flag the documents do not
  mention is left unproposed, so it stays "not assessed", as in the threat model, and Milestone 6's rules see no
  guessed value (FR-022).
- **A draft larger than the threat model can hold.** The draft has its own item limit, well under the threat model's
  1,000 elements (FR-034). Whether accepting a draft into a full threat model fits is Milestone 5's.
- **The threat model already has elements.** The extraction reads only the sources, not the threat model's elements,
  and proposes the system as the documents describe it. Comparing it with the current model is Milestone 5's (FR-020).
- **Cap reached.** An extraction that reaches its token or cost cap fails as "cap reached", stores nothing, and keeps the
  earlier draft. Retrying it follows Milestone 3's rule for "cap reached" (FR-043, FR-045).
- **Cancelled from the Jobs page.** The extraction ends as cancelled, stores nothing, and keeps the earlier draft (FR-052).
- **No worker running.** The extraction stays queued, and the page says that no worker is processing it (M2 FR-062).
- **Generation provider removed after a draft was made.** The draft stays readable. Starting an extraction is not
  offered until one is configured (FR-002).
- **A deleted threat model or project.** Its drafts and extraction jobs are deleted with it (FR-056).
- **Exports, imports and reports.** They do not include drafts in this milestone, and their documentation says so
  (FR-067).
- **Many extractions from one account.** Any signed-in account can start an extraction, and each spends on the
  generation provider. One extraction per threat model at a time, Milestone 2's limit of active jobs per account and the
  per-job caps bound it, with no cooldown of its own. Any account can create more accounts and threat models, so spend
  across accounts stays bounded only by the operator's provider limits until Phase 6, and the threat model says so
  (FR-046, FR-080).
- **The model's answer quotes the document.** Names, rationales and assumptions are AI text derived from confidential
  documents. They are kept only in the draft and are never logged or written to a job record (FR-065).

## Requirements *(mandatory)*

### Functional Requirements

**Starting an extraction**

- **FR-001**: Any signed-in person MUST be able to start an extraction on a threat model. An extraction MUST read only
  that threat model's sources.
- **FR-002**: Starting an extraction MUST require a configured generation provider. With none configured, it MUST NOT be
  offered, the API MUST refuse it, and the UI MUST say that extraction needs a generation provider.
- **FR-003**: Starting an extraction MUST require at least one ready source on the threat model. With none, it MUST NOT be
  offered, the API MUST refuse it, and the UI MUST say that extraction needs a ready source.
- **FR-004**: Starting an extraction MUST be refused while any source of the threat model is waiting or processing.
  The UI MUST NOT offer it then, and MUST name those sources and say to wait until they finish. The API's answer MUST
  say how many sources are unfinished and to wait, and MUST NOT name them, so that no source name appears in an error
  answer (clarified 2026-11-08; the split between the UI and the API clarified at analysis). A failed source MUST NOT block it. An extraction MUST read the sources that are
  ready when its job runs, and MUST record which sources it read and which it left out because they were not ready. A
  source added after the extraction was started is left out in the same way, and the draft then says its sources
  changed (FR-053).

**What the model reads**

- **FR-010**: The operator MUST be able to set a context budget: the most source text one extraction sends to the model.
  It MUST have a documented default, checked when the worker and the API start (a zero, negative or malformed value stops
  them).
- **FR-011**: When the ready sources' text fits the budget, an extraction MUST send all of their chunks, in source order
  and then in chunk order, and MUST NOT need embeddings ("for small inputs, skip retrieval", plan.md).
- **FR-012**: When the ready sources' text does not fit the budget, an extraction MUST choose the chunks to send by their
  relevance to a system model, using the chunks' embeddings and a fixed set of retrieval queries kept as versioned data
  (Principle IV). It MUST send no more than the budget, and MUST send the chosen chunks in source order and then in
  chunk order, so the model reads them as they appear in the documents.
- **FR-013**: Choosing chunks MUST compare only embeddings of one model and one dimension, the configured embedding
  model's (M3 FR-032). It MUST compare the queries with every chunk of the threat model's ready sources, exactly, so it
  always finds the most relevant chunks, and MUST stay fast at the largest default size (20 sources of 1,000,000
  characters, M3 FR-005; SC-006) (clarified at planning).
- **FR-014**: A draft MUST record whether its sources were read whole or in part, the number of chunks read and the
  number available, and which chunks were read.
- **FR-015**: When the ready sources do not fit the budget and no embedding provider is configured, or any ready source
  has embeddings from a model other than the configured one, starting an extraction MUST be refused with a message that
  says which, and to refresh the embeddings (M3 FR-034) or configure an embedding provider. The worker MUST check this
  again when the job runs and fail as "embeddings out of date" or "not configured" if it no longer holds.
- **FR-016**: The default budget, the default output limit and the default caps (M2 FR-040) MUST be chosen together, so
  that an extraction at the default budget fits the context of the documented local model with its answer, and fits the
  default caps on every attempt the layer may make. A model that refuses the input as too large MUST fail the extraction
  as "input too large", with a hint to lower the budget, and store nothing. A local server that shortens an input
  silently cannot be detected (clarified at planning): the documentation MUST state, for each documented local server,
  the context length extraction needs at the default budget and how to set it.

**The draft**

- **FR-020**: The model MUST be given only the chosen chunks, each with its label (FR-036) and its source's name and
  location, and the fixed instructions. It MUST NOT be given the threat model's elements, threats or any other threat
  model's content.
- **FR-021**: A draft MUST hold proposed items of these kinds: processes (components), data stores, external entities,
  data flows, trust boundaries, assets and assumptions. Every item MUST carry a rationale, of a documented maximum
  length, and at least one citation (Principle VI).
- **FR-022**: A proposed process, data store, external entity or data flow MUST have a name of 1 to 200 characters, MAY
  name the trust boundary it sits in, and MAY propose values for the flags its type allows in the threat model (Phase 2,
  `ELEMENT_FLAGS`). Each proposed flag value MUST carry at least one citation of its own, checked as FR-032 says, to
  the passage that supports it. A proposed flag with no citation MUST make the answer invalid. A flag the item does not
  propose is "not assessed", and the instructions MUST tell the model to leave a flag unproposed when the documents do
  not say (clarified 2026-11-08). A data flow MUST name its two endpoints among the
  draft's processes, data stores and external entities. A trust boundary MAY sit in another trust boundary.
- **FR-023**: A proposed asset MUST have a name of 1 to 200 characters and a short description, and MAY name the draft
  elements that store or carry it, which MUST be elements of the same draft. A proposed assumption MUST be a statement of
  a documented maximum length, and its citations name the passages it concerns. Assets and assumptions MUST be kept in
  the draft only: this milestone adds no record for them to the threat model (clarified 2026-11-08).
- **FR-024**: A valid answer MAY propose no item, only if it also says why. A draft with no item MUST show that reason.
- **FR-025**: A draft MUST record: its threat model, who started it and when, the extraction job that made it, the
  generation model and the version of the prompts that made it (for Milestone 7, which records results per prompt
  version), what it read (FR-014), and its items.

**Validation and citations**

- **FR-030**: The model's answer MUST be validated against Scrylux's shared schema for a draft before anything is stored
  (Principle VI). A field outside the schema, or of the wrong type or length, MUST make the answer invalid.
- **FR-031**: An item with no rationale or no citation MUST make the answer invalid, as a proposed flag with no
  citation of its own does (FR-022).
- **FR-032**: A citation MUST name a chunk that was sent in that request. A citation to any other chunk, including a real
  chunk of the same threat model that was not sent, or a chunk of another threat model, MUST make the answer invalid.
  Each citation MUST also quote a passage of the cited chunk, of a documented minimum and maximum length. Scrylux MUST
  check that the passage is in the chunk's text, comparing with runs of whitespace treated as one space and nothing
  else relaxed. A passage that is not in the chunk MUST make the answer invalid (clarified 2026-11-08).
- **FR-033**: The draft's elements MUST obey every rule the threat model's diagram enforces (Phase 2 Milestone 1), so
  that Milestone 5 can accept any item as it stands: a flow's endpoints are processes, data stores or external entities
  of the draft; a flow does not start and end at the same element and sits in no boundary; a boundary is not nested in
  itself, directly or through others; a name is 1 to 200 characters; a flag applies to its type.
- **FR-034**: Within a draft, no two items of the same kind MUST have the same name, ignoring case, and a draft MUST hold
  at most a documented number of items, well under the threat model's 1,000 elements. Breaking either MUST make the
  answer invalid.
- **FR-035**: An invalid answer MUST be requested again, up to the provider layer's attempt limit (Milestone 1), and then
  the extraction MUST fail as "invalid output", storing nothing. The checks of FR-031 to FR-034 MUST count as schema
  checks for that limit, so an answer that breaks them is retried as one of the wrong shape is.
- **FR-036**: Every source's text, name and location MUST go only in the provider layer's marked section for untrusted
  content (Milestone 1), and nothing from a source MUST go in the instruction position. Chunks MUST be sent under labels
  that are numbered in the order sent, never under their identifiers, and Scrylux MUST map a cited label back to its
  chunk (clarified at planning). The instructions MUST be
  versioned data files (Principle IV) and MUST tell the model that the content section is data to describe, never
  instructions to follow.
- **FR-037**: An extraction MUST offer the model no tool and MUST take no action on the model's answer other than
  checking it and storing it as a draft (Principle VI; Phase 3 excludes tool calls).

**Extraction jobs**

- **FR-040**: An extraction MUST run as a Milestone 2 job, of a kind that ships with Scrylux, and MUST meet Milestone 2's
  requirements for every job kind (M2 FR-011 to FR-066). Its progress steps MUST be: choose the chunks, generate, check
  and store. It belongs to its threat model and is deleted with it.
- **FR-041**: The job's input MUST refer to its threat model by identifier only, and MUST NOT hold a source's name or
  text, a chunk or the draft (M2 FR-051).
- **FR-042**: A threat model MUST have at most one extraction queued or running at once. Another start MUST be refused,
  with an answer in the API's usual `{ error }` form, and the page MUST show the running extraction, which it reads from
  the threat model's extraction status (clarified at analysis).
- **FR-043**: An extraction MUST be bounded by the per-job token and cost caps (M2 FR-040 to FR-044), counting every
  attempt and, on the retrieval path, the embeddings of its queries. One that reaches a cap MUST fail as "cap reached"
  and store nothing.
- **FR-044**: This milestone MUST add these failure categories, each with a fixed message and hint kept as versioned data
  (M2 FR-064): "no ready source", "embeddings out of date", "sources changed". Only "sources changed" may pass and be
  retried as Milestone 2's transient failures are. "invalid output", "input too large", "not configured" and the others
  come from Milestones 1 and 2.
- **FR-045**: A signed-in person MUST be able to retry a failed extraction, which queues a new job with fresh caps.
  Retrying is starting again: when the threat model's latest extraction failed, a start MUST apply these rules to that
  failure (clarified at planning). Retrying MUST NOT be offered, and the API MUST refuse it, for "cap reached" until the
  operator's caps are higher than those of the job that reached them, for "input too large" until the budget or the
  generation model changes, for "output limit reached" until the output limit or the generation model changes, and for
  "embeddings out of date" until they are refreshed (the rule of M3 FR-045).
- **FR-045a**: Extraction jobs MUST be queued only through the extraction route (FR-064), which applies the checks of
  FR-002 to FR-004, FR-015 and FR-042. Milestone 2's route that starts a job MUST refuse this kind.
- **FR-046**: Extraction jobs MUST count toward Milestone 2's limit on queued or running jobs per account (M2 FR-046),
  and MUST NOT have a cooldown of their own. They are bounded by that limit, one extraction per threat model (FR-042)
  and the per-job caps, and the threat model MUST say so (FR-080).
- **FR-047**: Extraction is a job kind that calls a model, so Milestone 2's rule for such kinds (M2 FR-063) covers it,
  with the generation provider as the provider it needs.

**The draft's life**

- **FR-050**: An extraction MUST NOT create, change or delete any element, threat or mitigation of a threat model. A
  draft and the threat model MUST be kept apart, so that no AI-proposed item is ever mistaken for an accepted one
  (Principle VI).
- **FR-051**: A draft MUST be stored in one transaction, only if every chunk it cites still exists, fenced by the job's
  claim, so that a worker that lost its job stores nothing. If a cited chunk was deleted, the extraction MUST fail as
  "sources changed".
- **FR-052**: A threat model MUST have at most one draft. A successful extraction MUST replace the earlier draft. A failed
  or cancelled one MUST leave it as it was. The UI MUST say, before an extraction is started on a threat model that has
  a draft, that the new draft will replace it.
- **FR-053**: A draft MUST say that the sources have changed since it was made when a source has been added to the
  threat model, a source it read has been deleted, or a source it left out has become ready.
- **FR-054**: A citation whose chunk no longer exists MUST be shown as "source deleted", never dropped silently. An item,
  or a proposed flag, left with no remaining citation MUST say so.
- **FR-055**: Any signed-in person MUST be able to discard a threat model's draft, which deletes it.
- **FR-056**: Deleting a threat model, or a project with its threat models, MUST delete their drafts and their extraction
  jobs with their usage records (M2 FR-052).

**API and UI**

- **FR-060**: The draft MUST be shown on the threat model's page as a diagram of its elements, with boundaries around
  their members and flows between their endpoints, laid out by Scrylux (the model proposes no positions), and as a
  list of every item, so that it can be read without the diagram. Assets and assumptions MUST be shown beside it.
- **FR-061**: The draft MUST be marked, wherever it is shown, as a draft proposed by AI that is not part of the threat
  model, and MUST be read-only in this milestone.
- **FR-062**: Selecting an item MUST show its rationale, its citations, and its proposed flags, each flag with its own
  citations. Every citation MUST name its source and the chunk's location (page, lines, heading, as Milestone 3 records
  them), show its quoted passage and open the chunk's text. The draft MUST show what it read (FR-014), the model that
  made it, when, and by whom it was started.
- **FR-063**: While an extraction on a threat model shown on screen is queued or running, the page MUST show its changes
  within 5 seconds, without a reload, and MUST stop asking once it ends. Extraction jobs also appear on the Jobs page.
- **FR-064**: A signed-in person MUST be able to start an extraction, read a threat model's draft and discard it. These
  MUST be routes under `/api/v1`, need sign-in, check their input at the boundary, answer errors in the API's usual
  form, and appear in the generated OpenAPI document.
- **FR-065**: Each start, retry and discard MUST log one line: who, what, which threat model and job. No log line, job
  record, usage record, failure message or error answer MUST hold a source's text, a chunk, a prompt, an answer or any
  text of the draft (Principle IV, M2 FR-051).
- **FR-066**: Every text of a draft (names, rationales, descriptions, assumptions, the reason for an empty draft) and every
  cited chunk MUST be shown as text, never rendered as Markdown, HTML or any other markup (Principle VI).
- **FR-067**: Exports, imports and reports (Phase 2 Milestones 5 and 6) MUST NOT include drafts in this milestone, and
  their documentation MUST say so.
- **FR-068**: Any signed-in person MUST be able to start, see, retry and discard any threat model's extraction and draft,
  in line with what any account can do to a threat model today, until Phase 6 brings roles.

**The notice that data leaves the install**

- **FR-070**: When the generation provider is hosted, the control that starts an extraction MUST show, before it can be
  used, that the threat model's document text will be sent outside the install, to which provider, and that this is
  the generation provider. It MUST be shown on every visit, not once.
- **FR-071**: When the generation provider is local, the page MUST say that the text stays in the install. The
  retrieval queries that the embedding provider embeds on the retrieval path are fixed text that Scrylux ships
  (FR-012), which holds no user content (Principle VI), so they need no notice of their own.
- **FR-072**: The Sources tab's notice (M3 FR-071), which says that later milestones send a source's text to generation,
  MUST now say that extraction does.

**Threat model and documentation**

- **FR-080**: The constitution's Threat Model section and `docs/threat-model/` MUST be updated in the same change
  (Principle V), as a MINOR amendment with its Sync Impact Report, to list: the draft as a current asset (AI text derived
  from confidential documents); the new entry points (starting, retrying, reading and discarding); the boundary of
  untrusted document content flowing into prompts as current, not planned; the outbound provider boundary as now
  carrying document text to generation; and the risks with their handling: indirect prompt injection (FR-032, FR-035 to
  FR-037, FR-050, FR-066, and what a document can still do: change what is proposed, which a person reviews in
  Milestone 5), a fabricated or misdirected citation (FR-032), runaway generation spend (FR-043, FR-046, and what stays
  open until Phase 6), and disclosure of document text through drafts, logs or job records (FR-065, FR-067). The Spoofing
  item that says the handling of untrusted input "MUST be verified before that milestone ships", and the accepted item
  on stored prompt injection that "stays until that milestone verifies it", MUST each be resolved, naming the tests that
  verify them.
- **FR-081**: Every setting this milestone adds MUST be documented in the environment-variable table in
  `docs/install.md`, with which process reads it.
- **FR-082**: The AI providers guide (`docs/ai-providers.md`) MUST say where a document's text goes during an
  extraction, what a local model needs for it (and which models are known to work, and on what hardware, where one has been
  verified: none has, 2026-11-09), what budget suits them, the context length they need, and that a local model writing a full draft may need a longer `LLM_TIMEOUT` (clarified at
  planning).
- **FR-083**: The tests MUST run without any real provider and without any repository secret, using simulated provider
  responses (M2 FR-082).
- **FR-084**: Principle II MUST be amended in the same change (part of FR-080's MINOR amendment) so that the eval gate
  applies from Phase 3 Milestone 7, when the harness ships (clarified 2026-11-08). Until then, a change to a prompt or to
  the extraction pipeline MUST pass the tests with simulated answers, and this milestone MUST record, before release, a
  manual run of the committed sample document against a hosted provider and, where the maintainer has hardware for one, a
  local model (amended 2026-11-09: none was available, so only the hosted run is recorded): whether each run gave a valid draft, its item counts, its attempts, its usage and its duration (SC-002).

**The database**

- **FR-090**: Drafts MUST be created by forward-only migrations (Principle IV), in Scrylux's existing database, with no
  new service.
- **FR-091**: Choosing chunks MUST work for every embedding dimension Scrylux stores (M3 FR-032), with no setting per
  dimension. The operator's guide MUST say that it compares exactly, within one threat model, and needs no vector index
  (clarified at planning).
- **FR-092**: Every v0.1 flow, and every Milestone 2 and 3 flow, MUST keep working with no worker running and with no
  generation provider configured (M2 FR-072).

### Key Entities *(include if feature involves data)*

- **Draft**: the system the model proposed for one threat model from its sources. Who started it and when, the job,
  model and prompt version that made it, what it read, whether its sources have changed since, and its items. At most
  one per threat model. Kept apart from the threat model, and deleted with it.
- **Proposed element**: a process, data store, external entity, data flow or trust boundary of a draft, with its name,
  its boundary, its proposed flags each with its own citations, a flow's endpoints, its rationale and its citations. Obeys the threat model's
  diagram rules, so that Milestone 5 can accept it as it stands.
- **Proposed asset** and **proposed assumption**: an asset of value in the system, or a statement the design relies on,
  with a rationale and citations. Kept in the draft only; where accepted ones go is Milestone 5's decision.
- **Citation**: a link from a proposed item to a chunk that was sent in the request that proposed it, with a passage
  quoted from that chunk and checked against it. Shown as "source deleted" once its chunk is gone.
- **Extraction job**: a Milestone 2 job that chooses the chunks, asks the model and stores the draft. It belongs to its
  threat model and refers to it by identifier only.
- **Retrieval queries and prompts**: the fixed instructions and queries an extraction uses, kept as versioned data
  files, whose version each draft records.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With no generation provider configured and no worker running, the full v0.1, Milestone 2 and Milestone 3
  test suites, including the browser tests, pass, and `/health` answers as before.
- **SC-002**: In the manual pre-release run, with Scrylux on the smallest host the deployment guide names and the
  default settings, a committed sample design document of about ten pages yields a valid draft within 5 minutes with a
  hosted provider, and, where the maintainer has hardware for one, with a local model on a host with a GPU, whose hardware the run records. Verified for a hosted model only (amended 2026-11-09): the local run was waived.
- **SC-003**: In 100% of the tests, every stored draft has a rationale and at least one citation on every item, every
  proposed flag has at least one citation of its own, and every citation names a chunk that was sent in the request
  that made it and quotes a passage found in that chunk's text.
- **SC-004**: In 100% of the tests with an answer that breaks a rule of FR-030 to FR-034 on every attempt, nothing is
  stored, the earlier draft is unchanged, and the extraction fails as "invalid output".
- **SC-005**: Across every test, 0 elements, threats or mitigations are created, changed or deleted by an extraction.
- **SC-006**: Choosing the chunks of a threat model at the largest default size (20 sources of 1,000,000 characters,
  10,000 chunks) with embeddings of the largest documented dimension takes under 2 seconds in CI, and never compares
  embeddings of two models or two dimensions.
- **SC-007**: In 100% of the tests, a draft made from part of its sources says so and names how many chunks it read of
  how many, and a draft made from all of them says that.
- **SC-008**: For each injection attempt of US6, 100% of the requests built hold the document's text only inside the
  marked section, offer no tool, and 0 answers that follow the injection are stored.
- **SC-009**: A recognizable fake document text, run through every extraction outcome, appears in 0 log lines, job
  records, usage records, failure messages or API error answers. It appears only in the chunks, the draft and the pages
  that show them.
- **SC-010**: In 100% of the browser tests with a hosted generation provider, the notice that document text leaves the
  install, naming the provider, is on screen before an extraction can be started.
- **SC-011**: The updated threat model passes its pull-request checks, and a reviewer can find the draft, the new
  routes, the prompt boundary and the resolved prompt-injection items in both the constitution and `docs/threat-model/`.
- **SC-012**: In 100% of the tests, an extraction started through Milestone 2's job route is refused, a second
  extraction on the same threat model is refused while one is active, an extraction on a threat model with a waiting
  or processing source is refused with no job queued, and a retry of "cap reached" with unchanged caps
  is refused with no job queued.

## Assumptions

- **One draft per threat model, replaced as a whole.** A new extraction proposes the whole system again. Merging two
  drafts, or extracting from one source at a time into the same draft, is not part of this milestone.
- **The model does not see the current threat model.** It proposes the system as the documents describe it. Matching
  the draft against existing elements, and the diff a reviewer reads, are Milestone 5's. Sending the existing elements
  would add a second kind of input the model must not treat as instructions, for a gain Milestone 5 can get by matching.
- **Assets and assumptions stay in the draft** (clarified 2026-11-08). The threat model gains no record for them in
  this milestone, so its schema, exports and reports are unchanged. Milestone 5 decides what accepting one means.
- **Read-only in this milestone.** Accepting, editing and rejecting items is Milestone 5. Proposing threats and
  mitigations is Milestone 6. This milestone stores and shows the draft.
- **Retrieval for a whole system.** plan.md reads "for small inputs, skip retrieval" as a statement that large inputs use
  retrieval. A system model asks about the whole document, so retrieval reads it in part, and the draft says so (FR-014)
  rather than hiding it. Reading every chunk in several passes and merging the answers is not part of this milestone; if
  Milestone 7's evals show that partial reading is what loses components, a later change can add it.
- **Retrieval needs current embeddings.** The query is embedded with the configured model, and Milestone 3 forbids
  comparing embeddings of two models. A threat model that fits the budget needs no embeddings, so it is never blocked by
  a change of embedding model.
- **No cooldown.** Extraction is bounded like ingestion: by one active extraction per threat model, Milestone 2's
  limit of 3 active jobs per account, and the per-job caps. It counts toward that limit of 3 because, unlike ingestion,
  it is not started in bulk.
- **The defaults chosen in the plan.** The plan sets the default context budget, the output limit, the item limit and the
  rationale length, and confirms they fit the documented local model's context and the default caps (FR-016). If they do
  not, the plan changes the budget or the caps, and the documentation says which.
- **Layout is Scrylux's.** The model proposes no positions. The draft diagram is laid out automatically, and the layout
  is not stored with the draft. Milestone 5 decides where an accepted element is placed in the threat model's diagram.
- **The notice is a display, not a confirmation**, as in Milestone 3.
- **No new provider work.** Structured generation, the marked content section, the attempt loop and the "invalid
  output" category exist in the provider layer (Milestone 1). This milestone uses them and adds no adapter.
