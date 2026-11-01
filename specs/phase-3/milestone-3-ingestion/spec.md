# Feature Specification: Ingestion

**Feature Branch**: not yet created (spec directory `phase-3/milestone-3-ingestion`; work is on `feat/phase-3`)

**Created**: 2026-11-01

**Status**: Draft

**Input**: User description: "let's start on milestone 3 of phase 3". This covers Phase 3 / Milestone 3 of `plan.md`,
ingestion. A signed-in person adds the design documents of a system to a threat model, by uploading a `.md`, `.txt`,
`.pdf` or `.docx` file or by pasting text. Each one becomes a **source** of that threat model. The original is kept
through a storage abstraction, on a local volume or an S3-compatible service, until the source is ready, and is then
deleted. A background job (Milestone 2) extracts
its text, splits the text into **chunks** that keep their identity for good, so that later milestones can cite them,
and stores an **embedding** of each chunk in the database for retrieval. Ingestion needs a configured embedding
provider. This is the first milestone in which user content reaches a provider, so it also ships the notice that data
leaves the install (Principle VI). Nothing in this milestone proposes elements or threats. System extraction
(Milestone 4) is the first to read the chunks, and choosing which chunks to send is its decision.

## Clarifications

### Session 2026-11-01

- Q: Should adding a source require an embedding provider (Milestone 1 left this to Milestone 3)? → A: Yes. Adding
  sources is offered only when an embedding provider is configured, and every source is embedded. An install with no
  embedding provider, including one with generation only, cannot add sources, and the UI says that adding documents
  needs an embedding provider. Ingestion is a job kind that calls a model, so Milestone 2's rule for such kinds applies
  as it stands (FR-030, FR-047).
- Q: How do ingestion jobs relate to Milestone 2's limit of 3 queued or running jobs per account, when a person adds
  several files at once? → A: They have their own per-account limit, 20 by default (as many as a threat model's
  sources), which the operator can change, and they do not count toward the limit of 3. Each file stays its own source
  and its own job (FR-043).
- Q: Which storage backends does this milestone ship? → A: A local volume, the default, shared by the app and the
  worker in both compose files, and an S3-compatible service, so the app and the worker can run on separate hosts. The
  S3-compatible service's credentials are a new secret, held by both processes (FR-050, FR-052).
- Q: Once a source is ready, should Scrylux keep its uploaded original or delete it? → A: Delete it. An original is kept
  only while its source is waiting, processing or failed, which retrying needs. Nothing reads it once the source is
  ready (no download, no extracting again), and deleting it removes what extraction never kept, such as comments,
  tracked changes, author details and images. A document to be read again is added again (FR-057).
- Q: Should Scrylux cap the total size of ingested documents across the install? → A: Yes. An operator setting bounds
  the install's document space, 2 GB by default. Past it, adding a source is refused with a message that the install's
  document space is full, so the worst case is that adding documents stops, not that the database disk fills (FR-009).
- Q: What should a chunk of plain or pasted text record as where it came from? → A: The lines it spans. Every
  text-based source (`.txt`, `.md`, pasted text) records each chunk's line range, and Markdown also records the nearest
  heading, so a reviewer can find a cited passage in their own copy (FR-022).

### Session 2026-11-01 (during planning)

- Q: Embeddings take several times the space of the text they cover. What does the document space count? → A: What a
  source really stores. A ready source counts its text plus its embeddings (dimension × 4 bytes per chunk), so the cap
  bounds the database growth that sources cause. The worker checks the cap again when a source becomes ready, and a
  source that would pass it fails as "document space full", so ready sources never take the total past it (FR-009).
