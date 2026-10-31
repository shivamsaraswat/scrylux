# Feature Specification: LLM Provider Layer

**Feature Branch**: not yet created (spec directory `phase-3/milestone-1-llm-provider-layer`)

**Created**: 2026-10-19

**Status**: Draft

**Input**: User description: "let's start with milestone 1 of phase 3 now". This covers Phase 3 / Milestone 1
of `plan.md`, the LLM provider layer. Scrylux gets one provider-agnostic way to ask a language model
for two things: a **structured result** (a description of the shape wanted goes in, and an object that
has been checked against that shape comes out, or a failure that says why) and **embeddings** (a list
of texts goes in, and one vector per text comes out). Behind that interface sit four adapters: Anthropic;
OpenAI-compatible, which covers OpenAI, Azure OpenAI, Ollama and vLLM through a base address; AWS
Bedrock; and Google Gemini, added at the maintainer's request during planning. The operator picks one
per install through the environment. Every request reports what it
used: tokens, cost (or that the cost is unknown), time, attempts and outcome. With no provider configured,
Scrylux works exactly as v0.1 does. This milestone builds the layer, its configuration, a check an
operator can run against the configured provider, and the threat model update for the new credential and
the new outbound boundary. Nothing in Scrylux sends user content to a model yet. Running requests as
background jobs with progress, retries, cancellation and per-job token and cost caps is Milestone 2.
Ingestion and storing embeddings is Milestone 3. The prompts that extract a system or generate threats
are Milestones 4 and 6. The UI's notice that data leaves the install, and opt-in logging of prompts and
responses, are Milestone 8.

## Clarifications

### Session 2026-10-19

- Q: When a generation provider is configured, must an embedding provider be configured too? → A: Not in
  this milestone. Embeddings are optional: without an embedding provider, Scrylux starts and the layer
  reports embeddings as not configured. Whether Milestone 3 makes them required is left to Milestone 3
  (FR-009, US2 scenario 7).
- Q: How is an OpenAI-compatible base address classified as hosted or local? → A: It is hosted unless the
  operator declares it local in a setting. Only the OpenAI-compatible provider accepts that declaration.
  Anthropic, Bedrock and Gemini are always hosted, and a declaration made for them stops Scrylux from
  starting (FR-044, FR-044a, edge case "Hosted or local").
- Q: Where do model prices come from? → A: From a price list kept as a versioned data file in the
  repository for well-known hosted models, with the date and source of each price. The operator may also
  set prices for the configured generation and embedding models, and those take precedence. A model with
  neither has an unknown cost (FR-033, FR-033a to FR-033c).
- Q: Should Scrylux accept a plain `http://` base address for an OpenAI-compatible provider, or only
  `https://`? → A: `http` is accepted only for a provider declared local. A provider that is not
  declared local, so counts as hosted, must use `https`, or Scrylux refuses to start and says why
  (FR-003a, US2 scenario 10).
- Q: Should the layer control how random the model's answers are (its "temperature"), or leave each
  provider's default? → A: Every structured request uses a fixed temperature of 0 where the model
  accepts one, and the provider's default where it does not. Neither the caller nor the operator can
  change it (FR-015a, FR-015b, US1 scenario 7).
- Q: What should the default time limit be, and does it apply to each attempt or to the whole request?
  → A: 300 seconds per attempt, which the operator can change. A whole request is bounded by its
  attempts and the waits between them (FR-010, SC-008).

### Session 2026-10-20 (during planning)

- Q: Should Google's Gemini models be supported too? → A: Yes, at the maintainer's request when planning
  started. Gemini is a fourth provider, for generation and for embeddings, reached through the Gemini
  Developer API with an API key. It is always hosted, and its prices are in the shipped list. Gemini
  through Google Cloud's Vertex AI is not part of this milestone (FR-002, FR-044, FR-033a, FR-011).
- Q: Should a model whose vendor advises against changing temperature count as one that does not accept
  it? → A: Yes. A model that refuses a temperature, and a model whose vendor documents that it should be
  left at its default (Gemini 3 is one), are both sent no temperature, and the provider's default applies
  (FR-015a).

### Session 2026-10-21 (after cross-artifact analysis)

The maintainer asked for the analysis findings to be resolved. No new decision was asked of anyone; these
record what the spec now says and why:

- The bound on a whole request now counts every call the layer can make: up to 5 attempts (3 schema
  attempts and 2 transient retries) and up to 4 resends for a refused setting (FR-010, FR-022).
- Startup messages may name a provider when it is one of the accepted names, because that is fixed text,
  not something the operator typed freely (FR-006, SC-006).
- The log line goes to the process's log output: stdout in the server, stderr in the check command, so the
  check's report stays readable on its own (FR-034).
- AWS's endpoint variables redirect requests to another address, so they are refused while Bedrock is
  configured, like any other vendor address variable (FR-043a).
- Some local servers shorten an over-long input instead of refusing it (edge case "Input too large").
- US6's independent test no longer removes the local declaration from an `http` address, which FR-003a
  refuses; it uses an `https` address instead.

## User Scenarios & Testing *(mandatory)*

