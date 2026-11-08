# Scrylux: system design

This document describes how Scrylux is built, for people who review its security: what the parts are, how they talk to each other, what each one holds, and where one part trusts another less than it trusts itself. It describes the system as it runs when an operator has installed it with the supplied container files and has configured one hosted language model for generation and one for embeddings.

Scrylux is a self-hosted tool for threat modeling. A team draws the data-flow diagram of a system, records the threats that apply to it, and tracks what is done about each. From version 0.2 it can also read the team's design documents and propose a first draft of that diagram, which a person then reviews.

## 1. Overview

Scrylux is one application with two server processes that share a database. The first process, the API, serves the web application and answers every request from a browser or from a script. The second process, the worker, runs background jobs: it reads uploaded documents, makes embeddings of their text and asks a language model to propose a system. Both processes are started from the same container image, and both are stateless: everything they remember is in the database or in the storage for uploaded files.

The parts, in the order a request meets them:

| Part | What it is | What it holds |
| --- | --- | --- |
| Browser application | A single page application written in TypeScript and served by the API | A short-lived access token in page memory; nothing in browser storage |
| API | An Express application listening on one port | The database credentials; the signing secret for tokens; never a language model key |
| Worker | A second entry point of the API's code, started as its own process | The database credentials; the language model keys; the storage credentials |
| Extraction child | A short-lived process the worker starts to read one uploaded PDF or Word file | Nothing: it is started with an empty environment |
| Database | PostgreSQL 16 with the pgvector extension | Every record, the text of documents, and their embeddings |
| Storage | A directory on a volume, or an S3-compatible bucket | Uploaded files, only until they have been read |
| Language model provider | A hosted service, or a model running on the operator's own machine | Nothing of Scrylux's; it sees what it is sent for one request |

There is no cache, no queue server and no search server. The job queue is a table in the database, and the search over document text is a query on the same database.

### 1.1 What a team does with it

A person signs in, creates a project and, inside it, a threat model. In the threat model they open the diagram and place elements: external entities, processes, data stores, data flows between them, and trust boundaries around groups of them. For each element Scrylux can propose the threats that apply, from a library of rules that ships with it, and the person decides what to do with each: leave it open, mark it mitigated with a described mitigation, accept it with a reason, or mark it not applicable.

From version 0.2 the person can also open the Sources tab and add the documents the system was designed from, as Markdown, text, PDF or Word files, or as pasted text. On the Draft tab they can then ask Scrylux to propose the system those documents describe. The result is a draft, shown beside the real diagram and never merged into it.

### 1.2 What Scrylux is not

Scrylux does not scan code, does not connect to cloud accounts and does not call any service on its own initiative. It sends nothing to any address that the operator has not configured. It collects no telemetry. A model that Scrylux asks for a draft is given no tool and cannot read or write anything but the text it is sent and the answer it gives.

## 2. The browser application

The web application is built with React. It is served by the API as static files, from the same origin as the API, so it needs no cross-origin permissions. Its pages are the project list, a project with its threat models, a threat model with its tabs (Diagram, Threats, Sources, Draft), a page for one document, and a Jobs page that shows background work.

### 2.1 What the browser holds

The browser holds two things. A refresh cookie, which the browser keeps and scripts cannot read, proves that the person signed in. A short-lived access token is kept in the memory of the page only. Neither is ever written to local storage, session storage or a URL. When the page is closed the access token is gone, and the next visit gets a new one by presenting the cookie.

### 2.2 How text from documents and from the model is shown

Every text that came from a person, from a document or from a language model is shown as text. The application never renders such text as Markdown or HTML. A document's name, the text of its chunks, and the names, reasons and quoted passages of a draft are put on the page as text nodes, so markup inside them is displayed and never run. The content security policy that the API sends forbids inline scripts and forbids loading scripts from any other origin, as a second line of defence.

### 2.3 The diagram editor

