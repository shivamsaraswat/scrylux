# Contract: the Draft tab

## `/threat-models/:id/draft` (a tab after Sources)

From top to bottom:

1. **`ExtractionNotice`**, on every visit, while a generation provider is configured (FR-070, FR-071; research #15).
2. **The start control**
   - "Start extraction" when `ExtractionStatus.start.offered`. When a draft exists, the text beside it says that the
     new draft will replace this one when it succeeds (FR-052).
   - On the retrieval path, it says that the sources are larger than the budget, and that Scrylux will choose the
     chunks most relevant to a system model.
   - When not offered, the reason's message in place of the button: no generation provider, sources still processing
     (listing them by name, from the sources the page already has), no ready source, embeddings out of date, or a
     failure that would repeat.
3. **The extraction's progress**, while queued or running: the step, the job's link on the Jobs page, Milestone 2's
   "no worker is processing jobs" when none is alive. Polled every 2 s, and stopped when it ends (FR-063). A failed
   extraction shows its fixed message and hint above the earlier draft, which stays (FR-052).
4. **The draft**, when there is one:
   - A banner on every view: "Draft proposed by AI. It is not part of this threat model. Nothing here changes the
     threat model's diagram or threats." (FR-061).
   - What it read: "Read all 18 chunks of 3 sources" or "Read 20 of 412 chunks of 4 sources, chosen by relevance",
     with the left-out and deleted sources named, the model, the date and who started it (FR-014, FR-062).
   - "The sources have changed since this draft was made" when `sources_changed` (FR-053).
   - The diagram (research #14): read-only, fitted to view, each element and flow selectable by mouse and keyboard.
   - The list: elements by type, then assets, then assumptions, each with its name or statement; the same selection as
     the diagram.
   - The selected item's panel: its rationale; its flags, each with its value and citations; its citations. A citation
     shows the source's name, the location (page, lines, heading), the quoted passage, and a link "Open in source" to
     `/threat-models/:id/sources/:sourceId?offset=<position>`. A deleted source's citation shows "Source deleted". An item
     or flag with none left says "No remaining citation" (FR-054, FR-062).
   - "Discard draft", with a confirmation (FR-055).
   - When the draft has no item, `nothing_found` is shown instead of the diagram (FR-024).

Every text from the draft or a chunk is rendered as text, never as Markdown or HTML (FR-066).

## Changes elsewhere

- **`SourcesNotice`**: its generation sentence names extraction on the Draft tab (FR-072).
- **The source page** accepts `?offset=` and opens its chunk list at that position, the cited chunk marked.
- **The Jobs page**: the kind "System extraction", its steps and its result's counts.
- **The threat model's Diagram tab** is unchanged: it never shows the draft.