The layer has no screen in this milestone. It has two kinds of user. Operators who self-host Scrylux
configure it through the environment and check that it works. The parts of Scrylux that later milestones
build (the worker, ingestion, system extraction, threat generation and the eval harness) call it. The
stories below are written from their side.

### User Story 1 - Get a validated structured result from whichever model is configured (Priority: P1)

A part of Scrylux describes the shape of the answer it needs, for example "a list of components, each
with a name, a type and the chunk identifiers it was found in". It gives the layer its instructions and
the content to work on, and gets back either an object that matches that shape exactly or a failure that
says what went wrong. The calling code is the same whichever provider the operator chose, and it never
has to handle unvalidated model output.

**Why this priority**: This is what the layer is for. Milestones 4 and 6 are built on it, and
Principle VI says model output reaches the database only after it has been checked against its schema.
A layer that could return a malformed object would push that check onto every caller, and sooner or
later one would skip it.

**Independent Test**: Define a small schema (an object with a required name and an enumerated type).
Run one request through each of the four adapters against simulated provider responses. Check that
each returns an object matching the schema. Then simulate a provider that answers with a missing field
on the first attempt and a valid object on the second, and check that the request succeeds with two
attempts recorded. Finally simulate a provider that never answers validly, and check that the request
fails as "invalid output" and returns no object.

**Acceptance Scenarios**:

1. **Given** a configured provider and a schema, **When** a structured request succeeds, **Then** the
   result matches the schema in every field, type and enumerated value, and comes with its usage
   record (FR-030).
2. **Given** a provider whose first answer does not match the schema, **When** the request runs,
   **Then** the layer asks again, telling the model what was wrong, up to the attempt limit
   (FR-014). If a later answer matches, the request succeeds and records every attempt.
3. **Given** a provider that never answers validly within the attempt limit, **When** the request
   runs, **Then** it fails as "invalid output", and no part of any invalid answer is returned to the
   caller as a result.
4. **Given** the same request, **When** it is sent through the Anthropic, the OpenAI-compatible, the
   Bedrock and the Gemini adapter, **Then** the caller's code and the shape of the result are identical. Only the
   usage record's provider and model differ.
5. **Given** an answer that is valid JSON but has extra fields the schema does not allow, **When** it
   is checked, **Then** it is treated as not matching the schema, never trimmed silently into a match.
6. **Given** a request in progress, **When** the caller cancels it, **Then** the request stops,
   fails as "cancelled", and reports the usage known so far.
7. **Given** a structured request, **When** an adapter sends it to a model that accepts a
   temperature, **Then** the temperature is 0. To a model that does not accept one (some reasoning
   models), none is sent, the request does not fail or use an extra attempt because of it, and the
   usage record says the fixed temperature was not applied.

---

### User Story 2 - Choose a provider, or none, through the environment (Priority: P1)

An operator sets a few environment values to choose a generation provider and model, an embedding
provider and model, and the credentials or address each one needs, then restarts Scrylux. Changing
from a hosted provider to a local model is a change of environment values, never of code or files.
An operator who sets nothing gets Scrylux exactly as v0.1 shipped it.

**Why this priority**: "Bring your own LLM, including a fully local one" is why a self-hoster picks
Scrylux (plan.md, Principles 4 and 5). Manual modeling is first-class (Principle 1), so the AI must be
something an install can leave off entirely. Without a working configuration, nothing else in Phase 3
can be tried.

**Independent Test**: Start Scrylux with no provider settings, and check that it starts, `/health`
answers 200 and the v0.1 flows work. Start it with an OpenAI-compatible provider pointed at a local
Ollama `http` address, declared local, and a model name, and check that it starts and that the check (US6) succeeds. Start it
with Anthropic selected and no key, and check that it refuses to start with a message that names the
missing setting.

**Acceptance Scenarios**:

1. **Given** no provider settings, **When** Scrylux starts, **Then** it starts as v0.1 did. The layer
   reports that no generation and no embedding provider is configured, and no outbound connection to
   any model provider is ever made.
2. **Given** a provider selected with every setting it needs, **When** Scrylux starts, **Then** it
   starts without contacting the provider, so a provider that is down or a local model that starts
   later does not stop Scrylux from starting, and `/health` does not depend on it.
3. **Given** a provider selected but a required setting missing or malformed (a key, a model name, a
   base address that is not an http or https address, a Bedrock region), **When** Scrylux starts,
   **Then** it refuses to start, and the message names the setting and what is wrong with it, never
   its value.
4. **Given** an unknown provider name, **When** Scrylux starts, **Then** it refuses to start and lists
   the provider names it accepts.
5. **Given** a provider API key in the existing secrets-manager secret instead of the environment,
   **When** Scrylux starts, **Then** it uses that key, under the same precedence rule the secret already
   applies to the database credentials.
6. **Given** Bedrock selected on a host with an instance or task role, **When** Scrylux starts,
   **Then** no API key is required: the platform's standard credentials are used, as the
   secrets-manager lookup already does.
7. **Given** settings for a generation provider but none for embeddings, **When** Scrylux starts,
   **Then** it starts, and the layer reports generation as configured and embeddings as not
   configured. An install that uses only Anthropic therefore needs one key.