The diagram is drawn with an open source graph library. Elements are placed by dragging them. A flow is drawn by dragging from one element to another. A trust boundary is a dashed frame, and an element inside it belongs to it. The editor saves changes through the API as they are made and keeps a history for undo. The editor never trusts the browser for what is allowed: the API checks every rule again, so a crafted request cannot create a flow between two flows or a boundary inside itself.

### 2.4 The draft view

The Draft tab shows what the model proposed: a read-only diagram of the proposed elements and a list of every item. Selecting an item shows why it was proposed and the passages of the documents it came from, each with the name of the document and where in it the passage is. The draft is marked, on every view, as proposed by artificial intelligence and not part of the threat model. Nothing on this tab changes the threat model.

## 3. The API

The API is an Express application. It listens on one port, which the operator chooses, and it answers three families of requests: the web application's static files, the sign-in endpoints, and the data endpoints under a versioned path.

### 3.1 Authentication

A person signs in with a user name and a password. Passwords are stored as bcrypt hashes with a work factor of at least ten and are never logged or returned. The sign-in endpoint compares against a fixed dummy hash when the user name does not exist, so that the time taken does not reveal which user names exist. Failed sign-ins are counted per user name and address and per address, and further attempts are refused for a while, without locking the real user out of their own account.

After signing in the browser receives the refresh cookie and an access token. The cookie is marked HttpOnly and SameSite=Strict, is limited to the path of the session endpoints, and is accompanied by an origin check and a requirement for a JSON content type on every request that uses it, so that a page on another site cannot use it. The refresh credential rotates every time it is used, and presenting a credential that has already been replaced ends the whole session. Only a digest of the credential is stored in the database.

Scripts and other programs sign in with the same endpoint and receive a bearer token that expires. Every data endpoint requires one of the two kinds of token. The one endpoint that describes the API is also behind sign-in.

### 3.2 Authorization

There are no roles in this version. Every signed-in account can read and change every project, threat model, document and draft. This is a known limit, and it is recorded in the threat model of Scrylux itself. A later version adds roles and per-project access. Until then the operator should create accounts only for people who may see everything.

### 3.3 The data endpoints

The data endpoints cover projects, threat models, elements, threats, mitigations, reports, exports and imports, documents, jobs and drafts. Every request is checked at the boundary against a schema before it is used: unknown fields are refused, lengths and value sets are enforced, and identifiers must be well formed. Every database statement uses parameters. A value that comes from a request is never written into a statement's text. Errors have one shape, a JSON object with a single message, and the message is fixed text that never repeats the request.

Every change writes one line to the standard output saying who did what to which record. The line never contains a document's name or text.

### 3.4 The routes for documents and drafts

Documents have eight routes: list, upload, paste, read, read the chunks, retry, refresh embeddings and delete. An upload is limited in size before it is read, and the API reads only the first bytes of a file, enough to decide what type it is. It never parses a PDF or a Word file: that happens in the worker.

Drafts have four routes: read the extraction status, start an extraction, read the draft and discard it. The API never sends a request to a language model. Starting an extraction checks that a generation provider is configured, that no document is still being processed and that at least one is ready, and then queues a job. Only one extraction of a threat model can be queued or running at a time, and the database enforces it.

### 3.5 Limits

The number of jobs one account can have queued or running is limited. Uploads are limited in size, in count per threat model and in total across the installation. Each process reads at most four uploads at once and refuses a fifth until one finishes. These limits bound what a single account can cost the operator in storage and in provider charges.

## 4. The worker

The worker is the only process that sends a request to a language model, and the only process, besides the API, that holds database credentials. It is started from the same image as the API with a different command. It does not listen for requests from users. It exposes one small health endpoint on a separate port, which an orchestrator can poll, and it needs no inbound access from the internet.

### 4.1 Jobs

