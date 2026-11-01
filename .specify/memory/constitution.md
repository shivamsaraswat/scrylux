<!--
Sync Impact Report
==================
Version change: 1.14.0 → 1.15.0
Rationale: Phase 3 Milestone 2 (the worker and its jobs, specs/phase-3/milestone-2-worker-jobs/) adds a second process, the worker,
  and five job routes under `/api/v1`. The worker is the only process that talks to an LLM provider and the only one that holds
  its key; the API holds none. It adds assets (job records and their usage records, which hold no content), entry points (the
  five routes: start, list, read and cancel a job, and the Jobs page's status), a process, and a change in what any signed-in
  account can do (see and cancel every job, and start a provider check, which spends on the provider). Principle V requires the
  Threat Model section, and the committed model, to say so in the same change. This is a MINOR: materially expanded guidance
  (assets, entry points, a process, and the risks below) and a corrected layout rule. It adds no principle and no UI beyond the
  Jobs pages.
Modified principles:
  - III: the target layout no longer names `apps/worker`. The worker is a second entry point of `apps/api` (`dist/worker.js`, the
    same image with another command), so the image does not carry a second copy of the dependencies and one configuration loader
    serves both processes (research #2 of the milestone). The maintainer decided this at planning. `plan.md` changes with it.
  - V (applied, not reworded): the section and `docs/threat-model/` are updated in the same change.
Added sections: none (existing section set retained: Core Principles, Threat Model (STRIDE),
  Development Workflow & Quality Gates, Governance)
Removed sections: none
Threat Model changes: assets (job records and their usage records; the provider keys, now held by the worker alone), a process
  (the worker, started from the same image, with a health port that serves no data), entry points (the five job routes) and
  the outbound provider boundary, which the worker now uses, are added, with these risks:
  - Tampering: a job run twice, by a worker that was only slow and one that took the job over (mitigated: every write a worker
    makes is fenced by a claim number that only goes up; `apps/api/test/jobs/store.test.ts`, `apps/api/test/worker/recovery.test.ts`).
  - Information Disclosure: a provider key kept in the shared secrets-manager secret reaches the API process, which never uses it
    (accepted: both processes read that secret for the database credentials; set the keys in the worker's environment instead);
    job and usage records hold no prompt, answer, key or address (mitigated; `apps/api/test/worker/canary.test.ts`).
  - Denial of Service: runaway spend (partially mitigated: a token cap and a cost cap on every job, checked against the most the
    next request could use before it is sent and counting every run; a limit on an account's active jobs; a cooldown between its
    provider checks; a time limit on the whole job. Open: any account can create more accounts, and one request a crashed
    worker was making may be uncounted); a job that never ends (mitigated: the job's deadline); the job tables growing (accepted:
    kept indefinitely, small, and slowed by the cooldown).
  - Elevation of Privilege: any signed-in account can now see and cancel every job and start a provider check (a justified
    widening, until Phase 6 brings roles; bounded by the caps, the limit and the cooldown).
Development Workflow: unchanged. The eval gate does not apply: no prompt, adapter or extraction pipeline changed.
Development Workflow (kept): a pull request that updates the Threat Model section also updates `docs/threat-model/`.
Deferred / TODO items: none
Templates requiring follow-up: none checked in this run (scope of this change is the constitution file only; dependent
  templates read it at runtime per the scope guard).
Previous change (1.13.1 → 1.14.0): Phase 3 Milestone 1 (the LLM provider layer) added `packages/llm`, its four provider adapters, a
  configuration of 16 variables and an operator check command; an asset (LLM provider API keys, and the AWS role Bedrock uses),
  a trust boundary (the outbound connection to a hosted model provider) and four risks; the notice of Principle VI from the first
  milestone that sends user content; and the eval gate aligned with Principle II. A MINOR.
Previous change (1.13.0 → 1.13.1): the product was renamed from Specter to Scrylux before its first release, after the name check
  for v0.1 found "Specter" taken (docs/releasing.md). A PATCH: the name changed throughout, and no principle, section, rule or
  risk changed.
Previous change (1.12.0 → 1.13.0): Phase 2 Milestone 8 (release v0.1) published Scrylux for the first time through a
  tag-triggered release pipeline (`.github/workflows/release.yml`), the first workflow with a write permission. It added assets
  (the published image and the publishing credential), a trust boundary (the release pipeline against the pipelines of pull
  requests), an entry point (the creation of a `v*` tag), nine risks, and a rule for how a release is made. A MINOR.
-->

# Scrylux Constitution

## Core Principles

### I. Secure Coding by Default (NON-NEGOTIABLE)
All database access MUST use parameterized queries or a typed query builder (Kysely for the
threat-model tables behind `/api/v1`, since Phase 1 Milestone 5; plain `pg` with parameterized SQL
for login, users, admin seeding, browser sessions and sign-in throttling) — string-concatenated or
template-interpolated SQL is forbidden everywhere: values are always parameters. The one exception
is an SQL identifier (a table, column or database name), which cannot be a parameter. It may be
built into a statement only if it is a constant or comes from a fixed allow-list, and it MUST be
passed through the driver's identifier escaping (`pg.escapeIdentifier`, or the query builder's
equivalent); an identifier derived from request input is never allowed. All request input (body, params, query)
MUST be validated at the boundary before use — reject unknown shapes, enforce type/length/enum
constraints (via the shared zod schemas in `packages/core` for `/api/v1`; inline in
`apps/api/src/routes/login.ts`, `session.ts` and `users.ts`) rather than trusting the client.
Passwords MUST be hashed with bcrypt (or an equivalent memory-hard algorithm) at cost factor
≥ 10 and MUST NEVER be logged, returned in API responses, or stored in plaintext. Authentication
comparisons that branch on "does this identity exist" (e.g. login) MUST use a constant-time or
dummy-hash strategy to avoid user-enumeration timing leaks, per the existing `DUMMY_HASH`
pattern in `apps/api/src/auth.ts`. Secrets — `JWT_SECRET`, DB credentials, admin credentials, and, from
Phase 3 onward, LLM provider API keys — MUST be sourced from environment variables or a secrets
manager, MUST NEVER be committed to the repository, logged, stored in plaintext in the database,
or sent to the browser, and the process MUST refuse to start if a required secret is missing.
Session credentials and the browser UI's access tokens are credentials too: only a digest of a
session credential is ever stored, neither is logged or put in a URL, and the access token is held
in page memory only, never in browser storage.
Every non-public route MUST sit behind an authentication check (or an equivalent, explicitly
reviewed mechanism) — there is no default-allow. That includes the OpenAPI document served under
`/api/v1`. `/api/users` accepts only an `/api/login` bearer token. `/api/v1` also accepts a browser
UI's access token, checked against its still-active session on every request. The `/api/session`
endpoints are authenticated by the session cookie, which is the reviewed mechanism: `SameSite=Strict`,
scoped to that path, with an Origin check and a JSON content type on every request
(`apps/api/src/session/cookie.ts`).
**Rationale**: Scrylux stores STRIDE threat data and, later, an organization's design
documents and code context; a security lapse in the tool that tracks threats undermines its own
purpose. Non-negotiable because these are the few rules that, if violated, turn a code review
comment into a breach.

### II. Test-First Development
New behavior (routes, auth logic, validation, config loading, rule/threat-generation logic)
MUST have an automated test that fails before the change and passes after, following the
existing pattern in `test/config.test.js`. Bug fixes MUST first add a test that reproduces the
defect. The test suite (`npm test` today; `pnpm test` / Vitest, plus Playwright for key UI
flows, from Phase 1's monorepo scaffold onward per plan.md) MUST pass before a change is
considered complete. A change that cannot be tested without a live Postgres instance MUST
isolate the untestable part (e.g. via an injectable client, as `config.load()` already does)
rather than being left untested. Every PR MUST pass typecheck, lint, test (against a real
Postgres service container; this check also builds the app and runs the Playwright browser tests
against it, since Phase 1 Milestone 6), and Docker build — these are enforced by a branch ruleset on `main`
with no bypass actors, including for repository admins (`.github/rulesets/main.json`; see
`docs/ci.md`); Dependabot and CodeQL (query suite `security-and-quality`) MUST stay enabled and
remain informational/non-blocking in this milestone. Once any LLM-backed feature exists (Phase
3+), a change to a prompt, provider
adapter, or extraction/threat-generation pipeline MUST pass the eval harness (`pnpm eval`)
against its committed thresholds (starting point per plan.md: ≥70% threat recall, 100%
schema-valid output after retries, 100% valid citations) before merge. Tests assert observable
behavior (status codes, response shape, persisted rows, eval metrics) — not implementation
details.
**Rationale**: The project's own test suite is currently thin (one file); growing it test-first
keeps coverage honest as the app grows from a single Express service into a monorepo with an
AI pipeline, where regressions are far more expensive to find by hand.

### III. Code Quality & Simplicity
Modules stay small and single-purpose (one route file per resource, one concern per function),
matching `apps/api/src/v1/` and `apps/api/src/routes/` (one file per resource) and the target layout in
plan.md (`apps/api`, `apps/web`, `packages/core`, `packages/db`,
`packages/threat-library`, `packages/llm`; the worker is a second entry point of `apps/api`, `src/worker.ts`). From Phase 1 onward all code MUST be strict-mode
TypeScript; a bare `any` requires an inline justification. Do not introduce an abstraction,
configuration option, dependency, or a later phase's feature while an earlier phase is in
progress — plan.md is phased deliberately, and each phase MUST stay YAGNI relative to the
phases after it (e.g. no RBAC scaffolding while Phase 1–5 are in flight; no agentic tool-calling
while Phase 3 explicitly excludes it). Error responses MUST use a consistent `{ error: string }`
JSON shape and appropriate HTTP status codes. No dead code, no commented-out blocks, no unused
dependencies — delete rather than comment out.
**Rationale**: Simplicity is an explicit product goal (plan.md guiding principle: "small,
shippable phases... keep it YAGNI inside each phase"); building ahead of the current phase is
exactly the complexity creep plan.md is structured to prevent.

### IV. Maintainability & Observability
Configuration MUST come only from environment variables or a secrets-manager path (`apps/api/src/config.ts`
today) — never from local config files read at runtime. Logs MUST go to stdout/stderr only (no
file-based logging), and MUST NOT contain secrets, password hashes, full JWTs, or raw LLM
provider payloads (prompt/response logging is opt-in and off by default, per plan.md's AI
security hardening). Schema changes MUST be forward-only SQL files, tracked via the existing
`schema_migrations` mechanism (Kysely is used for queries only; migrations stay plain SQL files) — never edited in
place once merged. Every environment variable the app reads MUST be documented in the
environment variable table in `docs/install.md`. Per plan.md's cloud-friendly rules: `/health` MUST return 200 with
no auth and no DB dependency; the API and worker processes MUST remain stateless and
horizontally scalable; uploaded/ingested files MUST go through a storage abstraction (local
volume or S3-compatible), never an absolute local path. Threat-library rules, detection
heuristics, and LLM prompts MUST be stored as versioned data files in the repo (e.g.
`packages/threat-library`, a `prompts/` tree) rather than hardcoded inline, so they are
readable, diffable, and reviewable without reading application code.
**Rationale**: The app is deployed via env-var-only configuration to multiple environments
today, and plan.md commits to keeping every future phase self-hostable and horizontally
scalable; undocumented config, hidden file paths, or logic buried in code instead of data files
break that portability and make both incidents and prompt changes harder to review.

### V. Least-Privilege, Threat-Aware Design
Every new feature or endpoint MUST be checked against the Threat Model section below before
merge, and that section MUST be updated in the same change if the feature adds an asset, an
entry point, or crosses a new trust boundary — this applies in full to phase boundaries in
plan.md (e.g. Phase 3's document ingestion and LLM egress, Phase 4's repository/IaC access,
Phase 5's third-party integrations). New privileged operations (creating users, deleting data,
changing auth, connecting an external system) MUST default to the least-privileged design
available; a broader grant is permitted only when explicitly justified in the PR description.
The app currently has no role separation, and that gap is a known, tracked risk scheduled to
close with RBAC/SSO/audit logging in Phase 6 (see Threat Model) — until then, broadening what an
authenticated user can do MUST still be called out explicitly, not treated as free.
Scrylux's own threat model is committed in `docs/threat-model/` (a Scrylux file and its Markdown report, built
in Scrylux and checked on every pull request). The Threat Model section below governs: where the two
disagree, the model is corrected. A change that updates the section MUST update the model in the same
change; a change that only adds a rule to the threat library may follow with the update, because the
checks then only warn, while retiring or changing a rule makes them fail.
**Rationale**: A threat-tracking app is a natural target and a credibility risk if it is itself
insecure (plan.md guiding principle: "secure by default, and dogfooded — Scrylux keeps its own
threat model, built in Scrylux"); treating the threat model as a living document keeps security
review proportional to what actually changed, phase over phase.

### VI. AI Output Is a Draft With Provenance, Never Silent
From the moment any LLM-backed feature exists (Phase 3 onward): every AI-proposed element,
threat, or mitigation MUST carry its rationale and a citation to the source text, chunk, or code
it came from. Nothing AI-generated MUST enter the threat model without an explicit human accept
action — draft and accepted state are always distinguishable in the data model (`origin`:
`manual` / `rule` / `ai`). LLM structured output MUST be validated against its zod schema before
it is written to the database; output that fails validation MUST be retried or rejected, never
persisted as-is. Uploaded or ingested documents (and, from Phase 4, repository/IaC content) MUST
be treated as untrusted input: clearly delimited in prompts, never executed, and never allowed
to trigger a tool call or an autonomous action on their own — Phase 3 and Phase 4 are explicitly
scoped to exclude agentic tool-calling. AI-generated text MUST be rendered escaped in the UI. The
LLM provider integration MUST stay behind Scrylux's own provider-agnostic interface
(`packages/llm`) — no feature may hard-depend on one vendor's API, and a fully local model
(e.g. Ollama/vLLM) MUST remain a supported path. When a non-local, hosted provider is configured,
the UI MUST clearly disclose that data leaves the install. That notice is required from the first milestone in which user content can
reach a provider (Phase 3 Milestone 3, which sends document chunks for embedding); a request made only of fixed text that Scrylux
ships, such as the operator's check of its configuration, holds no user content.
**Rationale**: This is Scrylux's core trust proposition (plan.md guiding principles: "AI output
is a draft with provenance... nothing AI-generated enters the threat model silently", "private
by default", "provider-agnostic LLM layer") — without it, an AI-assisted threat model is not
more trustworthy than an unreviewed guess, and self-hosters lose the reason to choose Scrylux
over a vendor-locked competitor.

## Threat Model (STRIDE)

This section reflects the application as implemented today (Node.js/Express 5 API with a versioned
JSON API under `/api/v1`, browser sessions under `/api/session`, the React web app it serves,
PostgreSQL, optional AWS Secrets Manager, and an optional outbound connection to an LLM provider) and MUST be kept current per
Principle V as each phase in plan.md lands. Phase boundaries that will change this section are
called out inline below; they are not yet implemented and MUST NOT be treated as mitigated until
they ship.
`docs/threat-model/` holds the same threat model as a Scrylux file and a report, kept in step with this
section; this section governs.

**Assets (current)**: user credentials (`users.password_hash`); the JWT signing secret; database
credentials; issued JWTs (bearer tokens) held by clients; the CI/CD pipeline's own integrity — the
`GITHUB_TOKEN`, third-party GitHub Actions steps, the base and service container images it pulls
(Phase 1 Milestone 2, `specs/phase-1/milestone-2-ci-pipeline/`), and, since Phase 1 Milestone 6, the Playwright browser
binaries and system packages the `test` job downloads; threat-model records — projects, threat models,
elements, threats and mitigations (Phase 1 Milestone 3, `specs/phase-1/milestone-3-domain-schema/`), stored in the
database and, since Phase 1 Milestone 5 (`specs/phase-1/milestone-5-rest-api-v1/`), readable and writable by any
authenticated account through `/api/v1`; browser sessions (`browser_sessions`, Phase 1 Milestone 6,
`specs/phase-1/milestone-6-react-app-shell/`), whose session credentials are stored only as SHA-256 digests, the
short-lived access tokens the UI holds in page memory, and the sign-in failure counts
(`sign_in_throttle`), whose keys are HMACs of what was typed and of the client address. The original
threat entry records and Milestone 4's legacy links no longer exist: Milestone 5 removed them. Since Phase 2 Milestone 8: the
published image, `ghcr.io/shivamsaraswat/scrylux`, which every user runs, and the credential the release pipeline holds to publish
it (the run's `GITHUB_TOKEN` as held by its two publishing jobs; no other secret exists in that pipeline). Since Phase 3 Milestone 1
(`specs/phase-3/milestone-1-llm-provider-layer/`): LLM provider API keys (`LLM_API_KEY` and `EMBEDDING_API_KEY`, from the environment
or the secrets-manager secret, never in the database) and, for Bedrock, the AWS role of the host. Since Phase 3 Milestone 2
(`specs/phase-3/milestone-2-worker-jobs/`): job records and the usage record of every model request a job made (`jobs`, `job_usage`
and `workers`, kept indefinitely), which hold no prompt, answer, key or address; and the provider keys are held by the worker
process alone, which is the only one that sends a request to a provider.
**Assets (planned, not yet implemented)**: from Phase 3 — uploaded design documents, extracted
text chunks and embeddings, and the LLM outputs derived from them; from
Phase 4 — read-only repository/IaC access tokens and cloned source code; from Phase 5 —
third-party OAuth tokens (Jira, Confluence, Google Docs, Linear, Azure DevOps) and outbound
webhook targets.

**Trust boundaries (current)**: Internet → load balancer/reverse proxy → Express app
(`apps/api/src/app.ts`) → PostgreSQL (`apps/api/src/db.ts`); API clients → JSON API (`/api/login`,
`/api/session`, `/api/users` and `/api/v1`, with its OpenAPI document; since Phase 2 Milestone 1 `/api/v1`
includes `POST /api/v1/threat-models/{id}/elements/batch`, which writes up to 200 elements in one request, and since Phase 2 Milestone 3 `POST /api/v1/threat-models/{id}/threats/generate`, which creates the threats and mitigations the shipped rules propose for a diagram, and since Phase 2 Milestone 5 `GET /api/v1/threat-models/{id}/report`, which answers with a whole threat model as a Markdown or an HTML document to download, and since Phase 2 Milestone 6 `GET /api/v1/threat-models/{id}/export`, which answers with a whole threat model as a JSON file (the Scrylux file or OTM), and `POST /api/v1/projects/{id}/imports/check` and `POST /api/v1/projects/{id}/imports`, which read an untrusted file of up to 64 MiB and, for the import, create threat models from it; `/api/v1` has authenticated a request before reading its body since the same milestone),
where everything but login and
session sign-in sits behind authentication: a bearer token for `/api/users` and `/api/v1`, the session
cookie for the rest of `/api/session`. Since Phase 1 Milestone 6 the same app also serves the web app
the browser loads (`apps/api/src/web.ts`, with a strict CSP), so a browser → UI boundary exists, and
the UI's own scripts run inside the user's authenticated session. The
app itself has a single trust tier: any holder of a valid JWT is fully trusted. Since Phase 1
Milestone 2, a CI/CD boundary also exists: GitHub Actions workflows — including on pull requests
from forks — run against this repository's contents with a scoped, read-by-default
`GITHUB_TOKEN`, and pull third-party actions and container images from outside the repository. Since Phase 2 Milestone 8 a second
boundary sits inside it: the release pipeline (`.github/workflows/release.yml`) is the only workflow that holds a write permission
(`packages: write` in one job, `contents: write` in another, nothing by default), and it is started by one entry point, **the
creation of a `v*` tag**, which only the repository owner can make (ruleset `release-tags`); the pipelines of pull requests, of
forks included, hold none. Since Phase 3 Milestone 1 an outbound boundary also exists: from the Scrylux process to a hosted LLM
provider (Anthropic, OpenAI or Azure OpenAI, Amazon Bedrock, Google Gemini, or an OpenAI-compatible endpoint that the operator has
not declared local). Today the worker (for the provider check that a signed-in person starts from the Jobs page) and the operator's
check command (`node dist/llm-check.js`) use it, both with fixed text and no user data.
A model on the operator's own hardware, declared local, stays inside the trust boundary. Since Phase 3 Milestone 2 the worker is the
process that crosses it (`apps/api/src/worker.ts`, started from the same image with another command; it imports no Express and no
route, and the API never reaches the code that sends a provider request, `apps/api/test/worker/imports.test.ts`). It holds the
database credentials and the provider keys, and nothing of the web sign-in. Its health port (`WORKER_HEALTH_PORT`, 3001) answers
`GET /health` with 200 and serves nothing else; the compose files do not publish it. The entry points it adds are five authenticated
routes under `/api/v1`: `GET /jobs/status`, `GET /jobs`, `POST /jobs`, `GET /jobs/{id}` and `POST /jobs/{id}/cancel`. The OpenAPI document
describes them. The only job kind is the provider check, which sends the layer's fixed request and takes no input from the person who
starts it.
**Trust boundaries (planned)**: Phase 3 adds an inbound boundary for untrusted document content flowing into prompts
(Milestone 3 onward; prompt-injection surface — see Principle VI). Phase 4 adds a boundary into external source-control/IaC systems (read-only,
code never executed). Phase 5 adds boundaries into external SaaS integrations and inbound
webhooks.

- **Spoofing**: Sign-in (`POST /api/login` and `POST /api/session`) is unauthenticated by design.
  *Mitigated*: username enumeration via response timing is defended with a dummy bcrypt comparison
  (`apps/api/src/auth.ts:DUMMY_HASH`), and throttling behaves the same whether or not the username
  exists. *Mitigated (Phase 1 Milestone 6)*: failed sign-ins are throttled per username-and-address and
  per address (`apps/api/src/session/throttle.ts`), with no per-account lockout, so an attacker
  cannot lock the admin out; an IPv6 address counts as its /64; the counted address is the socket
  address unless `TRUST_PROXY` names a trusted proxy. Session theft is mitigated: the long-lived
  credential is an HttpOnly cookie that scripts cannot read, it rotates on every renewal, and
  replaying a replaced credential after a 30-second grace window ends the session (and is logged as
  reuse). *Residual risks*: a thief who replays a just-replaced credential inside the grace window
  gets one 5-minute access token and no new credential; guessing spread across many addresses or many
  /64s is slowed per address but not stopped; `/api/login` bearer tokens are not revoked by sign out
  everywhere and live until they expire; a credential more than one rotation old matches nothing and
  is answered 401 without triggering reuse detection, because only the previous credential is stored
  (the holder gains nothing, so no token-family table is kept). *Planned*: from
  Phase 3, indirect prompt injection from an ingested document could attempt to "spoof"
  instructions to the LLM (e.g. impersonate the system prompt); Principle VI's untrusted-input
  handling is the primary mitigation and MUST be verified before Phase 3 ships.
  *Accepted risk (Phase 2 Milestone 6)*: provenance can be claimed by a file. A Scrylux file, or an OTM file carrying Scrylux's
  mark, may say a threat is rule-generated, with any rule reference, and Scrylux cannot check it: generation then treats
  that threat as its own, so it may flag it stale or match it instead of creating one. Nothing else follows from it. The
  import is the only path by which a threat other than a manual one can be created outside generation (the API's create and
  update operations still refuse every other origin); a file with an AI-drafted threat is refused, as Principle VI requires
  until Phase 3 defines the rationale and citations such a threat carries; and every threat from another tool's file, OTM or
  Threat Dragon, is imported as manual, with its rule, stale mark and origin never read.
  *Mitigated (Phase 2 Milestone 8)*: a forged or mistaken version tag cannot publish a release. The release pipeline's gate refuses a
  tag that is not `vMAJOR.MINOR.PATCH`, a tag whose commit is not on `main`, and a tag whose package versions, changelog entry or
  required checks disagree (`scripts/release/gate.ts`, tested in `scripts/release/gate.test.ts`), and two tag rulesets let only the
  repository owner create or delete a `v*` tag and let nobody move one (`.github/rulesets/release-tags.json`,
  `release-tags-immutable.json`; `docs/ci.md`, `docs/releasing.md`). *Accepted risk (Phase 2 Milestone 8)*: a look-alike image or
  registry can be mistaken for the project's: the README and every release's notes name the exact image and its digest, and a user can
  be told no more than that without a signature; accepted until Phase 6 ("Verifiable release images", `plan.md`).
- **Tampering**: All SQL is parameterized or built with Kysely (`apps/api/src/v1/`,
  `apps/api/src/routes/users.ts`, `apps/api/src/auth.ts`) — no injection path found. Request bodies
  are size-capped at 100kb (`apps/api/src/app.ts`, and for `/api/v1` the per-operation parser in
  `apps/api/src/v1/router.ts`, which runs only after the request is authenticated, so a body is read and sized only for a
  signed-in account; the two import operations raise the cap to 64 MiB). CSRF: `/api/v1` and `/api/users` authorize only by a credential the client sends explicitly,
  never by a cookie, so no cross-site request can ride a session there. The one cookie
  (`scrylux_session`) reaches only `/api/session`, is `SameSite=Strict`, and those endpoints also
  require an Origin matching the request's host (Express's `req.host`, which honours
  `X-Forwarded-Host` only from a trusted proxy) and a JSON content type, which forces a CORS
  preflight the app never answers. *Planned*: from Phase 3, AI-proposed edits are a new
  tampering-like surface if they could reach the model without review; mitigated by Principle
  VI's mandatory human-accept step. *Mitigated (Phase 2 Milestone 1)*: an element's `properties` and
  `layout` are validated against a fixed vocabulary on every write (tags up to 20, 50 characters each;
  flags that belong to the element's type; positions in a fixed range; no other keys), by one schema in
  `packages/core` that the single-record endpoints and the batch endpoint share, and a batch is
  applied in one transaction, so a refused operation leaves nothing half-written. The editor draws
  every element name and tag as text, never as markup, under the same strict CSP.
  *Accepted risk (Phase 1 Milestone 6)*: the required `test` job downloads Playwright's browser
  binaries and system packages from outside the repository, pinned only by the lockfile's
  `@playwright/test` version, which Dependabot's cooldown and pnpm's `minimumReleaseAge` cover.
  *Mitigated (Phase 1 Milestone 2)*: every third-party GitHub
  Actions step is pinned to a full commit SHA, not a movable tag; the Docker base image and the
  CI database's service-container image are pinned by digest; Dependabot's npm updates carry a
  3-day cooldown on top of pnpm's own `minimumReleaseAge`; and a required `lint`-check step fails
  the build if `pnpm-lock.yaml` ever reverts to the multi-document format described below.
  *Accepted risk*: `pnpm-workspace.yaml` sets `pmOnFail: ignore` so the lockfile stays a single
  YAML document — required because GitHub's dependency graph misreads pnpm's two-document format
  as zero dependencies, silently disabling Dependabot alerts
  ([dependabot-core#15904](https://github.com/dependabot/dependabot-core/issues/15904)). The cost
  is that pnpm no longer verifies the running pnpm version against `packageManager` itself;
  Corepack and CI's own pinned install compensate. Revert once #15904 ships. *Mitigated (Phase 1
  Milestone 3)*: the database itself enforces the integrity of threat-model records, so no writer
  — the API, the rule engine, AI drafts — can store a structurally inconsistent model: references
  stay inside one threat model, data-flow endpoints and boundary parents have the right element
  types, trust boundaries stay acyclic, an element with threats cannot be deleted from under
  them, `risk` is derived and cannot be set, and `origin` has no default and cannot change after
  creation, so a rule- or AI-generated threat can neither be stored labelled as manual nor be
  relabelled later. *Mitigated (Phase 1 Milestone 5)*: a threat created through `/api/v1` is always
  `origin = 'manual'`: a request for `rule` or `ai` is rejected, and `origin` cannot be changed, so
  a client cannot fake rule or AI provenance (Principle VI). Only server-side writers may record
  those. *Mitigated (Phase 2 Milestone 3)*: the rule engine (`apps/api/src/rule-engine/`) is the only
  writer of `origin = 'rule'`. A generated threat's `element_id` and `library_ref` cannot change, whoever
  asks, and an unchanged value is not a change (`threats_rule_link_immutable`, in the database, answered
  `400` through `/api/v1`), so a client can neither re-point it nor fake which rule produced it. There is at
  most one generated threat per element and rule (`threats_rule_key`), a generated threat must name both
  (`threats_rule_link`), and `stale`, the marker that a generated threat no longer fits the diagram, is set
  only by the engine, only on generated threats (`threats_stale_rule_only`), and is outside every client
  schema. A run is one transaction under the threat model's lock, so a failure leaves nothing half-written.
  *Mitigated (Phase 2 Milestone 4)*: the rules for changing a threat's status hold for every client, because the
  server enforces them (`apps/api/src/v1/threats.ts`, with the shared schemas in `packages/core`): a reason is
  required with `accepted` and `not_applicable` and refused with the other statuses, and a new threat cannot be
  `mitigated`. A move into `mitigated` needs an implemented or verified mitigation. It is checked in the same
  transaction as the change, with the threat (`FOR NO KEY UPDATE`) and the mitigation it relies on (`FOR SHARE`)
  locked, so a mitigation downgraded or deleted at the same moment either fails the change or comes after it; the
  database cannot hold this rule itself, because a mitigated threat that later lost its implemented mitigation is a
  legal state. A reason can sit only on an `accepted` or `not_applicable` threat, whoever writes
  (`threats_status_reason_check`), and is at most 10,000 characters. Generating threats never changes
  a threat's status or reason. *Mitigated (Phase 2 Milestone 5)*: a report writes user text (names, tags, titles,
  descriptions, reasons, mitigation text, tickets) into three formats, and each has its own escaper in
  `apps/api/src/report/escape.ts`, so the text reads back exactly as typed and cannot become a heading, a list, a link,
  an image, markup or a script wherever the file is shown. Markdown: every ASCII punctuation character is
  backslash-escaped, leading spaces are entities, line breaks are hard breaks and text of more than one line is always
  in a block quote or list item, and user text is never in a table cell. Mermaid: every character but a letter, a digit
  or a space is a decimal entity inside double quotes, and node and group ids come from the order of the report, never
  from a name. HTML: the five characters `& < > " '` are entities in text and in attributes. A ticket is a link only if
  it is an http or https address. The HTML file is inert whatever its text says: a `<meta>` Content-Security-Policy,
  first in its head, allows no script and nothing from outside but its one stylesheet, by hash; the file has no `style`
  attribute (the hash does not cover one) and no script, and the API sends it with `sandbox; default-src 'none'`
  in place of the app's policy. The report's tests use real parsers, not matching of strings: a CommonMark and GFM
  parser for the Markdown, Mermaid in a browser with no network for the flowchart, and a browser opening the HTML
  from disk with no network, which also listens for policy violations.
  Milestone 4's legacy-link protection is retired with the
  links: Milestone 5 removed the imported data, the link table and the legacy entry table.
  *Mitigated (Phase 2 Milestone 6)*: an import writes the content of an untrusted file into the database, and is held
  to the rules of every other write. The file is bounded first, by a walk with its own stack, so a file nested a million
  levels deep is answered and not a stack overflow: at most 64 levels and 2,000,000 values. Only then is it parsed by
  schemas in `packages/core` (a Scrylux file strictly; OTM and Threat Dragon by the members Scrylux reads, with every
  other member accepted and never walked, stored or echoed). The rules across records (every reference resolves,
  nesting without cycles, flows between nodes, the element limit, a reason only on accepted or not applicable threats, a
  stale mark only on generated threats, one generated threat per element and rule, http and https tickets only) are applied
  by one function before any row is written, so a refusal names the place in the file and storage never has to refuse. It
  is all or nothing, in one transaction that locks the project, and the check and the import run the same code. A refusal
  is a fixed rule with a place, never a value from the file. The one deliberate exception to the lifecycle rules is the
  one a restore needs: a threat keeps the status it carries, and is then shown as missing what its status needs.
  Imported text is stored, and shown in the app and in reports, as text.
  *Mitigated (Phase 2 Milestone 8)*: a build or release step cannot be swapped for a malicious one unnoticed. Every third-party action
  of every workflow is pinned to a commit and the release workflow uses only first-party actions, which a test holds
  (`scripts/workflows.test.ts`); BuildKit is pinned by digest and refreshed by hand (`docs/ci.md`, `docs/releasing.md`).
  *Open risk (Phase 2 Milestone 8)*: a published image can be replaced after publication by whoever has write access to the package,
  because the registry does not enforce immutable tags. The pipeline never overwrites a version and completes a half-done release from
  the image already there (`scripts/release/gate.test.ts`), and the release notes print the image's digest so that a user can pin it;
  the image is not signed and carries no build attestation or SBOM. *Planned*: `plan.md` Phase 6, "Verifiable release images".
  *Mitigated (Phase 3 Milestone 1)*: a hostile or misconfigured model endpoint answering with crafted output. Every answer is
  checked against its schema before anything uses it, and a field the schema does not name makes it invalid
  (`packages/llm/src/attempts.ts`); the model is offered no tool and nothing in an answer is executed; and a hosted provider
  must be reached over `https`, with `http` allowed only for a provider the operator declares local, which is the operator's own
  statement and is not checked. *Mitigated (Phase 3 Milestone 2)*: a job run twice, by a worker that was only slow and one that took
  the job over. A job is held on a lease that its worker renews; every write a worker makes (progress, result, state) is fenced by a
  claim number that only a new claim changes, so a worker that lost its lease writes nothing after another has the job, and a job
  that has ended can never change again (a trigger refuses it). Usage records are not fenced, because a request that was made counts
  against the job's caps whoever records it (`apps/api/test/jobs/store.test.ts`, `apps/api/test/worker/recovery.test.ts`). A job
  input is checked against its kind's schema before it is queued, a provider check takes none, and no caps can be set by a request.
- **Repudiation**: *Open risk*: no audit trail persists who created, updated, or deleted a
  threat-model record or a user — the JWT's `sub` is known per-request but never written to storage.
  This is a notable gap precisely because Repudiation is one of the STRIDE categories the app
  itself is meant to help track. *Planned*: plan.md Phase 6 closes this gap with a persisted
  audit log of who changed what; until Phase 6 ships, this remains an accepted, tracked risk.
  *Partially mitigated (Phase 1 Milestone 5)*: every successful `/api/v1` create, update and
  delete writes one stdout line with the account id, action, record type and record id, never field
  values, so an operator has a trace. It is not persisted or tamper-evident, so the risk stays open
  until Phase 6's audit log. *Partially mitigated (Phase 1 Milestone 6)*: every sign-in, failed
  sign-in, throttled sign-in, logout, sign out everywhere and session end writes one stdout line with
  ids and an event name only, never a username, password, credential, token or client address.
  *Partially mitigated (Phase 2 Milestone 3)*: every generation run writes one stdout line with the
  account id, the threat model id and the counts of what it created and flagged, never a name or a threat's
  text; the threats and mitigations it creates get no line each. *Accepted risk (Phase 2 Milestone 4)*: accepting a
  risk or dismissing a threat is now a decision recorded with a reason, but not with who made it or when. The write
  log names the account and the threat, never the new status or the reason, and no history of earlier statuses is
  kept, so a later change overwrites the decision. Any signed-in account can make it (there are no roles until
  Phase 6). Phase 6's audit log closes this. *Partially mitigated (Phase 2 Milestone 6)*: an import writes one stdout line
  with the account id, the project, the ids of the threat models it created and counts of what it created and left
  out, never a name or any content of the file. The records it creates get no line of their own.
  *Open risk (Phase 2 Milestone 8)*: a user cannot tell who built an image, or from which commit, beyond its labels. The image carries
  its source repository and commit as labels (`scripts/release/versions.ts`), which the smoke run checks on both platforms before
  publishing and again after (`scripts/release/smoke.ts`). *Planned*: `plan.md` Phase 6, "Verifiable release images" (a signature, a build attestation and an SBOM).
- **Information Disclosure**: Generic 500s are returned to clients while details are logged
  server-side only (`apps/api/src/app.ts` error handler); `x-powered-by` is disabled. Secrets are never
  read from committed files (`.env` is gitignored) and can be sourced from AWS Secrets Manager.
  *Mitigated (Phase 1 Milestone 6)*: every response carries a strict Content-Security-Policy
  (own origin only, no inline code, no framing) and hardening headers
  (`apps/api/src/security-headers.ts`), brought forward from Phase 6; the UI renders all record text
  as text; and an injected script can no longer read a long-lived credential. Zod runs `jitless`
  (`apps/web/src/zod-config.ts`, which must stay the first import of the entry point), because its
  `new Function` probe would otherwise be reported as a CSP violation. *Mitigated (Phase 3 Milestone 1)*: an LLM provider API key comes only from
  the environment or the secrets-manager secret. It is never written to a log line, an error, a usage record or the check
  command's output, never stored in the database and never sent to the browser (`apps/api/test/llm/canary.test.ts` searches all of
  them for a fake key, fake document text and a fake password in an address). While a provider is configured, Scrylux refuses to
  start if a variable the provider libraries read on their own is set (a vendor key, address, extra header or logging switch), so
  none can reach a provider unchecked (`packages/llm/test/sdk-env.test.ts` keeps that list in step with the installed libraries).
  *Accepted for this milestone*: a hosted (non-local) LLM provider is itself a disclosure path for any data included in a
  prompt, and a fully local model MUST remain available for installs that cannot accept it. No user content is sent yet: only
  the operator's check, with fixed text. Principle VI's notice that data leaves the install ships with the first milestone that
  does send it (Phase 3 Milestone 3, which sends document chunks for embedding).
  *Mitigated (Phase 1 Milestone 2)*: no CI job references a repository secret; the `test` job's
  credentials are throwaway, non-secret development defaults defined directly in the workflow, so
  pull requests from forks get identical, fully-functional results with nothing to leak. Every
  job triggers on `pull_request`, never `pull_request_target`, and every checkout sets
  `persist-credentials: false`. *Mitigated (Phase 1 Milestone 5)*:
  `/api/v1` errors are fixed messages that never echo a submitted or stored value or the database
  driver's message and detail, and the write log carries ids only. Deleting the legacy data also
  removes it for good: an entry deleted on purpose can no longer reappear through a new endpoint. *Mitigated
  (Phase 2 Milestone 4)*: a status reason is user text, like a threat's description. The web app draws it as text, the
  API's refusals of it are fixed messages that never repeat it, and no log line holds it or the status it explains.
  *Accepted risk (Phase 2 Milestone 5)*: a report is a copy of a whole threat model outside the app, made on purpose
  for people to share. Once it is downloaded, Scrylux can neither protect it nor take it back. It holds no credential,
  account name or account id: the header names the threat model, its project and the time of the export, and no
  token is ever in an address or a file name (the web app sends the bearer token in the `Authorization` header and
  saves the answer as a file). The response is `Cache-Control: no-store`, a report's text is never logged, and the
  documents are read in one read-only snapshot, so a report never mixes two states of the threat model.
  *Accepted risk (Phase 2 Milestone 6)*: an export is the same on purpose, as a data file: a whole threat model, in a form
  made to be kept, moved and shared. It holds no credential, account name or account id (the project's name is in the
  Scrylux file for information), is sent `Cache-Control: no-store` with `sandbox; default-src 'none'`, and is never logged.
  An import's summary shows names and places from the file back to the user who chose it, as text.
  *Mitigated (Phase 2 Milestone 8)*: no secret reaches the image, a release asset or the release pipeline's log. The image is built by
  the pipeline from a clean checkout filtered by `.dockerignore`, never from a person's machine (`docs/releasing.md`); the pipeline
  references no secret but the per-run token (`scripts/workflows.test.ts`); and the demo and the release's text files are scanned for
  credential, email address, IP address and cloud-account patterns (`apps/api/test/demo/`).
  *Mitigated (Phase 3 Milestone 2)*: a job's rows and records hold no prompt, answer, key or address. A failure shows fixed text and a
  fixed hint (`apps/api/data/failures.yaml`), never the provider's own error; a provider check's result names the provider, the model
  and whether the provider is hosted or local, and nothing else; and the worker's log lines carry ids and counts only. A fake key and
  fake content put in a model's answer and in a provider's error are searched for in every log line, row and API answer for each way
  a job can end (`apps/api/test/worker/canary.test.ts`). *Accepted (Phase 3 Milestone 2)*: a provider key kept in the secrets-manager
  secret that `DB_SECRET_ID` names also reaches the API process, because both processes read that secret for the database credentials.
  The API never uses it. To keep a key from the API, set it in the worker's environment, as the compose files do; a separate secret
  for the worker would close the gap and is left for a later milestone.
- **Denial of Service**: JSON payloads are capped at 100kb (64 MiB for the two import operations); the `/api/v1` lists are not
  paginated, so a list returns every matching record (low risk at current expected scale, and
  specs/phase-1/milestone-5-rest-api-v1 SC-007 measures a threat model of 1,000 threats and 2,000 mitigations). *Partially mitigated (Phase 1 Milestone 6)*: failed sign-ins are throttled per address, never per
  account, so the throttle cannot be used to lock a user out; behind a load balancer `TRUST_PROXY`
  must be set, or every client shares the balancer's address and the per-address limit applies to
  everyone at once. *Partially mitigated (Phase 2 Milestone 1)*: a threat model holds at most 1,000
  elements, enforced by a database trigger that every writer passes through, and a batch carries at most 200
  operations, so a single request cannot make an unbounded write; the model lock a write takes
  (`FOR NO KEY UPDATE` on the threat model row) queues writers to one model without blocking reads or other
  models. *Partially mitigated (Phase 2 Milestone 3)*: one generation run is bounded by the
  1,000-element limit times the shipped library's per-element maximum (today up to 15 threats and 49
  mitigations for one element), so about 15,000 threats and 49,000 mitigations, written in chunked
  statements inside one transaction (measured at about a second). It holds the threat model's lock for its duration, so element
  writes to that model, and other runs on it, queue behind it. *Accepted risk (Phase 2 Milestone 5)*: a report is
  built in the API process, in one pass over the whole threat model. For the largest one Milestone 3 allows it
  was measured at under a second, with files of 13 MB (Markdown) and 21 MB (HTML); that time is spent in the
  process, and any signed-in account can ask. It takes no lock, so writers are not held up. Moving it to the worker
  (Phase 3) or limiting it (Phase 6) is the remedy if it ever matters. *Accepted risk (Phase 2 Milestone 6)*: an import is parsed, planned and written, and an export is built, in the
  API process, by any signed-in account, for a body of up to 64 MiB, which is read only after authentication and bounded
  in nesting and value count before anything walks it. Measured (quickstart §5): the largest threat model Milestone 3
  allows (1,000 elements, 15,000 threats, 49,000 mitigations; a Scrylux file of 25 MB) checks in about 0.2 seconds and
  imports in about 1.4, and a file of exactly 64 MiB in about 1.9. Another request is answered within 35 ms while it runs, because
  most of the time is the database, in chunked statements inside one transaction. The memory follows the number of
  records more than the bytes: the process peaks at about 470 MB on a fresh server and up to about 760 MB after heavy
  earlier use, from 106 MB at rest. **An export of the same model is as heavy**: it reads every row and builds the whole
  file in memory, and peaks at about 530 to 640 MB on a fresh server (two at once, about 710 MB). A report (Milestone 5) is
  of the same kind and was not measured for memory. That fits a 1 GiB host (a `t3.micro`) for one
  such operation at a time, but two or three at once, or one after heavy use, may not, so a host that will hold threat models
  of that size is documented as needing at least 2 GiB (README, Deployment; `step6-ec2-guide.md`), and the 64 MiB limit stays
  (a lower one would not lower the memory). Moving it to the worker (Phase 3) or limiting it
  (Phase 6) is the remedy. *Open risk*: no rate limiting on any other route. *Planned*: Phase 6 adds general
  rate limiting explicitly. *Partially mitigated (Phase 3 Milestone 1)*: a request to an LLM provider has
  a time limit for each attempt (300 seconds unless the operator changes it), at most three tries against a failing provider, a
  bounded output size and cancellation, and every request reports its tokens and cost. *Partially mitigated (Phase 3 Milestone 2)*:
  runaway spend by a job. Every job has a token cap (`JOB_TOKEN_CAP`, 500,000) and a cost cap (`JOB_COST_CAP`, $5), copied onto it when
  it is queued and out of a request's reach. Before each model request the job works out the most that request could use, counting every
  attempt the layer may make, and does not send it if that would take the job past a cap, counting everything the job has used in every
  run; so a job's recorded usage stays under its caps, apart from the error of the estimate of its input. The cost cap cannot be applied to
  a request whose model has no known price (the token cap still is, and the job says its cost is unknown). A job runs at most three times
  and lives at most an hour, runs and waits together; an account may have three jobs queued or running, and may start a provider check every
  five minutes (`apps/api/test/worker/budget.test.ts`, `apps/api/test/jobs/store.test.ts`). *Open risk (Phase 3 Milestone 2)*: the
  caps bound one job, not spend over time. Any signed-in account can create more accounts, each with its own cooldown, and a request
  that a crashed worker was making may be uncounted, though the provider may bill it. The operator's answer is a spending limit on the
  provider account (`docs/ai-providers.md`); Phase 6's roles and rate limiting are the remedy. A job that never ends is bounded by its
  deadline, which the heartbeat notices within seconds while a worker runs; with no worker alive, a job waiting past its deadline is
  failed by the next worker to start. *Accepted (Phase 3 Milestone 2)*: job and usage records are kept indefinitely and grow with
  every job; they are small, the cooldown slows provider checks, and the operator watches the storage as for other records.
- **Elevation of Privilege**: *Open risk, by design, currently unmitigated*: there is no role
  model. Any authenticated user can create additional users (`POST /api/users`) and, since Phase 1
  Milestone 5, can read, change and delete every project, threat model, element, threat and
  mitigation through `/api/v1`, including deleting a project with everything inside it. That
  widening was called out in Milestone 5's spec and PR, and is accepted until Phase 6. The browser UI's
  access token does not widen it: it is limited to `/api/v1` (`requireV1Token`), so a script injected
  into the page cannot create accounts through `/api/users` (`requireApiToken`). If `ADMIN_USERNAME`/`ADMIN_PASSWORD` are unset, no user is
  seeded, so on a new install nobody can sign in (fails closed, not open). *Planned*: plan.md Phase 6 introduces
  RBAC (viewer/contributor/reviewer/admin) and OIDC/SAML SSO to close this gap; until Phase 6
  ships, any change that widens what a plain authenticated user can do MUST be justified per
  Principle V, not treated as free because "there's no RBAC yet anyway." *Mitigated (Phase 1
  Milestone 2)*: the repository's default `GITHUB_TOKEN` permission is read-only
  (`contents: read`); only the CodeQL job is granted the additional `security-events: write` it
  needs, and only for itself, and since Phase 2 Milestone 8 the release workflow's two publishing jobs
  are granted the two write permissions described below, and nothing else is. The merge-gate ruleset on `main` has no bypass actors — no one,
  including repository admins, can merge or push around a failing or missing required check.
  *No widening (Phase 2 Milestone 1)*: the batch endpoint is in the same trust tier as the
  single-record element endpoints and can do nothing they cannot, and it cannot reach across threat models:
  an operation on an element of another model is the same as one on a missing element.
  *No widening (Phase 2 Milestone 3)*: the generate endpoint is in the same trust tier as the single-record
  threat endpoints. Any authenticated account could already create threats and mitigations by hand; generation
  creates only what the shipped, reviewed rules describe, and it gives a client less power over a generated
  threat than over a manual one (its element and rule cannot be changed).
  *No widening (Phase 2 Milestone 4)*: any authenticated account could already set any status on any threat. The
  lifecycle rules only add conditions to that, and the web app's new ways to link a manual threat to an element
  use an ability the API already had. Who may accept a risk is still every signed-in account, until Phase 6's roles.
  *No widening (Phase 2 Milestone 6)*: any authenticated account could already create a threat model in any project and read
  every one. Export reads what was readable; an import creates what could be created by hand, in the project the account
  names, and never changes an existing threat model.
  *Mitigated (Phase 2 Milestone 8)*: the publishing credential is not stolen or broader than needed. It is the run's `GITHUB_TOKEN`,
  which ends with the job; a write permission is held only by the two jobs that publish (`packages: write`, `contents: write`), neither
  of which runs repository code or installs a dependency, and the workflow's default is none (`scripts/workflows.test.ts`); the
  repository's default stays read-only (`docs/ci.md`). *Accepted risk (Phase 2 Milestone 8)*: a tag push runs the release workflow as
  defined at the tagged commit, so the gate cannot guard against a commit whose gate was edited. Whoever can create a version tag can
  already change the workflow and the rulesets, so the tag adds no power the owner lacks, and the owner is the only one who can create
  it; accepted until Phase 6 gives the project roles. *Open risk (Phase 2 Milestone 8)*: an install can be left running on the
  documented default credentials (`admin`/`admin`, a development signing secret, the database password), now that the quickstart is
  public. The quickstart's compose file publishes only the app, on the loopback address, which every release's smoke run proves on
  the real image (`scripts/release/smoke.ts`), and the file and the README say the defaults are for local use only and name each value
  to set (`docker-compose.release.yml`, `README.md`); the product does not refuse the defaults, and no phase schedules that.
  *Justified widening (Phase 2 Milestone 8, Governance)*: the release pipeline is the first workflow with a write permission. It is
  per run, per job, a stored secret nowhere, started only by a tag only the owner can create, refused six ways before it builds, and
  its write jobs run only `docker`, `skopeo` and `gh`; publishing from a maintainer's machine would put a long-lived credential on a
  laptop with nothing between a typo and the registry.
  *Justified widening (Phase 3 Milestone 2, Principle V)*: any signed-in account can now see and cancel every job, not only its own, and
  can start a provider check, which makes the provider spend, where until now only an operator with a shell could. There are no roles
  before Phase 6, a job is not private to its starter, and a provider check spends little: it is bounded by the caps, the limit on an
  account's active jobs and the cooldown, and the Jobs page says which provider is used and whether its data leaves the install. The
  widening was called out in the milestone's spec (FR-065) and is accepted until Phase 6.

Any change that adds an endpoint, a new external integration, or a new credential type MUST add
or update a bullet above in the same PR, whether or not the surrounding phase has been reached.

## Development Workflow & Quality Gates

Every pull request MUST state, or make evident from the diff, how it satisfies Principles I–VI.
The active test suite MUST pass before a PR is merged: typecheck, lint, test (with a Postgres
service container, and including the Playwright browser tests against the built app), and Docker
build are enforced as required checks on every PR to `main`, with
Dependabot and CodeQL enabled alongside them (informational, not merge-blocking, in this
milestone). A PR that touches authentication, configuration/secrets handling, any
route's authorization/validation logic, or (from Phase 3) prompt construction, LLM provider
adapters, or document-ingestion code MUST call out the security implication explicitly in its
description and MUST update the Threat Model section, and `docs/threat-model/`, if it changes an entry point, asset, or
trust boundary. A release is published only by the tag-triggered release pipeline (`.github/workflows/release.yml`,
`docs/releasing.md`), never from a maintainer's machine. Once any LLM-backed feature exists and the eval harness is in place (Phase 3 Milestone 7), a PR that
changes a prompt, provider adapter, or the extraction/threat-generation pipeline MUST include the eval
harness results against the committed thresholds; until then, such a PR states that the gate does not
yet apply and how the change was tested instead. Reviewers MUST reject PRs that reintroduce a mitigated risk from the
Threat Model (e.g. reverting to string-built SQL, removing the dummy-hash timing defense,
persisting unvalidated LLM output) without an equally strong replacement, and MUST reject PRs
that implement a later phase's scope while an earlier phase is still in progress, per Principle
III.

## Governance

This constitution supersedes any conflicting informal practice for this repository, across all
phases of `plan.md`. Amendments are made by editing this file directly, updating the Sync Impact
Report at its top, and bumping `CONSTITUTION_VERSION` per semantic versioning: MAJOR for
backward-incompatible principle removals or redefinitions, MINOR for a new principle or
materially expanded guidance, PATCH for wording/clarity fixes with no rule change. An amendment
is expected at or near each phase boundary in `plan.md`, since a new phase typically introduces
a new tool, asset, or trust boundary that this file's concrete details (file paths, tool names,
thresholds) should track — updating those details to match the current phase is itself normally
a PATCH or MINOR change, not evidence the principle was wrong. Every PR is expected to be
reviewable against these principles; unavoidable complexity or a deliberate exception (e.g.
broadening a permission before role-based access exists) MUST be justified in the PR description
rather than silently merged. This file is the source of truth for "why" a rule exists —
implementation-level how-to guidance belongs in `README.md`, `API.md`, `CONTRIBUTING.md`, `SECURITY.md`, `plan.md`, and code
comments, not here.

**Version**: 1.15.0 | **Ratified**: 2026-09-26 | **Last Amended**: 2026-11-01