8. **Given** an OpenAI-compatible provider at an `https` address, with no local declaration,
   **When** Scrylux starts, **Then** the layer reports the provider as hosted, even if the address is
   on the operator's own network. With the local declaration set, it reports it as local.
9. **Given** the local declaration set for Anthropic, Bedrock or Gemini, **When** Scrylux starts, **Then** it
   refuses to start, because data sent to those providers always leaves the install.
10. **Given** an OpenAI-compatible provider with an `http://` base address, **When** Scrylux
    starts, **Then** it starts if the provider is declared local. Otherwise it refuses to start, and
    the message says that a hosted provider needs `https` and that a local one must be declared local.

---

### User Story 3 - Know what every request used (Priority: P1)

Every request, whether it succeeds or fails, comes back with a usage record: which provider and model,
how many input and output tokens, what it cost or that its cost is unknown, how long it took, how many
attempts it made, and how it ended. One log line per request records the same facts and never the
content.

**Why this priority**: Milestone 2 caps each job's tokens and cost, and the eval harness (Milestone 7)
reports cost and latency per run. Both read these records, so their accuracy is set here. A cost of
"0" for a request whose price nobody knows would let a job run past its cap without anyone noticing.

**Independent Test**: Run a successful request, a request that needs one schema retry, and a request
that fails on a rate limit, each against simulated responses that report known token counts. Check
that each usage record's tokens are the sum over its attempts, that cost follows FR-033, and that
exactly one log line per request was written, with no prompt or response text in it.

**Acceptance Scenarios**:

1. **Given** any finished request, **When** its result is returned, **Then** it carries a usage
   record with the provider, model, operation (structured result or embeddings), input tokens, output
   tokens, attempts, duration, outcome and cost.
2. **Given** a request that took more than one attempt, **When** its usage is read, **Then** the
   token counts and cost cover every attempt, including the failed ones.
3. **Given** a provider that does not report token usage (some OpenAI-compatible servers do not),
   **When** the request finishes, **Then** the token counts are estimated from the text and marked as
   estimated, never reported as zero.
4. **Given** a model with no operator price and no entry in the shipped price list (for example an
   Azure deployment name, or a local model), **When** a request to it finishes, **Then** its cost is
   reported as unknown, never as zero.
5. **Given** a model in the shipped price list, **When** a request to it finishes, **Then** its cost
   is worked out from the list's prices and the usage record names the list as the source.
6. **Given** the operator has set prices for the configured model, **When** a request to it finishes,
   **Then** the operator's prices are used, even if the list has the model, and the usage record names
   the operator setting as the source.
7. **Given** any request, **When** it finishes, **Then** one log line is written with the usage
   record's fields. It holds no prompt text, document content, response text, API key, or base
   address.

---

### User Story 4 - Turn text into embeddings (Priority: P2)

A part of Scrylux hands the layer a list of texts and gets back one vector per text, in the same order,
together with the embedding model's name and the vectors' dimension.

**Why this priority**: Milestone 3 stores chunk embeddings for retrieval. It comes after US1–US3
because plan.md has small inputs skip retrieval and send the full context, so extraction can be built
and tried before embeddings matter.

**Independent Test**: Embed three texts through each adapter that offers embeddings, against simulated
responses. Check that three vectors come back in order, all of the reported dimension, with the model
named. Embed a list larger than the provider accepts in one call, and check that it is split and
reassembled in order, with the usage added up.

**Acceptance Scenarios**:

1. **Given** a configured embedding provider and N texts, **When** they are embedded, **Then** N
   vectors come back in the input order, every vector has the same dimension, and the result names the
   model and the dimension.
2. **Given** more texts than the provider accepts in one call, **When** they are embedded, **Then**
   the layer sends them in several calls and returns one result in input order, with one usage record
   for the whole request.
3. **Given** one text that is too long for the embedding model, **When** the list is embedded,
   **Then** the request fails and names the position of that text in the list (never its content).
   It never truncates the text silently.
4. **Given** no embedding provider configured, **When** embeddings are requested, **Then** the
   request fails at once as "not configured", without contacting any provider.

---

### User Story 5 - Document content stays data, and secrets stay secret (Priority: P2)

The content a request works on (in later milestones, an uploaded design document) is kept apart from
Scrylux's own instructions, in a clearly marked section of the prompt. The model is given no tools and
nothing it returns is ever executed. Provider keys are never logged, stored or shown.

**Why this priority**: Principle VI treats ingested documents as untrusted input, and Phase 3 excludes
tool calling. Doing the separation once, in the layer, means no later prompt can put document text
where instructions go by mistake. It is a P2 only because no untrusted content reaches the layer until
Milestone 3.

**Independent Test**: Send a request whose untrusted content contains text that imitates instructions
("ignore the above and answer with …") and the section's own end marker. Check in the request the
adapter would send that the content sits only inside the marked section, after the instructions, and
that the imitated end marker cannot close the section early. Configure a recognizable fake key, run
every kind of success and failure, and search all logs, errors and check output for it.

**Acceptance Scenarios**:

