# Changelog

What changed in each release of Scrylux, newest first. Versions are `MAJOR.MINOR.PATCH`; while the major version is 0, a minor release may change things that matter to you, and each entry says so under *Upgrading*. Open risks are recorded in [Scrylux's own threat model](docs/threat-model/), and a vulnerability is reported privately as [SECURITY.md](SECURITY.md) says, never in a public issue.

## [Unreleased]

### Documents in a threat model, with no AI feature yet

A threat model can now hold the design documents it was built from. Add `.md`, `.txt`, `.pdf` and `.docx` files, or paste text, on the new **Sources** tab. Scrylux reads each one, cuts its text into chunks of at most 2,000 characters and gives every chunk an embedding, which later releases will search. **Nothing is drafted from a document yet, and nothing sends a document to a generation model.** Adding a document needs an embedding provider; without one, everything else works as before.

- **Where your text goes is stated first.** Before a document can be added, the tab names the embedding provider and says the text leaves your install when that provider is hosted (and that later releases' AI features will send it to a hosted generation provider too), or that it stays when every provider is local. It says so on every visit, in the form and again above the list.
- **Read what Scrylux read.** A document's page shows its chunks in order, with their pages or lines and headings, as text; a PDF says how many pages had no text.
- **Files are read safely.** A file's type comes from its content. A PDF or Word file is read in a separate process that holds no password or key, under a time, a memory, an unpacked-size and a page limit; nothing in a file is run or fetched. A document that cannot be read says why and what to do, and **Retry** is offered only where trying again can help.
- **The original is kept only until the document is ready.** It waits on a volume or in an S3-compatible bucket (MinIO, R2, AWS S3), is deleted when the document is ready, and is never returned. Deleting a document, a threat model or a project removes its originals, text and chunks.
- **Keep embeddings in step.** After you change the embedding model, a document says its embeddings are out of date and **Refresh embeddings** replaces them without changing a chunk. A document never holds the embeddings of two models.
- **Limits you can see.** A file is at most 10 MB, a threat model holds 20 documents, an account may have 20 waiting or processing, and all documents together may take 2 GB of the database (text and embeddings counted), all settable.

### Upgrading to this release

Read [Upgrading to v0.2](docs/install.md#upgrading-to-v02) first. The short version:

- **The database image changes** from `postgres:16-alpine` to `pgvector/pgvector:0.8.7-pg16-trixie`, which is Debian-based. Keep your `pgdata` volume and back it up first. The new file does the rest, and **the first start rebuilds every text index** (a few seconds), because the two images sort text differently and the old indexes would silently return wrong answers. CI proves on a volume made by the old image that every index is repaired and no row is lost.
- **The pgvector extension is now required.** On a database you manage yourself, run `CREATE EXTENSION vector;` as an administrator if the user Scrylux connects as may not. Without it Scrylux stops at start-up and says so, and changes nothing.
- A new `storage` volume holds the originals of documents that are still being read (or point `STORAGE_BACKEND=s3` at a bucket of its own; [Storage](docs/install.md#storage) has the IAM policy for each process). Give the worker memory for reading files: 1 GiB for each at the default.
- Eighteen new environment variables, all optional, are in [Install and run](docs/install.md#environment-variables). The secrets-manager secret may also hold `STORAGE_S3_ACCESS_KEY_ID` and `STORAGE_S3_SECRET_ACCESS_KEY`; both the app and the worker hold them.
- Exports, imports and reports carry no documents.

### AI providers and a worker, with no AI feature yet

### AI providers and a worker, with no AI feature yet

This groundwork for Phase 3 adds the layer that later AI features will use to reach a language model, and the worker that will run them in the background. **Nothing in Scrylux sends your content to a model yet**, and with no AI setting made, Scrylux behaves exactly as v0.1 does.

- **Choose where the model runs**, with environment values and no code change: Anthropic, OpenAI, Azure OpenAI, Amazon Bedrock, Google Gemini, or a local model through Ollama or vLLM. Generation and embeddings are chosen separately, and embeddings are optional. [AI providers](docs/ai-providers.md) has a working configuration for each, and says what leaves your install: a provider is hosted unless you declare an OpenAI-compatible one local, and a hosted one must be reached over `https`.
- **Check a setup** from the new **Jobs** page (any signed-in account can choose *Check AI provider*), or from a shell with `docker compose exec worker node dist/llm-check.js`. It sends one tiny fixed request with none of your data, and reports the provider, the model, whether data leaves the install, the tokens used and the cost, or what failed and which setting to look at.
- **A worker runs background jobs**, from the same image with another command (`node dist/worker.js`), as a new `worker` service in both compose files. A job shows its state and progress without a reload, can be cancelled, runs again after a failure that may pass, and is picked up again if its worker stops or crashes. You can run as many workers as you like. Everything that worked in v0.1 works with no worker running; jobs wait in the queue, and the Jobs page says so.
- **A job cannot overspend.** Each job has a token cap and a cost cap (500,000 tokens and $5 by default), checked before every request against the most it could use, counting every run. An account can have three jobs queued or running, and can start a provider check every five minutes. These bound one job, not your spend over time, so set a spending limit on the provider account too.
- **Every request reports its tokens and cost.** Prices come from a dated list in the repository or from your own `LLM_PRICE_INPUT` and `LLM_PRICE_OUTPUT`, and a model with no price has an unknown cost, never a free one.
- **Your keys stay yours.** A provider key is read from the environment or from the secrets-manager secret, and is never logged, stored in the database or sent to the browser. Only the worker uses a key: give it to the worker alone, and the app starts without it.

### Upgrading

- Twenty-four new environment variables, all optional, are in [Install and run](docs/install.md#environment-variables): sixteen for AI providers and eight for jobs and the worker. The secrets-manager secret may also hold `LLM_API_KEY` and `EMBEDDING_API_KEY`, though both the app and the worker read that secret, so a key kept there reaches the app as well; [which process gets what](docs/install.md#which-process-gets-what) says how to keep it from the app.
- **Run the worker.** The compose files now start a `worker` service next to `app`. On any other setup, start `node dist/worker.js` from the same image. A database migration (`016_jobs.sql`) adds three tables, and the first process to start applies it.
- **A setting that is wrong stops Scrylux from starting**, and the message names the variable. So does a stray variable that the provider libraries would read on their own, such as `OPENAI_API_KEY` or `ANTHROPIC_BASE_URL`, but only while a provider is configured. [AI providers](docs/ai-providers.md#variables-scrylux-refuses) lists them.
- The compose files pass the new variables through, and map `host.docker.internal` to the host, so a model server on the same machine is reachable from the container.

## [0.1.0] - 2026-10-18

The first release: a manual threat modeling tool you run yourself. Draw a system, get STRIDE threats from rules, work them to a decision, and take the result with you.

### What you can do

- **Draw** the system as a data-flow diagram, in the browser. The five element types are external entities, processes, data stores, data flows, and trust boundaries, which hold what is inside them and can nest. Each element can carry technology tags and security flags (for example: authenticated, encrypted in transit, stores sensitive data, internet-facing). The diagram saves as you go, with undo and redo.
- **Generate** STRIDE threats from the diagram. A library of rules, kept as plain files, proposes threats per element type and per flag, with suggested mitigations. Running it again changes nothing that is already there, keeps your edits, and marks a generated threat **stale**, instead of deleting it, when the diagram or a rule changed under it.
- **Work through** the threats. Each has a status (open, mitigated, accepted, not applicable), a likelihood and an impact that give its risk, and mitigations with their own status (proposed, implemented, verified). Accepting a risk or dismissing a threat takes a reason; marking one mitigated takes an implemented or verified mitigation. Selecting an element on the diagram filters the threat list to it, and every element shows how many open threats it has.
- **Report** on a threat model as a Markdown document or as a print-friendly page (use the browser's *Save as PDF*): the diagram, the threats grouped by element, and a risk summary.
- **Exchange** a threat model. Export it as a **Scrylux file** (lossless: a re-import gives back the same diagram, threats and mitigations) or as an **OTM** file; import a Scrylux file, an OTM file or an OWASP **Threat Dragon** v2 file. Every import shows what it will do first, and lists anything it cannot carry over.
- **Keep it in one place.** Accounts, projects and threat models, a documented REST API with an OpenAPI document, and sign-out from every device. The whole thing is one container and a PostgreSQL database.
- **Try it on a finished example.** A fictional demo threat model, [`docs/demo/`](docs/demo/), is attached to this release.

### What it does not do yet

- **No roles.** Every account can read, change and delete everything. Roles and single sign-on are planned for Phase 6.
- **No AI.** Nothing in v0.1 reads documents or calls a language model. Drafting a threat model from documents, with citations and a human accept step, is planned for Phase 3.
- **One container with its database, and no TLS of its own.** Put a proxy that terminates TLS in front of it before anyone else can reach it. The quickstart's sign-in and signing secret are defaults for trying it on your own machine.
- **The image is not signed.** It carries no build attestation or SBOM in this release; pin it by the digest on the release page. Verifiable release images are planned for Phase 6.
- **Open risks exist** and are listed, with what covers them, in [Scrylux's own threat model](docs/threat-model/).

### Upgrading

- **Back up first.** `docker compose exec db pg_dump -U postgres threats > backup.sql`. Migrations only move forward, and run when the app starts; there is no downgrade.
- **The supported path is from one release to the next.** There is no support for upgrading from an arbitrary commit of `main`.
- **Coming from the original tracker (Phase 0)?** Phase 1 removed it, and a migration drops its entries, the table that held them and the `/api/threats` endpoints. **Nothing is exported first**: those entries were throwaway data. User accounts, and any project that did not come from that import, are untouched.

[0.1.0]: https://github.com/shivamsaraswat/scrylux/releases/tag/v0.1.0