All background work is a job, a row in the jobs table. A job has a kind, a state (queued, running, succeeded, failed or cancelled), who started it, its progress, its token and cost caps, the number of runs it may make, and a result made only of counts. The kinds are a provider check, the ingestion of a document, the refresh of a document's embeddings, and the extraction of a system.

The worker claims the oldest queued job whose time has come, using a statement that skips rows another worker has already locked, so several workers can run at once without taking the same job. A claimed job has a lease that the worker renews on a timer. If the worker stops, the lease runs out, and another worker queues the job again after a wait. Every write the worker makes to a job carries the number of the claim that took it, so a worker that has lost its job can no longer change it.

A job that ends is never changed again. A job whose threat model is deleted is deleted with it.

### 4.2 Caps

Every job that can call a model has a token cap and a cost cap, set from the operator's settings and copied onto the job. A person starting a job cannot set or raise them. Before each request, the job works out the most that request could use, counting every attempt Scrylux may make for it, and does not send the request if that would take the job past either cap. A job whose cap is lower than the most a single request could use fails before it sends anything.

### 4.3 What the worker does for a document

When a document is added, the API stores its bytes and queues an ingestion job. The worker reads the original from storage. For a PDF or a Word file it starts the extraction child, which parses the file under limits of time, memory, unpacked size and pages. It cuts the text into consecutive chunks of at most two thousand characters, asks the embedding provider for one embedding per chunk, and writes every chunk with its embedding in one transaction together with the end of the job. Nothing of a half-read document is ever visible. Once the document is ready the worker deletes the original.

### 4.4 What the worker does for an extraction

When an extraction is started the worker reads the threat model's ready documents. If their text fits the budget, 36,000 characters by default, it sends all of it. If not, it embeds eight fixed questions about systems, ranks every chunk of the threat model against them in the database, and sends the nearest chunks that fit the budget. The questions are text shipped with Scrylux. They hold nothing from any document.

The chunks are sent to the generation model under short labels, never under database identifiers. The model must answer in a fixed structure, naming each element it proposes, the flows between them, the boundaries around them, assets and assumptions. Every item must cite at least one chunk by its label and quote a passage from it, and so must every security flag it proposes. Scrylux checks the answer before it keeps anything: the structure must match, every cited chunk must be one that was sent, every quoted passage must really appear in the chunk it cites, and the diagram must be valid, with flows between real elements and no boundary inside itself. An answer that fails is sent back to the model, with a note naming the problems by their place, up to three times, and then refused. Nothing from a refused answer is stored.

A valid answer is written as the threat model's draft in the transaction that ends the job, replacing the previous draft. A failed or cancelled extraction leaves the previous draft as it was.

### 4.5 The extraction child

Reading a PDF or a Word file is the riskiest thing Scrylux does, because the files are untrusted and the parsers are large. The worker therefore never parses a file itself. It starts a separate process for each file, with an empty environment and no standard streams, so the process holds no database password, no model key and no storage credential, and has nothing to write a log to. The process is stopped if it passes the time or memory limit, if a Word file unpacks to more than its limit, or if a PDF has too many pages. A Word file with macros is refused. Nothing a file points at is fetched or run: no link, no external image, no font, no script.

The child still has the worker's network, because the operating system does not take it away. This is an accepted risk that the threat model of Scrylux records.

## 5. The database

Scrylux uses PostgreSQL 16 with the pgvector extension, in the same database for everything. Schema changes are forward-only SQL files applied when the API starts, and never edited after they are merged.

### 5.1 What it holds