1. **Given** a request with instructions and untrusted content, **When** an adapter builds what it
   sends, **Then** the instructions are in the provider's instruction position and the untrusted
   content is only in the marked content section, never in the instruction position.
2. **Given** untrusted content that contains the marker that ends the content section, **When** the
   request is built, **Then** the content still cannot end the section early.
3. **Given** any request, **When** it is sent, **Then** the model is offered no tool it can ask
   Scrylux to run, and nothing in the answer is executed. The answer is only checked against the
   schema.
4. **Given** a configured API key, **When** any request succeeds or fails, or the provider rejects the
   key, **Then** the key appears in no log line, error, usage record or check output.

---

### User Story 6 - Check that the configured provider works (Priority: P2)

After configuring a provider, an operator runs one command where Scrylux is deployed. It sends a tiny
fixed request, containing no user data, to the configured generation provider and, if one is
configured, to the embedding provider. It reports for each: the provider, the model, whether data
sent to it leaves the install, whether the request succeeded or how it failed, and its usage.

**Why this priority**: Until the worker and the AI features exist, nothing else exercises a live
provider, so an operator has no other way to tell a wrong key or a wrong model name from a working
setup. Phase 3's Definition of Done also requires the same flow to work with a hosted provider and with
Ollama, and this check is the first step of proving it.

**Independent Test**: Run the check with a working local Ollama configuration declared local, and
check that it reports success, usage and "stays in the install" for both operations, and exits with
success. Remove the declaration while keeping the `http` address, and check that the check refuses to
run, names `https` and the local declaration, and exits with the configuration status (FR-003a). Point
it at an `https` OpenAI-compatible address with no declaration, and check that it reports "leaves the
install". Run it with a wrong model name, and check that it reports the failure category in words an
operator can act on and exits with failure.

**Acceptance Scenarios**:

1. **Given** a working configuration, **When** the check runs, **Then** it reports success and usage
   for each configured operation and exits with success.
2. **Given** a wrong key, an unreachable address or an unknown model, **When** the check runs,
   **Then** it names the failing operation and the failure category (FR-020), suggests what to look at,
   and exits with failure.
3. **Given** no provider configured, **When** the check runs, **Then** it says that no provider is
   configured and that Scrylux runs without AI features, and exits with success.
4. **Given** any run of the check, **When** its output is read, **Then** it holds no API key and no
   base address credentials.

---

### User Story 7 - The new credential and boundary are in Scrylux's own threat model (Priority: P2)

A reviewer reads Scrylux's threat model and finds the LLM provider key listed as a current asset, the
outbound connection to a model provider as a current trust boundary, and the risks they bring with how
each is handled.

**Why this priority**: Principle V requires the Threat Model section, and `docs/threat-model/`, to be
updated in the same change that adds a credential type or crosses a new trust boundary. This milestone
does both.

**Independent Test**: Read the Threat Model section and the committed threat model after the change,
and check that each item of FR-050 is there, and that the threat model's checks pass on the pull request.

**Acceptance Scenarios**:

1. **Given** the change, **When** the constitution's Threat Model section is read, **Then** provider
   keys are listed as a current asset and the outbound provider connection as a current boundary, with
   the risks of FR-050.
2. **Given** the change, **When** `docs/threat-model/` is checked on the pull request, **Then** it
   matches the section and its checks pass.

---

### Edge Cases

- **Hosted or local.** Whether data sent to a provider leaves the install decides the notice
  Milestone 8 shows and what operators are told. The layer reports one of the two for every configured
  provider. An address alone cannot reliably tell a local Ollama from a hosted endpoint: a private
  address may be a proxy to a hosted service. So the layer never guesses from the address. Every
  provider counts as hosted unless the operator declares an OpenAI-compatible provider local. The
  safe mistake is a notice shown for a local model, never one missing for a hosted one. The
  declaration is the operator's statement. Scrylux does not check it, and the documentation says
  that.
- **A local model without schema-constrained output.** Some OpenAI-compatible servers, or older
  versions of them, cannot be told to follow a schema. The adapter then asks for JSON in the
  instructions only. The answer is checked against the schema all the same, so such a model may need
  more attempts or fail more often, but it can never return an invalid object as a success.
- **Answer cut off at the output limit.** An answer that stops because it reached its output-size
  limit fails as "output limit reached" and is not asked again with the same limit, because the same
  limit would cut it off again. The caller may retry with a larger one.
- **Input too large for the model.** The provider's refusal of an over-long input fails as "input
  too large" and is not retried. Some local servers (Ollama can) shorten an over-long input
  to their context window instead of refusing it, for generation and for embeddings. The layer cannot
  see that happen. The documentation tells operators to set such a server's context length, and the
  answer is still checked against its schema.
- **The model declines to answer.** A refusal fails as "refused" and is not retried.
- **Rate limits and outages.** A rate limit, a server error, a dropped connection or a timeout is
  retried with growing waits up to the retry limit (FR-022). A provider that asks the caller to wait
  longer than the longest wait the layer accepts fails as "rate limited" at once, rather than holding
  the caller.
- **Wrong or revoked key.** The provider's rejection fails as "not authorized" and is not retried.
  The message says to check the key and never shows it.