- The API checks a file's type only from bytes at fixed places (its first bytes), because reading a file's structure is
  parsing, which FR-010 keeps in the worker. A `.docx` that holds macros (`.docm`) is a valid archive that only parsing
  tells apart, so the worker fails it as "unsupported type", not retried (FR-003, research #5).
- Chunks are consecutive, with no overlap, and each records where it starts and ends in the extracted text, so reading
  them in order gives the whole text back exactly (FR-021, research #7).
- Each API process reads at most 4 uploads at once, so that uploads cannot exhaust its memory. A fifth is refused as
  busy, to be tried again in a few seconds. The UI sends a person's files one at a time, so adding several never meets
  it (FR-004, research #9).

## User Scenarios & Testing *(mandatory)*

This milestone has three kinds of user. People signed in to Scrylux add, review and remove sources on a threat model.
Operators who self-host Scrylux set where originals are stored, the size limits, and the database Scrylux needs. The
later milestones that read sources (system extraction, threat generation, the eval harness) rely on the guarantees
about chunks below. The stories are written from their side.

### User Story 1 - Add a design document to a threat model (Priority: P1)

A signed-in person opens a threat model and adds a design document: they upload a `.md`, `.txt`, `.pdf` or `.docx`
file, or paste text and give it a title. Scrylux answers at once that the source was added and is being processed. The
threat model's page lists the source with its name, type, size, who added it and when, and its status, which moves from
waiting to processing to ready, or to failed with a reason, without a reload. A ready source shows how many chunks it
has and whether they have embeddings.

**Why this priority**: Every later Phase 3 milestone starts from a threat model's sources. Without ingestion there is
nothing for system extraction to read. It is the part of this milestone a person sees.

**Independent Test**: With a worker running and a simulated embedding provider, upload one file of each type and paste
one text. Check that each appears at once as waiting, moves to ready without a reload, and shows its chunk count and
that it has embeddings. Then upload a file of an unsupported type and a file over the size limit, and check that both
are refused at once, with a message that says why, and that nothing was stored.

**Acceptance Scenarios**:

1. **Given** a signed-in person on a threat model, **When** they upload a supported file within the limits, **Then**
   Scrylux answers at once with the new source in the waiting state, and its ingestion job is queued (FR-040).
2. **Given** a signed-in person on a threat model, **When** they paste text and give it a title, **Then** it becomes a
   source like an uploaded `.txt` file, named by its title (FR-002).
3. **Given** a source that is waiting or processing, **When** its status or progress changes, **Then** the threat
   model's page shows the change within 5 seconds, without a reload (FR-063).
4. **Given** a file whose content is not one of the supported types, whatever its name says, **When** it is uploaded,
   **Then** it is refused, and nothing is stored (FR-003).
5. **Given** a file over the size limit, a threat model that already has the most sources allowed, or an install whose
   document space is full, **When** a file is uploaded or text is pasted, **Then** it is refused with a message that
   names the limit, and nothing is stored (FR-004, FR-005, FR-009).
6. **Given** several files chosen at once, up to the limits, **When** they are uploaded, **Then** each becomes its own
   source with its own ingestion job, and none is refused because of Milestone 2's limit of 3 active jobs per account
   (FR-043).
7. **Given** no embedding provider configured, **When** a person opens a threat model, **Then** adding a source is not
   offered, and the page says that adding documents needs an embedding provider (FR-030, FR-047).

---

### User Story 2 - Know before uploading that data leaves the install (Priority: P1)

A signed-in person about to add a source sees, on the form where they add it, whether its text will be sent outside
the install: to which configured operations (embeddings now, generation when the AI features of later milestones run),
and whether each is hosted or local. An install with only local providers says that nothing leaves the install. The
person sees this before they submit, every time, not only the first time.

**Why this priority**: Principle VI and plan.md require this notice from the first milestone in which user content can
reach a provider, and this is that milestone. A person who uploads a confidential design document has to know where its
text goes before it goes there.

**Independent Test**: Configure a hosted embedding provider and open the add-source form: check that it names
embeddings as hosted and says that the text leaves the install. Configure a local embedding provider and a hosted
generation provider: check that it says embeddings stay in the install and that generation, when used, sends text
outside. Configure only local providers: check that it says the text stays in the install. In each case, check that the
notice is on screen before the submit control can be used.

**Acceptance Scenarios**:

1. **Given** a hosted embedding provider, **When** a person opens the form to add a source, **Then** the form says,
   before they submit, that the source's text will be sent outside the install for embeddings, and names the provider
   (FR-070).
2. **Given** a hosted generation provider, **When** a person opens the form, **Then** the form also says that the
   AI features of later milestones will send the source's text outside the install, even though this milestone does
   not (FR-071).
3. **Given** only local providers, **When** a person opens the form, **Then** the form says that the text stays in
   the install.
4. **Given** the sources list of a threat model, **When** a hosted provider is configured, **Then** the list repeats the
   notice, so a person adding sources through any route sees it (FR-072).

---

### User Story 3 - Review what Scrylux read from a document (Priority: P1)

A signed-in person opens a ready source and sees the text Scrylux extracted from it, divided into its chunks in order,
each with where it came from in the original (a page for a PDF, the lines for text and Markdown, the nearest heading for
Markdown and Word files). They
can tell at a glance whether a scanned page or a table was missed before any AI feature reads it.

**Why this priority**: Principle VI: every AI proposal of later milestones will cite chunks. A reviewer who cannot see
the chunks cannot check a citation, and a person who cannot see what was extracted cannot tell a bad document from a
bad model. It is the only check a person has that ingestion read the document correctly.

**Independent Test**: Ingest a PDF with known text on known pages, a Markdown file with known headings, and pasted text.
Open each and check that the extracted text matches, that every part of it appears in at least one chunk, in order, and
that each chunk names its page, or its lines and heading, and that the lines match the text as received. Ingest a file
whose text holds markup and script, and check that it is shown as text and never runs or renders.

**Acceptance Scenarios**:

1. **Given** a ready source, **When** it is opened, **Then** it shows its extracted text as its chunks, in order, each
   with its position and where it came from in the original (FR-021, FR-022).
2. **Given** a source whose text holds markup, a script or Markdown formatting, **When** it is shown, **Then** all of it
   is shown as plain text, never rendered or run (FR-066).
3. **Given** a ready source, **When** its chunks are read twice, at any time apart, **Then** each chunk has the same
   identifier and the same text both times (FR-023).

---

### User Story 4 - Remove a document (Priority: P1)

A signed-in person who added the wrong document, or a confidential one by mistake, deletes the source. Its original
file, its extracted text, its chunks and their embeddings are all removed, and an ingestion still running for it is
stopped. Deleting a threat model does the same for every source it has.

**Why this priority**: A design document can be confidential. A deletion that leaves the original file behind in
storage, where no one in the UI can see it, keeps confidential data on the install after the person who added it was
told it was gone.

**Independent Test**: Ingest a source and check that its original is removed from storage once it is ready. Delete it,
and check that its text, chunks and embeddings no longer exist. Delete a source while its ingestion runs, and check that
the job ends as cancelled and leaves nothing behind. Delete a threat model with three sources, and a project whose threat
models have sources, and check that none of their originals remain in storage. Make storage fail to remove a file, and check that Scrylux removes it later, once
storage works again.

**Acceptance Scenarios**:

1. **Given** a source, **When** a signed-in person deletes it, **Then** its original, extracted text, chunks and
   embeddings are removed (FR-053).
2. **Given** a source whose ingestion is waiting or running, **When** it is deleted, **Then** its job ends as
   cancelled and writes nothing more (FR-044).
3. **Given** a threat model with sources, **When** it is deleted, **Then** every one of its sources is removed as in
   scenario 1, together with its jobs and their usage records (FR-054).
4. **Given** storage that fails when an original is removed, **When** the source is deleted, **Then** the deletion
   succeeds for the person, and Scrylux keeps trying to remove the original until it is gone (FR-055).

---

### User Story 5 - Ingestion fails cleanly and can be retried (Priority: P2)

A source that cannot be read (an encrypted PDF, a PDF with no text layer, a damaged file, a file that is too large once
unpacked, text that is not valid UTF-8) ends as failed with a fixed message that says what to do. A source whose
ingestion failed for a reason that may pass (the embedding provider was down, the job's cap was reached) can be retried
by a person. A failed source never shows a part of its chunks as if they were all of them.

**Why this priority**: Real design documents are messy. A person needs to know whether to fix the document, wait, or
ask the operator. It is P2 because US1 to US4 already deliver ingestion for well-formed documents.

**Independent Test**: Upload an encrypted PDF, a scanned PDF with no text, a damaged `.docx` and a `.docx` that unpacks
past the limit, and check that each ends as failed with its own message and that no chunk of it can be read. Run an
ingestion against a simulated embedding provider that is unavailable on every attempt, and check that the source fails
as "provider unavailable", shows no chunks, and that retrying it after the provider recovers makes it ready with each
chunk stored once.

**Acceptance Scenarios**:

1. **Given** a file that cannot be read for a reason the person must fix, **When** it is ingested, **Then** the source
   ends as failed with that reason's fixed message and hint, and is not retried (FR-012, FR-013).
2. **Given** an ingestion that failed after its job's runs (Milestone 2), **When** a person retries the source, **Then**
   a new ingestion job is queued for it (FR-045).
3. **Given** an ingestion that ended as "cap reached", **When** a person tries to retry it before the operator raises
   the caps, **Then** retrying is not offered and the API refuses it, so a retry does not spend again on a failure that
   would repeat (FR-045).
4. **Given** any failed or running ingestion, **When** its chunks are read, **Then** none are returned until all of
   them are stored (FR-024).
5. **Given** an ingestion that runs again after a lost or failed run, **When** it finishes, **Then** each chunk exists
   once (FR-024).

---

### User Story 6 - Keep embeddings in step with the configured model (Priority: P2)

An operator changes the embedding model, or removes the embedding provider after sources were added. Sources whose
chunks have embeddings from another model say so. A person refreshes their embeddings, which keeps every chunk's
identifier and text and only replaces its embedding. Embeddings from two different models are never compared with each
other. With no embedding provider configured, existing sources stay readable, and adding or refreshing waits until one
is configured again.

**Why this priority**: Milestone 1 lets each embedding record its model and dimension and left to this milestone what
to do with embeddings from an earlier one. Mixing embeddings from two models, or of two sizes, gives retrieval results
that look valid and are not. It is P2 because an install that never changes its embedding model never meets it.

**Independent Test**: Ingest a source with one simulated embedding model, change the configured model, and check that
the source says its embeddings are out of date. Refresh it, and check that every chunk keeps its identifier and text and
now has an embedding from the new model. Remove the embedding provider, and check that the source can still be opened
with its chunks, and that adding and refreshing are not offered.

**Acceptance Scenarios**:

1. **Given** a source with embeddings from a model other than the configured one, **When** it is listed or opened,
   **Then** it says its embeddings are out of date (FR-033).
2. **Given** such a source, **When** a person refreshes its embeddings, **Then** a job replaces each chunk's embedding
   and changes no chunk's identifier or text (FR-034).
3. **Given** embeddings from two models, or of two dimensions, **When** Scrylux stores or reads them, **Then** they
   are never compared with each other (FR-032).
4. **Given** sources on an install whose embedding provider was removed, **When** they are opened, **Then** their
   chunks can be read, and adding or refreshing a source is not offered (FR-033, FR-047).

---

### User Story 7 - An operator upgrades to this release (Priority: P2)

An operator upgrading a v0.1 or Milestone 2 install follows the upgrade notes: the database now needs the vector
extension, so they switch to a database image that has it, or enable it on their managed database, and choose where
originals are stored, a local volume the app and the worker share or an S3-compatible service. A database without the
extension stops the upgrade with a message that names the extension and points to the notes, instead of a half-applied
schema.

**Why this priority**: plan.md chose PostgreSQL with pgvector. The shipped database image does not include it, so every
install has to change something to upgrade. An upgrade that fails with an unclear error, or that loses the existing
data volume, would cost an operator their threat models.

**Independent Test**: Run the migrations against a database without the vector extension available, and check that they
stop before changing anything with a message that names the extension, and against one where the database user may not
enable it, and check that the message says so. Upgrade a database volume created by the v0.1 compose file by following
the upgrade notes, and check that every existing threat model is intact, that the database's own index check finds no
invalid index, and that the migrations complete. Start the app and the worker with no storage settings and check that
the documented default works in both compose files. Configure an S3-compatible service (simulated in the tests) and
check that ingestion stores and removes originals there.

**Acceptance Scenarios**:

1. **Given** a database without the vector extension, **When** the migrations run, **Then** they stop before applying
   this milestone's changes, with a message that names the extension and the upgrade notes (FR-091).
2. **Given** a v0.1 database volume, **When** the operator follows the upgrade notes, **Then** the upgrade keeps all
   existing data, its indexes stay valid, and the migrations complete (FR-082, FR-092).
3. **Given** the shipped compose files, **When** they are started with no storage settings, **Then** the app and the
   worker share the default storage and ingestion works (FR-050, FR-051).
4. **Given** a storage setting that is missing or malformed, **When** the app or the worker starts, **Then** it refuses
   to start with a message that names the setting and never its value (FR-052).
5. **Given** an S3-compatible service configured for both the app and the worker, **When** sources are added and
   deleted, **Then** their originals are stored in it and removed from it (FR-050).
6. **Given** no worker and no provider, **When** a person uses Scrylux's v0.1 features, **Then** they work as in v0.1
   (FR-093).

---

### User Story 8 - Ingestion is in Scrylux's own threat model (Priority: P2)

A reviewer reads Scrylux's threat model and finds sources as a current asset, the routes that add, list, read and
delete them, the boundary through which untrusted document content now enters Scrylux, the outbound provider boundary
now carrying user content, the stored originals and wherever they are kept, and how each risk is handled.

**Why this priority**: Principle V requires the Threat Model section, and `docs/threat-model/`, to be updated in the
same change that adds an asset, an entry point or a trust boundary. This milestone adds all three, and it turns the
planned inbound boundary for document content into a current one.

**Independent Test**: Read the Threat Model section and the committed threat model after the change, check that each
item of FR-080 is there, and that the threat model's checks pass on the pull request.

**Acceptance Scenarios**:

1. **Given** the change, **When** the constitution's Threat Model section is read, **Then** it lists the items of
   FR-080.
2. **Given** the change, **When** `docs/threat-model/` is checked on the pull request, **Then** it matches the section
   and its checks pass.

---

### Edge Cases

- **A file named as one type that is another.** The type comes from the file's content, not its name or the type the
  browser claims. A `.pdf` that is an executable is refused when it is uploaded. A `.docx` that is a `.docm` with macros
  is a valid archive that only reading it tells apart, so the worker fails it as "unsupported type" (FR-003).
- **A scanned PDF.** A PDF with no text layer fails as "no text found", with a hint that this release does not read
  text from images. Reading text from images is not part of this milestone.
- **A PDF with some pages of text and some scanned.** The text pages are ingested. The source says how many pages had
  no text, so a person knows that part was missed (FR-014).
- **An encrypted or password-protected file.** An encrypted Word file is refused when it is uploaded, because its first
  bytes show it (FR-003). An encrypted PDF fails as "encrypted" when the worker reads it. Both answers hint to upload an
  unprotected copy. Scrylux never asks for a password.
- **A file that unpacks to far more than its size.** A `.docx` is a compressed archive. Unpacking stops at a limit and
  the source fails as "too large once unpacked", so a small upload cannot exhaust the worker (FR-011).
- **A file that takes too long or too much memory to read.** Extraction stops at a time and size limit and the source
  fails as "could not be read within the limits", naming the time or the memory limit, without stopping the worker or
  its other jobs (FR-011).
- **A text file that is not UTF-8.** It is refused when uploaded, with a hint to save it as UTF-8. Scrylux does not
  guess encodings.
- **An empty file, or a file whose text is only whitespace.** It is refused when uploaded, or fails as "no text found"
  when the emptiness shows only after extraction.
- **The same document twice.** A file whose content matches a source already on the same threat model is refused, and
  the answer names that source, so its text is not embedded and paid for twice (FR-006). The same file on two threat
  models is two sources.
- **Text past the extracted-text limit.** A source whose extracted text passes the limit fails as "too large", and the
  message names the limit. Scrylux never ingests a cut-down part of a document as if it were all of it (FR-005).
- **Embedding provider not configured.** Adding a source is not offered, and the page says that adding documents needs
  an embedding provider. This holds on an install with generation only (FR-030).
- **Embedding provider removed after sources were added.** Existing sources and their chunks stay readable. Adding,
  retrying and refreshing are not offered until one is configured. An ingestion queued before the change fails as "not
  configured" when it runs and is not retried (Milestone 2), and can be retried once a provider is configured again.
- **A source deleted while its job runs.** The job is cancelled. A run that was already writing stops, and nothing it
  wrote remains (FR-044).
- **A threat model deleted while its sources are ingested.** As above, for every source. The originals are removed
  even though the database rows are gone (FR-054, FR-055).
- **Storage unavailable.** An upload that cannot be stored is refused with a message that says storage is unavailable,
  and no source is created. An original that cannot be read when its job runs fails the run as "storage unavailable",
  which may pass and is retried like "provider unavailable".
- **Storage that holds files Scrylux no longer needs.** A crash between storing a file and recording its source,
  between deleting a source and removing its file, or between a source becoming ready and removing its file, can leave
  a file behind. Scrylux finds and removes such files, so no original outlives its need by more than a bounded time
  (FR-055, FR-057).
- **A ready source after the embedding model changes.** Refreshing works from the stored chunks, not from the original,
  which is gone once the source is ready (FR-034, FR-057).
- **An embedding model with a different dimension.** Embeddings of any dimension that the configured model produces
  are stored. Embeddings of two dimensions never meet in one comparison (FR-032).
- **A new embedding model with a smaller input limit.** Chunks keep their fixed size (FR-020). A model that refuses
  one fails the refresh as "input too large", with a hint that this model does not accept Scrylux's chunk size, and the
  source keeps its earlier embeddings, marked out of date. Retrying is offered only once the configured model changes.
- **A job cancelled from the Jobs page.** Cancelling an ingestion job there does not delete its source. The source
  ends as failed with "cancelled", shows no chunks (or keeps its earlier embeddings, for a refresh), and can be retried
  (FR-045).
- **The database image changes its C library.** The shipped database image is Alpine-based. If the image with the
  vector extension uses another C library, the text sort order on an existing data volume can change underneath it,
  and indexes on text columns can go wrong without an error. The upgrade notes say how to keep them valid, and the
  upgrade test checks the indexes, not only the rows (FR-082, FR-092).
- **An embedding that comes back wrong.** A batch whose vectors do not match the chunks sent, or vary in size, fails as
  "rejected" (Milestone 1), and nothing of it is stored.
- **The worker's settings differ from the API's.** Whether embeddings run, and with which model, follows the worker's
  settings, because the worker makes the requests (Milestone 2). The API's settings decide what the notice says, so the
  operator's guide says to give both processes the same provider settings, as it already does.
- **Many sources from one account.** Any signed-in account can add sources, and each embedding spends on the provider.
  The per-threat-model source limit, the duplicate check, the size limits, the per-job caps and the per-account limit on
  active ingestion jobs bound it. Ingestion has no cooldown of its own (FR-043, FR-046). Any account can create more
  accounts and threat models, so the install's document space (FR-009) is what bounds storage. One account can fill it
  and stop others adding documents until an operator acts. That remains open until Phase 6's roles and rate limiting,
  and the threat model says so (FR-080).
- **The document space is full.** Adding a source is refused with a message that says so. Sources already added keep
  working. Deleting sources frees space at once (FR-009).
- **A person who is not the one who added it.** Any signed-in person can see, retry and delete any source, as any
  signed-in person can change any threat model today (FR-065).
- **An exported or reported threat model.** Exports, imports and reports (Phase 2 Milestones 5 and 6) do not include
  sources, their text or their chunks in this milestone. A threat model that is exported and imported elsewhere arrives
  with no sources (FR-067).
- **Prompt injection in a document.** A document may hold text written to steer a model. Nothing in this milestone
  sends a source to generation. The text goes only to embeddings, which follow no instructions. It is stored as
  untrusted input and shown as text (FR-066). Delimiting it in prompts is Milestone 4's, under Principle VI.

## Requirements *(mandatory)*

### Functional Requirements

**Sources**

- **FR-001**: A source MUST belong to exactly one threat model. Any signed-in person MUST be able to add a source to a
  threat model by uploading a file or by pasting text.
- **FR-002**: An uploaded source MUST be a `.md`, `.txt`, `.pdf` or `.docx` file. Pasted text MUST have a title of 1 to
  200 characters and is ingested as plain text. A source MUST record: its identifier, its threat model, its name (the
  file's name or the pasted title), its type, its size, a digest of its content, who added it and when, its status, and,
  once ready, its text's length, its chunk count, and the embedding model and dimension of its chunks.
- **FR-003**: A file's type MUST be determined from its content, and MUST agree with its name's extension. A file whose
  first bytes are not those of one of the four types, or do not match its extension, MUST be refused when it is
  uploaded, as MUST the older Word format (`.doc`) and an encrypted Word file, whose first bytes show them. The API reads
  no more of a file's structure than that (FR-010). An Office file with macros (`.docm`), which only reading its
  structure tells apart, MUST be failed by the worker as "unsupported type" and not retried (clarified at planning).
  Text files (`.md`, `.txt`, pasted text) MUST be valid UTF-8 and MUST be refused otherwise.
- **FR-004**: An upload MUST be refused, before more than the limit is received and with nothing stored, when it is
  larger than the upload size limit: 10 MB by default, which the operator can change. Pasted text has the same limit.
  An API process MUST read at most 4 uploads or pastes at once. One more MUST be refused as busy, with nothing stored
  and an answer that says when to try again. The UI MUST send several files one at a time, so a person adding several
  never meets this refusal (clarified at planning).
- **FR-005**: A threat model MUST have at most a set number of sources: 20 by default, which the operator can change.
  A source's extracted text MUST be at most a set length: 1,000,000 characters by default, which the operator can
  change. A source past that length MUST fail as "too large", never be cut down. The default text length and the
  default caps (FR-042) MUST be chosen together so that a source at the largest default size can be ingested under the
  default caps when the provider answers on its first attempt.
- **FR-006**: A file or text whose content digest matches a source already on the same threat model MUST be refused,
  and the answer MUST name that source.
- **FR-007**: A source's status MUST be one of: waiting, processing, ready, failed. A ready source MUST also show
  whether its embeddings are from the configured model or from another one, or that no embedding provider is
  configured (FR-033).
- **FR-008**: A file name or a pasted title MUST be kept only as a display name. It MUST NOT be used to name the stored
  original, a path or a storage key (FR-050).
- **FR-009**: The install MUST have a document space: a cap on the total size of all sources, 2 GB by default, which the
  operator can change (clarified 2026-11-01). A source counts its upload size while it is waiting, processing or failed,
  and what it stores once it is ready: its extracted text and its embeddings, at 4 bytes per dimension per chunk
  (clarified at planning). An add that would take the total past the cap MUST be refused, with nothing stored and a
  message that the install's document space is full and that an operator can raise it or sources can be deleted. When a
  source is about to become ready, or its embeddings are about to be replaced, the worker MUST check again, and if the
  ready sources would then pass the cap, the job MUST fail as "document space full", writing nothing, so that ready
  sources never take the total past the cap. That failure may be retried. The API MUST check this setting when it
  starts: a zero, negative or malformed value stops it from starting. The documentation MUST say how much text a full
  document space holds for the documented embedding models.

**Text extraction**

- **FR-010**: The text of a source MUST be extracted by the worker, never by the API process, so that reading
  untrusted files never runs in the process that serves requests.
- **FR-011**: Extraction MUST be bounded: in time, in the memory it may use, in the size a compressed file may unpack
  to, and in the number of pages of a PDF, each with a documented default. Passing a bound MUST fail the source with a
  category that names it, and MUST NOT stop the worker or its other jobs.
- **FR-012**: Extraction MUST NOT run code, macros, scripts or embedded objects held in a file, follow links or fetch
  anything a file refers to.
- **FR-013**: A source that cannot be read MUST fail with one of these categories, each with a fixed message and a hint
  kept as versioned data (Principle IV): unsupported type, encrypted, damaged, no text found, too large, too large once
  unpacked, could not be read within the limits (of time or of memory, named in the message), storage unavailable; and
  a source that would pass the document space fails as
  "document space full" (FR-009). Only "storage unavailable" may pass, and is retried as
  Milestone 2's transient failures are. The others end the job at once. This milestone adds these categories, and
  "cancelled" for a source, to Milestone 2's list of failure categories with fixed messages (M2 FR-064), and adds
  "storage unavailable" to its list of failures that run a job again (M2 FR-020).
- **FR-014**: Extraction MUST keep the text of a document in reading order, including the text of tables and lists.
  Images are not read. A PDF source MUST record how many of its pages had no text.

**Chunks**

- **FR-020**: A source's extracted text MUST be split into chunks of at most one fixed, documented size, the same for
  every source and every embedding model, so that chunks do not depend on the model configured when they were made and
  can be embedded again by another (FR-034). The plan sets the size small enough for the embedding models Scrylux
  documents to accept a chunk whole. A chunk MUST never be cut down when it is embedded. A model that refuses a chunk as
  too large fails the job as "input too large" (Milestone 1), and the hint says that this embedding model does not
  accept Scrylux's chunk size.
- **FR-021**: Every character of the extracted text MUST belong to exactly one chunk: chunks are consecutive, with no
  overlap, each recording where it starts and ends in the extracted text, so that reading them in order gives the whole
  text back exactly (clarified at planning).
- **FR-022**: Each chunk MUST record: its identifier, its source, its position in the source, its text, and where it
  came from in the original: the page or pages for a PDF; the first and last line for a text-based source (`.txt`,
  `.md`, pasted text), counted in the text as received; and the nearest heading for Markdown and `.docx` where there is
  one (clarified 2026-11-01).
- **FR-023**: A chunk's identifier and text MUST never change once its source is ready, and a chunk MUST exist until its
  source is deleted. Later milestones cite chunks by identifier (plan.md, Milestones 4 and 7). Refreshing embeddings
  (FR-034) MUST NOT change them. Scrylux MUST NOT offer to extract a ready source's text again in this milestone: a
  document read differently is added as a new source.
- **FR-024**: A source's chunks MUST become readable all at once, with their embeddings, when the source becomes ready.
  A source that is waiting, processing or failed MUST show no chunks. An ingestion that runs again after a lost or
  failed run MUST NOT duplicate a chunk (M2 FR-014).

**Embeddings**

- **FR-030**: Ingestion MUST require a configured embedding provider (clarified 2026-11-01; Milestone 1 left this to
  Milestone 3). With none configured, whether or not generation is, adding, retrying and refreshing a source MUST NOT be
  offered, the API MUST refuse them, and the UI MUST say that adding documents needs an embedding provider. A source becomes ready only when every
  one of its chunks has an embedding.
- **FR-031**: Each chunk's embedding MUST be stored with the model and the dimension that produced it (Milestone 1).
  Embeddings MUST be requested through Scrylux's provider layer only (Principle VI) and by the worker only (M2 FR-070).
- **FR-032**: Embeddings from two models, or of two dimensions, MUST never be compared with each other. Scrylux MUST be
  able to store embeddings of the dimension any supported embedding model produces.
- **FR-033**: A ready source whose chunks have embeddings from a model other than the configured one MUST say that its
  embeddings are out of date. With no embedding provider configured, a ready source MUST stay readable, with its chunks.
- **FR-034**: A signed-in person MUST be able to refresh the embeddings of such a source. Refreshing MUST run as a job,
  replace every chunk's embedding with one from the configured model, and change no chunk's identifier or text. Until it
  succeeds, the source keeps its earlier embeddings and says they are out of date.
- **FR-035**: Every source MUST be embedded, whatever its size. Whether a later feature sends a threat model's full text
  or only the chunks most relevant to a request is that feature's decision (plan.md's "for small inputs, skip
  retrieval", Milestone 4). This milestone ships no way of choosing chunks: its only user would be Milestone 4, and code
  with no user is not shipped (Principle III). The ordered chunks (FR-021) and their embeddings (FR-031) are what that
  choice needs.

**Ingestion jobs**

- **FR-040**: Ingesting a source and refreshing its embeddings MUST run as Milestone 2 jobs, of kinds that ship with
  Scrylux, and MUST meet Milestone 2's requirements for every job kind (M2 FR-011 to FR-066). The progress steps of
  ingestion are extract, chunk and embed. The embed step's size is the number of chunks, so progress shows how many are
  done.
- **FR-041**: An ingestion job MUST belong to its source's threat model. The job's input MUST refer to its source by
  identifier only, never hold the source's content or name (M2 FR-051).
- **FR-042**: Ingestion jobs MUST be bounded by the per-job token and cost caps (M2 FR-040 to FR-044). An ingestion
  that reaches a cap MUST fail as "cap reached" with no chunks readable (FR-024), and can be retried (FR-045).
- **FR-043**: Ingestion jobs (ingesting and refreshing) MUST NOT count toward Milestone 2's limit on queued or running
  jobs per account (M2 FR-046), and that limit's jobs MUST NOT count toward this one. One account MUST be able to have
  at most a set number of ingestion jobs queued or running at once: 20 by default (the default number of sources per
  threat model, FR-005), which the operator can change. An add, retry or refresh beyond it MUST be refused with an
  answer that says why, and an upload refused this way MUST leave nothing stored. The API MUST check this setting when
  it starts: a zero, negative or malformed value stops it from starting (clarified 2026-11-01).
- **FR-044**: Deleting a source MUST cancel its waiting or running jobs (M2 FR-030). A cancelled ingestion MUST leave no
  chunk or embedding of its run behind. An ingestion job cancelled any other way, such as from the Jobs page, MUST NOT
  delete its source: the source MUST end as failed with "cancelled", and a cancelled refresh leaves the source ready
  with its earlier embeddings.
- **FR-045**: A signed-in person MUST be able to retry a failed source and a failed refresh. Retrying MUST queue a new
  job with fresh caps. Retrying MUST NOT be offered, and the API MUST refuse it, in three cases: for a failure that a
  person must fix in the document (FR-013: unsupported type, encrypted, damaged, no text found, too large, too large
  once unpacked); for "cap reached" until the operator's caps are higher than those of the job that reached them; and
  for "input too large" until the configured embedding model changes. So a retry never spends a new budget on a failure
  that is certain to repeat. Every other outcome may be retried, including "not configured", "not authorized" and "not
  available" once the operator has fixed the setting, and "cancelled", "timed out" and "worker lost".
- **FR-045a**: Ingestion and refresh jobs MUST be queued only through the source routes (FR-060), which apply the
  checks of FR-003 to FR-006, FR-009, FR-030 and FR-043. Milestone 2's route that starts a job MUST refuse these kinds.
- **FR-046**: Ingestion MUST NOT have a per-account cooldown of its own (M2 assumptions, "later job kinds decide"). It
  is bounded by the source limit per threat model, the duplicate check, the size limits, the install's document space
  (FR-009), the per-job caps and the limit on active ingestion jobs per account (FR-043), and the threat model MUST say
  so (FR-080).
- **FR-047**: Ingestion and refreshing are job kinds that call a model, so Milestone 2's rule for such kinds (M2 FR-063)
  covers them, with the embedding provider as the provider they need. What is offered without one is FR-030's rule.

**Storage**

- **FR-050**: Originals MUST be stored through a storage abstraction, never at an absolute local path (Principle IV),
  named by an identifier Scrylux generates. This milestone MUST ship two backends, chosen per install by the operator: a
  local volume (the default) and an S3-compatible service (clarified 2026-11-01). Both MUST pass the same tests, the
  S3-compatible one against a simulated service, with no real account and no repository secret (FR-083).
- **FR-051**: The app (which stores uploads) and the worker (which reads them) MUST share the storage. Both shipped
  compose files MUST configure a local volume that both services use, with a default that works without further
  settings. With the S3-compatible backend, the app and the worker MAY run on separate hosts.
- **FR-052**: Storage settings MUST be checked when the app and the worker start. A missing or malformed setting MUST
  stop them, with a message that names the setting and never its value. The S3-compatible service's credentials are a
  secret (Principle I): they MUST come from the environment or the secrets manager, or from the platform's role where
  the service offers one, and MUST never be logged, stored in the database or sent to the browser.
- **FR-053**: Deleting a source MUST remove its original from storage, if it still has one (FR-057), and its extracted
  text, chunks and embeddings from the database.
- **FR-054**: Deleting a threat model, or a project with its threat models, MUST delete their sources as FR-053 says,
  and their jobs with their usage records (M2 FR-052).
- **FR-055**: An original whose source no longer exists, or is ready (FR-057), MUST be removed within a bounded time,
  documented for the operator, including when its removal failed at first or a crash left it behind. Scrylux MUST NOT
  need to keep the original of a deleted source in order to finish that removal.
- **FR-056**: A waiting, processing or failed source keeps its original, so it can be ingested or retried. A refused
  upload (FR-003 to FR-006, FR-009) MUST leave nothing in storage.
- **FR-057**: When a source becomes ready, its original MUST be removed from storage (clarified 2026-11-01). Nothing in
  this milestone reads an original after that: refreshing embeddings works from the stored chunks (FR-034), and the
  original is never returned (FR-068) or read again (FR-023). A ready source MUST NOT depend on its original.

**API and UI**

- **FR-060**: A signed-in person MUST be able to add a source by upload or by paste, list a threat model's sources,
  open one with its chunks, retry one, refresh its embeddings, and delete one. These MUST be routes under `/api/v1`,
  need sign-in, check their input at the boundary (with the shared schemas where the input is JSON), answer errors in
  the API's usual form, and appear in the generated OpenAPI document.
- **FR-061**: Each add, retry, refresh and delete MUST log one line: who, what, which source and threat model, and the
  source's type and size. No line may hold a source's name, its text, a chunk or an embedding (Principle IV).
- **FR-062**: Sources MUST be shown on the threat model's page, with each source's name, type, size, who added it,
  when, its status, its progress while ingestion runs, its chunk count and embedding state when ready, and, when
  failed, its fixed message and hint.
- **FR-063**: While a source shown on screen is waiting or processing, the page MUST show its changes within 5 seconds,
  without a reload, and MUST stop asking once none is. This extends Milestone 2's rule that only the Jobs page shows or
  asks for job changes (M2 FR-061a) to a threat model's sources. Ingestion jobs also appear on the Jobs page.
- **FR-064**: When no worker is alive and a source is waiting, the sources list MUST say that no worker is processing
  them (M2 FR-062).
- **FR-065**: Any signed-in person MUST be able to see, retry, refresh and delete every source, not only their own.
  This is in line with what any account can do to a threat model today, until Phase 6 brings roles.
- **FR-066**: A source's name, extracted text and chunks MUST be shown as text, never rendered as Markdown, HTML or any
  other markup (Principle VI).
- **FR-067**: Exports, imports and reports (Phase 2 Milestones 5 and 6) MUST NOT include sources, their text or their
  chunks in this milestone, and their documentation MUST say so.
- **FR-068**: The API MUST NOT return a source's original file in this milestone. A person reads what was extracted
  from it (FR-062, US3).

**The notice that data leaves the install**

- **FR-070**: The form where a source is added MUST show, before it can be submitted, for each configured operation
  that can send a source's text out (embeddings in this milestone), whether it is hosted or local (Milestone 1), and,
  when any is hosted, that the text leaves the install and to which provider. It MUST be shown on every visit, not once.
- **FR-071**: When generation is configured and hosted, the form MUST also say that the AI features of later
  milestones send a source's text outside the install, so the notice does not need to change silently when they ship.
- **FR-072**: The threat model's sources list MUST repeat the notice while a hosted provider is configured. With only
  local providers configured, the form MUST say that the text stays in the install.

**Threat model and documentation**

- **FR-080**: The constitution's Threat Model section and `docs/threat-model/` MUST be updated in the same change
  (Principle V), as a MINOR amendment with its Sync Impact Report, to list: sources, their originals, extracted text,
  chunks and embeddings as current assets, and the two places originals can be stored, with the S3-compatible service's
  credentials as a new secret held by the app and the worker; the new entry points (adding, listing, reading, retrying,
  refreshing and deleting sources); the inbound boundary for untrusted document content as current, not planned, with
  the worker as the only process that reads untrusted files (FR-010); the outbound provider boundary as now carrying
  user content, with the notice (FR-070) and the "accepted for this milestone" disclosure item moved to its new status;
  and the risks with their handling: a malicious or malformed file (FR-003, FR-011, FR-012), confidential data that
  outlives its deletion or its need (FR-053 to FR-057), runaway embedding spend (FR-042, FR-043, FR-046, and what stays
  open until Phase 6), storage exhaustion (FR-009, and that one account can fill the document space for everyone until
  Phase 6), and prompt injection held in a stored document (untrusted until Milestone 4 delimits it).
- **FR-081**: Every setting this milestone adds MUST be documented in the environment-variable table in
  `docs/install.md`, with which process reads it.
- **FR-082**: The upgrade notes MUST say how to move an existing install to a database that has the vector extension:
  with the shipped compose files, keeping the existing data volume, and on a managed database. If the new database image
  uses another C library than the current Alpine-based one, the notes MUST say how to keep text indexes valid on an
  existing volume, or the shipped image MUST use the same C library.
- **FR-083**: The tests MUST run without any real provider and without any repository secret, using simulated provider
  responses (M2 FR-082), and against a database that has the vector extension, in CI as on a developer's machine.

**The database**

- **FR-090**: Embeddings MUST be stored in Scrylux's existing database, with no new service (plan.md). Every table this
  milestone adds MUST be created by forward-only migrations (Principle IV).
- **FR-091**: The migrations MUST check that the vector extension can be enabled before applying this milestone's
  changes, and MUST stop with a message that names the extension and the upgrade notes if it cannot, leaving the
  database as it was. The message MUST tell apart a database that does not have the extension from one that has it but
  where Scrylux's database user may not enable it, which is common on managed databases, and say what to do for each.
- **FR-092**: The shipped compose files and CI's database MUST use a database image that has the vector extension, of
  the same major version as before, so an existing data volume can be kept.
- **FR-093**: Every v0.1 flow MUST keep working with no worker running and with no provider configured (M2 FR-072). An
  install's database MUST have the vector extension from this release on, whether or not it uses AI, and the release
  notes MUST say so.

### Key Entities *(include if feature involves data)*

- **Source**: one design document added to a threat model, uploaded or pasted. Its name, type, size, content digest,
  who added it and when, its status, and once ready its text length, chunk count, pages with no text, and embedding
  state. Deleted with its threat model.
- **Original**: the uploaded file or pasted text as it was received, kept through the storage abstraction (a local
  volume or an S3-compatible service) under a generated identifier while its source is waiting, processing or failed,
  and removed once the source is ready or deleted.
- **Extracted text**: the text read from an original, in reading order, held only as its chunks.
- **Chunk**: one part of a source's extracted text, with a permanent identifier, its position, its text and where it
  came from in the original (pages, lines, heading). The unit that later milestones cite.
- **Embedding**: a vector for one chunk, with the model and dimension that produced it. Replaced when refreshed, never
  compared with one from another model or of another dimension.
- **Ingestion job**: a Milestone 2 job that extracts, chunks and embeds one source, or refreshes its embeddings. It
  belongs to the source's threat model and refers to the source by identifier only.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With no provider configured and no worker running, the full v0.1 and Milestone 2 test suites, including
  the browser tests, pass, and `/health` answers as before.
- **SC-002**: A test PDF at the largest default sizes (10 MB uploaded, 1,000,000 characters of text) becomes ready
  within 5 minutes of upload, against simulated provider responses and under the default caps (FR-005): in CI on every
  pull request, and on the smallest host the deployment guide names in the manual run before release.
- **SC-003**: For 100% of the test documents, reading a ready source's chunks in order gives back its whole extracted
  text, every chunk of a PDF names its page, and every chunk of a text-based source names lines that hold its text.
- **SC-004**: 100% of the malformed test files (wrong type behind a right extension, encrypted, scanned, damaged, past
  the unpack limit, past the time limit) are refused or fail with their own category, leave no readable chunk, and leave
  the worker running its other jobs.
- **SC-005**: After a source becomes ready, or a source or a threat model is deleted, 0 of its originals remain in
  storage once the documented removal time has passed, including when the first removal attempt failed.
- **SC-006**: Across lost runs, failed runs, retries and refreshes, 0 sources have a duplicated chunk, and 0 chunks
  change identifier or text.
- **SC-007**: In 100% of the tests that change the configured embedding model, every chunk of a ready source has a
  vector of the source's recorded dimension from its recorded model, before a refresh, after one that succeeds, and after
  one that fails or is cancelled. No source ever holds vectors of two models or two dimensions.
- **SC-008**: A recognizable fake document text, fake file name and fake key, run through every ingestion outcome,
  appear in 0 log lines, job records, usage records, failure messages or API error answers, apart from the refusal of a
  duplicate, which names the source already added (FR-006). The text and name appear only in the source's own record,
  its chunks and the pages that show them.
- **SC-009**: In 100% of browser tests with a hosted provider configured, the notice that data leaves the install is on
  screen before a source can be submitted, and with only local providers it says the text stays in the install.
- **SC-010**: A migration run against a database without the vector extension changes 0 tables and names the
  extension, and an upgrade of a v0.1 data volume by the upgrade notes keeps 100% of its threat models with 0 invalid
  indexes.
- **SC-011**: The updated threat model passes its pull-request checks, and a reviewer can find sources, their storage,
  the new routes, the inbound boundary and the notice in both the constitution and `docs/threat-model/`.
- **SC-012**: In 100% of tests, an ingestion or refresh kind started through Milestone 2's job route is refused, and a
  retry of "cap reached" with unchanged caps, or of a failure the document causes, is refused with no job queued.
- **SC-013**: In 100% of tests, an add that would take the install past its document space is refused with nothing
  stored, and the ready sources' total, text and embeddings counted, never exceeds the cap.

## Assumptions

- **Sources belong to threat models.** A design document describes a system, and a threat model is Scrylux's record
  of one. A project-wide library of documents shared by several threat models is not part of this milestone.
- **One source per document.** A file is one source. Splitting a file into several sources, or merging several, is not
  offered.
- **No reading text from images.** Scanned PDFs and the images inside documents are not read in this milestone. plan.md
  keeps a Python parsing service as an open decision, to revisit only if Phase 3 evals show document extraction is the
  quality bottleneck.
- **Every source is embedded.** Ingestion requires an embedding provider (clarified 2026-11-01). Embedding only threat
  models too large to send whole would need Scrylux to know, when one source is added, how large the whole set will be
  and which model will read it. Embedding every source costs little next to generation, it means Milestone 4 can always
  retrieve, and the notice tells the person their text goes to the embedding provider (FR-035). An install that runs
  generation only, for example on Ollama, adds a local embedding model to add documents.
- **No choosing of chunks in this milestone.** The rule that small inputs skip retrieval and send the full context is
  read as a requirement on what ingestion stores, so Milestone 4 can do either. Milestone 4 owns the choice, its tests
  and its eval (FR-035).
- **No download of originals, and no keeping them.** A person sees the extracted text. Serving untrusted files back to
  the browser is a new risk with no user in this milestone (FR-068), and an original is deleted once its source is
  ready (FR-057). If a later milestone wants to read documents again, for example with a better reader, it adds them
  again or changes this rule.
- **Display notice, not a confirmation.** plan.md says the UI shows that data leaves the install. A notice shown on the
  form before submitting, every time, satisfies it. A confirmation that a person must tick is not required, and adding
  one would change no stored record.
- **The defaults chosen here** are adjustable in the plan if research shows a reason: 10 MB per upload, 20 sources per
  threat model, 1,000,000 characters of extracted text per source, 20 active ingestion jobs per account, a 2 GB document
  space per install, and the extraction bounds of FR-011. The plan sets the chunk size and confirms that the default
  caps (500,000 tokens and $5 per job, Milestone 2) fit a source of the largest default size (FR-005). If they do not,
  the plan changes the default text length or the default caps, and the documentation says which.
- **pgvector is required.** plan.md chose PostgreSQL with pgvector for embeddings. Managed databases such as Amazon RDS
  offer the extension. The shipped database image changes to one that has it.
- **Moving heavy v0.1 operations to the worker.** As in Milestone 2, this milestone moves no v0.1 operation to the
  worker.