The main records are users and their sessions, projects, threat models, elements, threats and mitigations. From version 0.2 it also holds sources (one row per document), chunks (the consecutive pieces of a document's text, each with its embedding as a vector), jobs and the usage of each request a job made, and drafts with their items and citations.

A chunk keeps the text of a document. The embedding of a chunk is a vector of the number of dimensions the embedding model produces. Embeddings from different models, or of different sizes, are never compared with each other.

### 5.2 Drafts are kept apart from the threat model

A draft has its own tables. Nothing in them refers to the threat model's elements, threats or mitigations, and nothing in the threat model refers to a draft. An item proposed by the model therefore cannot be mistaken for an accepted one. A citation in a draft keeps the position of its quoted passage inside the chunk and never a copy of the passage, so deleting a document leaves none of its text in any draft. The page then shows the citation as pointing at a deleted source.

### 5.3 Deletion

Deleting a threat model deletes its documents, chunks, jobs and draft. Deleting a project deletes its threat models. Deleting a document deletes its chunks and embeddings and asks its running jobs to stop. An original that storage could not remove at once is removed later by a sweep that the worker runs at start and every ten minutes.

### 5.4 Credentials and access

The database user that Scrylux connects as owns its tables and may create the extension. The operator can instead create the extension once as an administrator, which is common on managed databases. The database should accept connections only from the API and the worker, which share the same network. Scrylux does not encrypt data in the database itself. Disk encryption and encrypted backups are the operator's to provide.

## 6. Storage for uploaded files

An uploaded file is kept only until it has been read. It is stored under a name Scrylux generates, never under the file's own name, so a name cannot name a path. There are two backends, chosen by the operator. The local backend is a directory on a volume that the API and the worker both mount. The other is an S3-compatible bucket, which lets the API and the worker run on different machines.

With a bucket, both processes need credentials: the API to put objects, the worker to read, list and delete them. The documentation gives one least-privilege policy for each. The credentials are kept in the environment or in a secrets manager and are never stored in the database, logged or sent to the browser. A shared bucket is protected by a dedicated prefix and a key pattern, so Scrylux touches no other object.

When a document is ready its original is deleted. When a document, a threat model or a project is deleted, the originals under them are deleted. If storage fails to remove one, the sweep removes it within an hour and ten minutes. The original is never served to a browser; a person reads the chunks that were extracted.

## 7. Language model providers

Scrylux talks to a model only through its own provider layer, a package inside the repository with one interface and four adapters: Anthropic, an OpenAI-compatible service (which covers OpenAI, Azure OpenAI, Ollama and vLLM through their addresses), Amazon Bedrock and Google Gemini. No feature depends on one vendor. The layer asks for a structured answer against a schema, or for embeddings, and returns the validated value together with a record of the request: its tokens, its cost, its time and how many attempts it took.

### 7.1 Selection and keys

The operator selects a provider for generation and, separately, one for embeddings, with environment variables. Each has its own model, address, key and region. Keys come from the environment or from the secrets manager the operator already uses for the database credentials. They are never stored in the database, never logged and never sent to the browser. The API process does not need any key and the container files give keys to the worker only. A process refuses to start if a required setting is missing, naming the variable and never its value.

### 7.2 Hosted and local models

A provider is hosted unless the operator declares it local. A hosted provider must be reached over an encrypted connection. A local provider, such as Ollama on the same machine, may use plain HTTP. Scrylux shows, wherever a person could send text to a hosted provider, that the text leaves the installation and to which provider. With only local providers it says the text stays.

### 7.3 Untrusted content in requests

The text of documents is untrusted. The layer puts it in one marked section of the user message, delimited by lines that contain a random value drawn for the request, so a document cannot close the section by typing an end marker. The instructions tell the model that the section is data to describe and never instructions to follow. The model is given no tool and no function. The instructions are kept apart from the section in a different place of the request.

Prompts, the questions used for retrieval and the failure messages are plain files in the repository, so they can be read and reviewed without reading code. Every draft records a hash of the prompt files and the answer's schema, so a change to any of them is visible in the draft.

### 7.4 Failure and cost

A request that fails because the provider is overloaded is tried again at most twice, after growing waits. A request whose answer does not match the schema is asked again up to three times with a note that names the problems by their place and never repeats what the model wrote. Every request writes one log line with its facts and none of its content. The cost of a request is computed from a price list in the repository, or from prices the operator sets. A model with no price has an unknown cost, and Scrylux says so instead of reporting zero.

## 8. Trust boundaries

A trust boundary is a line across which data passes between parts that do not trust each other equally. Scrylux has the following.

| Boundary | On one side | On the other side | What crosses it |
| --- | --- | --- | --- |
| The internet and the API | Browsers and scripts anywhere | The API | Sign-in requests, data requests, uploaded files |
| The API and the database | The API | The database | Parameterized statements, records, document text |
| The API and the worker | Both | The database as their only shared state | Jobs and their results |
| The worker and the extraction child | The worker | A process with no secrets | One file's bytes in, extracted text out |
| The worker and the model provider | The worker | A hosted service or a local model | Chunks of documents, retrieval questions, the model's answer |
| The worker, the API and storage | Both processes | A volume or a bucket | Uploaded originals, until read |
| The operator and the installation | The operator | Everything above | Environment variables, container files, backups |

### 8.1 Untrusted document content

A document is attacker-controlled data even when a trusted person uploads it: it may have been copied from a source the person does not control, and it may contain text written to steer a model. The documents cross the boundary into the worker, then into a model request, and the model's answer comes back. Scrylux treats every step as untrusted. The file is parsed in a process with no secrets. The text is placed in a marked section. The answer is accepted only through a schema and a set of checks. The only effect of an accepted answer is a draft, which a person reviews and which is kept apart from the threat model.

A document can still change what is proposed. If it contains a sentence that can be quoted in support of a component that does not exist, a model that follows the document may propose that component, with the quoted sentence as its citation. This is accepted: the reviewer sees the quotation. It cannot make Scrylux call a tool, read another threat model's documents, or write to the threat model.

### 8.2 The model provider

The provider is outside Scrylux's control. Whatever is sent to a hosted provider is governed by that provider's terms. This is why the notice is shown before text is sent, and why a fully local model is a supported path. The responses of a provider are never trusted: they are validated before use, and errors from a provider are never shown to a person as they came, because they may echo the request. Scrylux shows its own fixed message for each kind of failure.

## 9. Data held, and where

| Data | Where it is held | Who can read it | How long |
| --- | --- | --- | --- |
| Account names and password hashes | Database | The API and the worker | Until the account is deleted |
| Refresh credentials (digests only) | Database | The API | Until the session ends or expires |
| Projects, threat models, elements, threats, mitigations | Database | Every signed-in account | Until deleted |
| Uploaded originals | Volume or bucket | The API and the worker | Until the document is ready, or deleted |
| Document text and embeddings | Database, as chunks | Every signed-in account | Until the document is deleted |
| Drafts, with rationales and citations | Database | Every signed-in account | Until replaced or discarded |
| Job records and usage | Database | Every signed-in account | Kept, without any content |
| Model provider keys | The worker's environment | The worker | While the worker runs |
| Storage credentials | Environment of both processes | The API and the worker | While they run |
| Logs | Standard output of each process | The operator | The operator's retention |

Logs contain identifiers, counts and fixed messages. They never contain a password, a token, a key, a document's name or text, a prompt or an answer. Logging of prompts and answers is off.

## 10. Deployment

The supplied files start three containers: the database, the API and the worker. The database uses the pgvector image. The API and the worker use the same image with different commands, mount the same volume for uploads and are given their own settings. The API publishes one port. The worker publishes none to the outside.

The recommended setup puts a reverse proxy in front of the API that ends the encrypted connection, adds nothing to the application's own headers and passes the client address, which the operator declares as trusted so that the throttle on failed sign-ins counts the real address. The API sends its own security headers: a strict content security policy, a ban on framing, and a policy for referrers.

The operator is responsible for backups of the database and of the volume, for disk encryption, for rotating the secrets, and for keeping the images up to date. Updating Scrylux means pulling a new image; the schema changes are applied when the API starts, forward only. A database without the vector extension stops the update before it changes anything.

## 11. Assumptions

Scrylux relies on the following, and its threat model says what happens when one fails.

- The database is reachable only from the API and the worker.
- The operator keeps the secrets out of the repository and out of the image.
- The reverse proxy ends the encrypted connection, and nothing else reaches the API.
- Every signed-in person is allowed to see everything in the installation.
- A hosted model provider handles the text it is sent as its terms say.
- The parsers used for PDF and Word files have flaws that have not yet been found; this is why they run in a process with no secrets and with limits.
- Disk encryption protects the database and the volume at rest.

## 12. Entry points

Every way in is listed here, so a reader can check that nothing has been left out of the analysis.

| Entry point | Reached by | Checked before it acts |
| --- | --- | --- |
| Sign-in | Anyone who can reach the API | Username and password; a throttle on repeated failures per address and per account |
| Token refresh | A browser holding a refresh credential | The credential's digest, its expiry and whether it was revoked |
| Record routes (projects, threat models, elements, threats, mitigations) | A signed-in account | A valid access token; the shape of the body against a strict schema; fixed limits on sizes and counts |
| Import | A signed-in account | The file's size and shape, checked in full before any record is written; all records written in one transaction |
| Export and report | A signed-in account | A valid access token; the format named in the request |
| Source upload and paste | A signed-in account | The file's declared and detected type, its size, a limit on the sum of a threat model's sources; the bytes are kept as received |
| Source read and chunk listing | A signed-in account | A valid access token; text is returned as data and never rendered as markup |
| Job routes | A signed-in account | A valid access token; a limit of three active jobs per account; a cool-down after a failure |
| Extraction and draft routes | A signed-in account | A valid access token; the sources must be ready; one active extraction per threat model |
| Health | Anyone | Nothing; it answers only that the process is up |
| Worker queue | The database | Jobs are claimed with a lease, so a lost worker's job is taken by another |
| Container environment | The operator | Required settings are checked at start and the process refuses to run without them |

### 12.1 What is not an entry point

The browser app is static files and holds no secret. The worker listens on no port. The database accepts connections only from inside the deployment. The model providers are called, and never call back.

## 13. Known limits

These are choices made on purpose, and the threat model should record each as an accepted risk, not a finding.

- **Shared visibility.** Every signed-in account sees every project. There are no roles. An installation is meant for one team that trusts its members with each other's work.
- **No account recovery.** An operator resets a forgotten password in the database. There is no email, so there is no reset link to steal.
- **No audit trail of reads.** Writes are logged with the account and the kind of change. Reads are not logged.
- **Documents are kept as they are.** Scrylux does not scan an uploaded document for malware. It never opens one outside the extraction process, and it never serves one back to a browser as a page.
- **Text sent to a hosted model leaves the installation.** The notice says so before the text is sent, and a local model avoids it.
- **Stored text can be misleading.** A document may carry sentences meant to steer a model. The draft keeps their citations visible, and nothing a model proposes is accepted without a person.
- **Cost is capped, not prevented.** A job stops at its token or cost cap, but a cap that is set too high spends what it is set to.
- **Denial of service by an account.** A signed-in account can queue work up to its limits. The limits bound the harm but do not remove it.
- **Single database.** The database is a single point of failure. Backups and replication are the operator's to arrange.

## 14. Glossary

- **Chunk:** a span of a document's text, about a page long, kept with its position so a citation can point back to it.
- **Draft:** the system a model proposes for a threat model, kept apart from the model and read-only until a person accepts parts of it.
- **Element:** a part of a system in a threat model: a process, a data store, an external entity, a flow or a trust boundary.
- **Job:** a unit of background work with a state, a cap on cost and time, and a record of what it did.
- **Lease:** a time-limited claim a worker holds on a job; if the worker stops, the lease expires and the job is taken again.
- **Source:** a document attached to a threat model, from which text is read.
- **Threat model:** a named description of one system, with its elements, threats and mitigations.