- **Cancelled while waiting to retry.** A request cancelled between attempts stops without sending
  the next attempt.
- **Changing the embedding model.** Vectors from different embedding models, or of different
  dimensions, cannot be compared. The layer names the model and dimension on every result so that
  Milestone 3 can tell stored vectors apart. Deciding what to do with vectors from an earlier model is
  Milestone 3's concern.
- **Azure deployment names.** Azure OpenAI addresses a model by a deployment name the operator
  chose, so Scrylux cannot tell the underlying model from it and the shipped price list cannot match
  it. Its cost is unknown unless the operator sets its price (FR-033b).
- **A stale price list.** Provider prices change. The list says when each price was checked, and an
  operator who sees a wrong price can set the right one (FR-033b) without waiting for a release.
- **A price for an unconfigured model.** Operator prices apply only to the configured generation
  and embedding models. There is no setting for any other model.
- **A base address with credentials in it** (`https://user:pass@host`) is accepted, but is treated
  as a secret: it is never logged or printed, like a key.
- **Bedrock region without the model.** A model not enabled in the configured region fails as "not
  available" when called, and the check (US6) reports it. Starting Scrylux does not test it.
- **A vendor variable left in the environment.** An install that once ran another tool may still
  have, say, `OPENAI_API_KEY` or `ANTHROPIC_BASE_URL` set. A provider's client library could pick it up
  on its own, and send a key Scrylux never checked, or send to an address Scrylux never validated. So
  while a provider is configured, Scrylux refuses to start until such a variable is removed (FR-043a).
  AWS's endpoint variables (`AWS_ENDPOINT_URL` and its per-service forms) are refused only while Bedrock
  is configured, so an install that points its secrets-manager client elsewhere is not affected
  otherwise.
- **Two processes sharing the configuration.** Milestone 2's worker will read the same settings as
  the API. The layer keeps no state between requests, so any number of processes can use it at once.

## Requirements *(mandatory)*

### Functional Requirements

**Configuration**

- **FR-001**: The layer MUST be configured only through environment values or the existing
  secrets-manager secret (Principle IV). Generation and embeddings are selected separately: a
  provider and a model for each.
- **FR-002**: The accepted generation providers MUST be Anthropic, OpenAI-compatible, AWS Bedrock and
  Google Gemini. The accepted embedding providers MUST be OpenAI-compatible, AWS Bedrock and Google
  Gemini, because Anthropic offers no embeddings of its own.
- **FR-002a**: Gemini MUST be reached through the Gemini Developer API with an API key, at Google's
  own address. Gemini through Google Cloud's Vertex AI is out of scope for this milestone.
- **FR-003**: The OpenAI-compatible provider MUST take a base address, so that one adapter serves
  OpenAI, Azure OpenAI, Ollama and vLLM. A key MUST be optional for it, since a local server usually
  needs none.
- **FR-003a**: An OpenAI-compatible base address MUST use `https`, unless the provider is declared
  local (FR-044a), in which case `http` is also accepted. An `http` address for a provider that is not
  declared local MUST stop Scrylux from starting (FR-006). The message MUST say that a hosted provider
  needs `https` and that a local one must be declared local. Any other scheme is refused.
- **FR-004**: AWS Bedrock MUST take a region and use the platform's standard AWS credentials (an
  instance or task role, or the usual AWS environment values). It MUST NOT require a separate key.
- **FR-005**: With no generation and no embedding provider set, Scrylux MUST start and behave exactly
  as v0.1 does, and MUST make no connection to any model provider.
- **FR-006**: When a provider is selected, every setting it needs MUST be checked when Scrylux
  starts. A missing or malformed setting MUST stop Scrylux from starting, with a message that names the
  setting and the problem and never shows its value. The one exception is a provider name that is one of
  the accepted names, which a message may repeat ("… when LLM_PROVIDER is anthropic"), because it is
  fixed text. In this milestone the API process does this check, because it is the only process.
- **FR-007**: Starting Scrylux MUST NOT contact a provider. `/health` MUST NOT depend on any provider.
- **FR-008**: Provider API keys MUST be accepted from the environment and from the existing
  secrets-manager secret, with the same precedence the secret has today.
- **FR-009**: An embedding provider MUST be optional, even when a generation provider is configured.
  Without one, Scrylux starts, the layer reports embeddings as not configured, and every embedding
  request fails as "not configured". Whether Milestone 3 requires one is Milestone 3's decision.
- **FR-010**: Each attempt of a request MUST have a time limit of 300 seconds by default. The operator
  can change it, for example for slow local hardware, with one setting that applies to generation and
  embeddings alike. An attempt that runs out of time fails as "provider unavailable", and FR-021 and
  FR-022 decide whether it is retried. There is no separate limit for the whole request. It is bounded
  by the calls it can make, each under the time limit: at most 5 attempts (3 schema attempts, FR-014,
  and 2 transient retries, FR-022), plus at most 4 resends made because the provider refused a setting
  (temperature, two steps of the output format, and the name of the output-size setting; FR-015b),
  plus the waits of FR-022. A provider that never answers stops the request after 3 attempts (SC-008).
