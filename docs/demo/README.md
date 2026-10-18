# The demo threat model

**This is a fictional example. It describes an invented note-taking app, not any real system, and it is not guidance about one.**
It is here so that you can see what Scrylux does with a finished threat model before you draw your own. It is not Scrylux's own
threat model; that one is in [`../threat-model/`](../threat-model/), is accurate by design, and is held to the constitution.

The invented system: people write notes with attachments in a browser (the **Web app**), a **Notes API** in a cloud account stores them
in a **Notes database** and an **Attachment bucket** inside a private subnet, and a **Reminder worker** reads due reminders and emails
them through an **Email provider**.

## Load it

Get `notes-app.scrylux.json` from this folder, or from the **assets of a release** (it is attached to every release, so you do not need
the repository). Then, in a running Scrylux:

1. Open a project (make one if you have none), and choose **Import threat model**.
2. Pick `notes-app.scrylux.json`. The preview says **Everything in this file will be imported**, and shows what it holds.
3. Import. You get a new threat model, `Notes app (fictional demo)`, and nothing existing is changed.

Or with the API: `POST /api/v1/projects/{id}/imports/check` to preview and `POST /api/v1/projects/{id}/imports` to import, with the
body `{"format":"scrylux","file": <the file>}`. See [`API.md`](../../API.md) and [the Scrylux file](../formats/scrylux-file.md).

## What to look at

- **The diagram.** One trust boundary, *Cloud account*, holds the API and the worker, and a second, *Private subnet*, inside it, holds
  the two data stores. The flows that cross a boundary carry their security flags, and the counts on each element are its open threats.
- **A threat of each status.** Most are **open**, on purpose: this is a model in progress, as a real one usually is. A few are
  **mitigated**, with a control that is implemented or verified; two are **accepted**, each with the reason and until when; two are
  **not applicable**, each with the fact that makes it impossible.
- **The risk summary.** Risk comes from likelihood and impact, so the same list shows from Low to Critical. The flow where the worker
  reads reminders from the database is deliberately not encrypted, which is what puts the Critical ones there.
- **One threat written by hand**, *Shared note link can be guessed*, because no rule can derive it. The rest were **generated** by
  Scrylux's rules and then decided.
- **The report.** Download the Markdown report or open the print-friendly HTML one from the threat model's page.

## How it was made

It was built in a running Scrylux, through its documented API and web app: the diagram, then **Generate threats**, then a decision for the
threats chosen to show each status, then the one threat written by hand. The file is what **Download Scrylux file** writes for that threat
model, saved **unchanged**. It is not written or edited by hand, and a program checks that it is what Scrylux writes.

It holds no credential, address, personal data or name of a real deployment, company or person. Its names are generic on purpose.

## What the checks do

They live in [`apps/api/test/demo/`](../../apps/api/test/demo/) and run in the required `test` check of every pull request.

**They fail the build** when the file is not what Scrylux writes or does not match the [published schema](../formats/scrylux-file-v1.schema.json); when
Scrylux's import refuses it, leaves something out, or it does not export back to the same content; when two records could only be ordered
by their ids; when the demo lacks something it is meant to show (all five element types, a trust boundary with a flow across it, all six
STRIDE categories, every status, every mitigation state, three risk levels, both generated and hand-written threats, a reason on every
accepted or not-applicable threat, and the word *fictional* in its project and model names); when this folder holds another file; when a
file holds something that looks like a credential, an email address, an IP address or a cloud account identifier; or when **Generate
threats** flags a threat of the demo as **stale** (a rule was retired or changed so that a threat no longer matches it).

**They only warn** when **Generate threats** would **add** threats because a rule was added: the build still passes, and a warning names the
rule and the element. Bring the demo up to date in that change or a later one.

To reproduce a failure locally: `pnpm --filter @scrylux/api exec vitest run test/demo`. The message names the file, the check and the fix.

## Updating the demo

1. Start Scrylux locally (`docker compose up --build`, see the [README](../../README.md)) and sign in.
2. Create a project named `Scrylux demo (fictional)`, and **import** `notes-app.scrylux.json` into it from the project's page. Keep the
   project's name and the threat model's name, `Notes app (fictional demo)`: the checks refuse the file if either lost the word *fictional*.
3. Make the change in the editor. If the diagram changed, run **Generate threats** and decide the threats you want to show. Keep names unique
   within an element type, threat titles unique within an element and a category, and mitigation texts unique within a threat (the rules'
   own suggestions are mitigations too, so do not retype one).
4. From the threat model's page, download the **Scrylux file**, and save it over `notes-app.scrylux.json` with **no edit**.
5. Run the checks (above).
6. Commit the file with the change that needed it.

Every import gives every record a new identifier, so **every identifier in the file changes on every update**, and a diff of the file is
noisy. To review what really changed, download the Markdown report of the threat model before and after, and compare those; neither is
committed.