- **FR-011**: Every setting the layer reads MUST be documented in the environment-variable table in
  `docs/install.md`, and the documentation MUST show a working configuration for each provider:
  Anthropic, OpenAI, Azure OpenAI, Ollama, vLLM, Bedrock and Gemini. Where a provider's terms let it use
  submitted data to improve its products (for example the Gemini API's unpaid tier), the documentation
  MUST say so next to that provider's configuration.

**Structured results**

- **FR-012**: A structured request MUST take: a schema for the result, instructions, optional
  untrusted content, an output-size limit (with a default of 16,000 tokens when none is given), an
  attempt limit and a way to cancel it.
- **FR-013**: The layer MUST return a result only if it matches the schema exactly, with no missing
  or extra fields. Otherwise it MUST return a failure and no object.
- **FR-014**: When an answer does not match the schema, the layer MUST ask again, telling the model
  what was wrong, until the attempt limit is reached. The default limit MUST be 3 attempts in all, and
  the caller MAY set a lower one, including 1 (no retry). Answers that were cut off (FR-020) are not
  asked again.
- **FR-015**: Each adapter MUST use its provider's own way of constraining output to a schema where
  the provider and model support it, and fall back to asking for JSON in the instructions where they
  do not. In both cases FR-013 applies.
- **FR-015a**: Every structured request MUST be sent with a temperature of 0 where the model accepts a
  temperature, and with none, so the provider's default applies, where it does not. A model does not
  accept one if it refuses the setting, or if its vendor documents that it should be left at its default
  (as Google does for Gemini 3). Which models those are MUST be kept in a versioned data file in the
  repository. The value is fixed: neither the caller nor the operator can set it. Embedding requests have
  no temperature.
- **FR-015b**: A model that does not accept a temperature MUST NOT make a request fail or use an extra
  attempt because of it. The usage record MUST say whether the fixed temperature was applied, so that
  eval results from models with and without it can be told apart.
- **FR-016**: The interface a caller uses MUST be the same for every provider. Nothing outside the
  layer may depend on one provider's API (Principle VI).

**Embeddings**

- **FR-017**: An embedding request MUST take a list of texts and a way to cancel it, and return one
  vector per text in input order, the model's name, and the dimension, with every vector of that
  dimension.
- **FR-018**: A list longer than the provider accepts in one call MUST be split and reassembled in
  order. The whole request MUST have one usage record and succeed or fail as a whole.
- **FR-019**: A text too long for the embedding model MUST fail the request, naming its position in
  the list. The layer MUST NOT shorten it silently.

**Failures and retries**

- **FR-020**: Every failure MUST be one of a fixed set of categories that callers can act on: not
  configured, not authorized, not available (an unknown model, or one not enabled), rate limited,
  provider unavailable (server error, dropped connection or timeout), input too large, output limit
  reached, refused, rejected (the provider refused the request itself as malformed, for a reason the
  layer could not work around), invalid output, and cancelled. Its message MUST be fixed text for that
  category.
  It never includes a key, a base address, the prompt, the content or the model's answer.
- **FR-021**: Only rate limits and provider-unavailable failures MUST be retried by the layer. Every
  other category fails at once, apart from invalid output, which FR-014 governs.
- **FR-022**: Transient retries MUST be bounded: at most 2 per request in total, across its schema
  attempts, so a request makes at most 3 tries against a failing provider, with growing waits. A wait
  the provider asks for MUST be honoured up to 60 seconds. A provider that asks for longer fails as
  "rate limited" at once.
- **FR-023**: Cancelling a request MUST stop it, including during a wait between attempts, and it
  MUST then fail as "cancelled" with the usage known so far.
- **FR-024**: Job-level retries, queues and caps are not part of the layer. They are Milestone 2's.

**Usage and cost**

- **FR-030**: Every finished request, successful or not, MUST return a usage record: provider, model,
  operation, input tokens, output tokens, whether the tokens were estimated, cost or "unknown", where
  the price came from (FR-033), whether the fixed temperature was applied (FR-015b, structured
  requests only), the number of attempts, duration and outcome.
- **FR-031**: Token counts and cost MUST cover every attempt of the request.
- **FR-032**: When a provider does not report token usage, the layer MUST estimate it from the text
  and mark it as estimated. It MUST NOT report zero.
- **FR-033**: Cost MUST be the request's input and output tokens times the model's price per input
  and per output token. The price comes from the operator's setting for that model when there is one,
  and otherwise from the shipped price list. A request whose model has neither MUST report its cost as
  unknown, never as zero. The usage record MUST say which source the price came from, and MUST mark a
  cost worked out from estimated tokens as estimated.
- **FR-033a**: Scrylux MUST ship a price list as a versioned data file in the repository (Principle IV).
  It covers the text-generation and text-embedding models that each hosted provider's pricing page
  (Anthropic, OpenAI, Bedrock and Gemini) lists with a price on the day it is checked. Each entry gives
  the provider, the model, the price per input and per output token in US dollars, the date the price
  was checked and where it was published. The tests MUST check every entry's shape, and MUST check that
  no model appears twice for one provider.
- **FR-033b**: The operator MAY set an input and an output price for the configured generation model,
  and an input price for the configured embedding model (embeddings have no output tokens). An operator
  price MUST take precedence over the list. A negative or malformed price, or a generation input price
  set without its output price (or the reverse), MUST stop Scrylux from starting (FR-006). A price of zero is allowed, for an operator who wants a local
  model counted as free.
- **FR-033c**: A local model (FR-044a) MUST NOT be counted as free unless the operator sets its price
  to zero. Without that, its cost is unknown, like that of any model without a price.
- **FR-034**: Each request MUST write exactly one log line to the process's log output with the usage
  record's fields and nothing else: no prompt, content, answer, key or base address (Principle IV). The
  server writes it to stdout. The check command (FR-046) writes it to stderr, so that its report on
  stdout can be read on its own. Logging prompts and answers is not offered in this milestone.

**Untrusted content and safety**

- **FR-040**: A request MUST keep instructions and untrusted content apart. Instructions go in the
  provider's instruction position. Untrusted content goes only inside a clearly marked content
  section, which text inside the content cannot end early.
- **FR-041**: The fixed text the layer adds to a prompt (the content section's markers and the
  explanation that its contents are data, not instructions, and the wording of a schema retry) MUST be
  kept in versioned data files in the repository, not in code (Principle IV).
- **FR-042**: The layer MUST offer callers no way to give the model tools, and MUST NOT execute
  anything in an answer. An adapter that uses a provider's tool mechanism internally only to obtain
  schema-shaped output MUST treat the result as data to check, nothing more.
- **FR-043**: API keys MUST NOT appear in any log line, error, usage record, check output or response
  to the browser, and MUST NOT be stored in the database (Principle I).
- **FR-043a**: When a provider is configured, Scrylux MUST refuse to start while an environment variable
  is set that a provider's client library would read on its own, for example a vendor's own key,
  address, extra-headers, logging or telemetry variable. This keeps any credential, address, header or
  logging setting from reaching a provider without Scrylux's checks. The message MUST name the
  variable. AWS's standard credential, profile and region variables are exempt, because Bedrock is meant
  to use them (FR-004), and the exempt variables MUST be listed by name. AWS's endpoint variables are not
  exempt: they change the address a request goes to, so they MUST stop Scrylux from starting while
  Bedrock is configured. The lists MUST be kept in step with the client libraries by a test.
- **FR-044**: For every configured provider, the layer MUST report whether data sent to it leaves the
  install (hosted) or stays in it (local), so that the rest of Scrylux can tell operators and, from
  Milestone 8, users. The classification MUST follow the edge case "Hosted or local". Anthropic,
  Bedrock and Gemini are always hosted.
- **FR-044a**: A provider MUST count as hosted unless the operator declares it local. Only an
  OpenAI-compatible provider MAY be declared local, separately for generation and for embeddings. A
  local declaration for Anthropic, Bedrock or Gemini MUST stop Scrylux from starting (FR-006).
- **FR-045**: The rest of Scrylux MUST be able to ask the layer whether generation and embeddings are
  configured, and whether each is hosted or local, without access to any key.

**Operator check**

- **FR-046**: Scrylux MUST provide a command an operator runs where Scrylux is deployed (including
  inside its published container) that sends one tiny fixed request with no user data to each
  configured operation and reports, for each: provider, model, hosted or local, success or failure
  category with a hint, and usage, including where the price came from or that it is unknown. It MUST
  exit with failure if any configured operation fails.
- **FR-047**: The check's fixed request MUST be kept in a versioned data file, like any other prompt
  (FR-041).

**Threat model and documentation**

- **FR-050**: The constitution's Threat Model section and `docs/threat-model/` MUST be updated in the
  same change (Principle V) to list: LLM provider API keys as a current asset; the outbound connection
  from Scrylux to a hosted model provider as a current trust boundary (a local model stays inside it);
  and the risks with their handling: a key disclosed (keys only from the environment or secrets
  manager, never logged, stored or sent to the browser); a hosted provider as a path for data to leave
  the install (no user content is sent in this milestone; the notice is Milestone 8's); a hostile or
  misconfigured endpoint answering with crafted output (every answer checked against its schema, no
  tools, nothing executed); runaway spend or a hung request (time limits and bounded retries here,
  per-job caps in Milestone 2).
- **FR-051**: The tests MUST run without any real provider and without any repository secret, using
  simulated provider responses for every adapter, so that pull requests from forks get the same
  results (constitution, Information Disclosure).

### Key Entities *(include if feature involves data)*

- **Provider configuration**: per operation (generation, embeddings), the chosen provider, model,
  base address or region, key if any, and the derived hosted-or-local classification, plus one time
  limit that both operations share. Read
  once when a process starts, never stored in the database.
- **Structured request**: a schema, instructions, optional untrusted content, output-size limit,
  attempt limit and a cancellation signal.
- **Embedding request**: an ordered list of texts and a cancellation signal.
- **Result**: either a schema-valid object or a list of vectors with model name and dimension, plus a
  usage record; or a failure category with fixed message, plus a usage record.
- **Usage record**: provider, model, operation, input tokens, output tokens, estimated or reported,
  cost or unknown, price source, temperature applied (structured requests only), attempts, duration,
  outcome. Returned to the caller and logged. Persisting it is
  Milestone 2's concern.
- **Locality declaration**: the operator's statement, per operation, that an OpenAI-compatible
  provider is local. Without it every provider is hosted.
- **Price entry**: a model's price per input and per output token in US dollars. It comes either
  from the shipped price list, with the date it was checked and its published source, or from the
  operator's settings. An operator price takes precedence.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With no provider configured, the full v0.1 test suite, including the browser tests,
  passes unchanged, and Scrylux starts and answers `/health` as before.
- **SC-002**: Against simulated responses, 100% of structured results returned as successes by each
  of the four adapters match their schema, and 0 invalid answers are returned as results, across every
  failure scenario in US1 and the edge cases.
- **SC-003**: An operator can switch an install between a hosted provider and a local Ollama model by
  changing environment values and restarting, with no change to code or files, and the check (US6)
  passes for both. This is verified once by hand with a real hosted provider and a real Ollama before
  the milestone closes.
- **SC-004**: 100% of requests, successful or failed, produce exactly one usage record and one log line.
  No request whose price or token usage is unknown reports a cost or token count of zero.
- **SC-004a**: For every model in the shipped price list, a request's cost matches the list's prices to
  the cent on a known token count. With an operator price set, 100% of requests to that model use the
  operator's price.
- **SC-005**: A recognizable fake key and recognizable fake document content, run through every success
  and failure category, appear in 0 log lines, errors, usage records or check outputs.
- **SC-006**: Every misconfiguration listed in US2 stops Scrylux from starting, with a message that
  names the setting and holds 0 setting values, apart from an accepted provider name (FR-006).
- **SC-007**: A cancelled request stops within 1 second of being cancelled, whether it is waiting on the
  provider or between attempts.
- **SC-008**: A request against a provider that keeps failing with a transient error gives up after at
  most 3 attempts. A provider that never answers takes no longer than 3 times the per-attempt time
  limit plus the bounded waits of FR-022: about 15 minutes at the 300-second default.
- **SC-009**: The tests need no network access to a model provider and no repository secret.
- **SC-010**: The updated threat model passes its pull-request checks, and a reviewer can find the
  provider key asset and the provider boundary in both the constitution and `docs/threat-model/`.

## Assumptions

- **Scope is fixed by plan.md, plus Gemini.** The Anthropic, OpenAI-compatible and Bedrock adapters, and
  the providers the OpenAI-compatible adapter covers, are named by Phase 3 Milestone 1. The maintainer
  added Gemini during planning, and this milestone's change updates `plan.md` and `docs/roadmap.md` to
  match. They are the
  scope, not a choice of implementation.
- **No user content goes to a provider in this milestone.** The only live request Scrylux makes is the
  operator's check, with fixed text. The UI notice that data leaves the install (Principle VI) is
  therefore needed no later than the first milestone that sends user content. Plan.md places it in
  Milestone 8, but Milestone 3 sends document chunks for embedding, so Milestone 3 needs it at the
  latest. This milestone supplies the hosted-or-local fact it will show (FR-044, FR-045), and its change
  records the Milestone 3 deadline in `plan.md`. The constitution's 1.14.0 amendment states that the
  notice of Principle VI is required from the first milestone in which user content can reach a
  provider. The check command's fixed request holds no user content.
- **The eval gate does not apply yet.** Principle II requires adapter changes to pass `pnpm eval`
  once an LLM-backed feature exists. The harness is Milestone 7, and this milestone ships no feature
  that uses a model, so its gate is the unit tests against simulated responses plus the manual check of
  SC-003. The constitution's Development Workflow section says "from Phase 3 onward" without that
  condition, so the 1.14.0 amendment aligns its wording with Principle II, and the pull request says so.
- **Azure OpenAI is reached through its OpenAI-compatible endpoint**, with the deployment name as the
  model name. If that endpoint turns out to need something the OpenAI-compatible adapter cannot give it,
  the plan says so, and it stays inside the same adapter.
- **Bedrock**: generation uses models that Bedrock serves through its common conversation interface,
  and embeddings use an Amazon embedding model. The exact models listed as tested are the plan's
  choice.
- **Retries inside the layer are per request and short.** Longer recovery, such as retrying a whole
  job later, is Milestone 2's.
- **Defaults chosen here**, adjustable in the plan if research shows a reason: 3 attempts for schema
  retries, 3 attempts for transient errors, waits honoured up to 60 seconds, and an output limit of
  16,000 tokens unless the caller asks for more. The output limit was 4,096 in the first draft. Planning
  raised it, because current models that always reason (for example Claude Opus 5.5, Gemini 3 and
  OpenAI's reasoning models) count their reasoning against the output limit, so 4,096 would cut off
  ordinary answers (research.md). The 300-second per-attempt time limit and the temperature of
  0 were settled in clarification, not chosen here.
- **No new runtime service.** The layer is code inside Scrylux's existing processes. A local model
  (Ollama or vLLM) is run by the operator, not shipped in Scrylux's compose file.
- **The worker does not exist yet.** In this milestone the API process validates the configuration at
  start-up. Milestone 2's worker will read the same configuration and validate it the same way.
