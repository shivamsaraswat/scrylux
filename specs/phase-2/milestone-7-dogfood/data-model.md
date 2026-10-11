# Data Model: Dogfood, Specter's Own Threat Model

This milestone adds **no table, column or record type** (spec FR-022). It adds one new *instance* of
the existing kinds (a project, a threat model, its elements, threats and mitigations) and two derived
files. This document is the blueprint of that instance: what to draw, which risks each threat
represents, and how to decide a status. It is what the pull request's traceability list (spec SC-003)
is built from.

Everything here is checked against the repository when the model is authored. A flag, a name or a
control that turns out to be wrong here is corrected in the model, and the correction goes in the
pull request's findings (User Story 5): the code and the deployment documents are the truth, not this
file.

## 1. The records

| Record | Value |
|---|---|
| Project | `Specter` |
| Threat model | `Specter application`, methodology `STRIDE`, status `in_review` until the maintainers approve it (research #11) |
| Scope (FR-001) | The system as it is implemented through Phase 2 Milestone 6: API, web app, database, optional secrets manager, optional proxy. Nothing of Phase 3 onward |
| Reference deployment (FR-010) | One app container, one PostgreSQL, an optional secrets manager, an optional proxy or load balancer: `docker-compose.yml`, `Dockerfile`, `deployment.md`. No cloud account, host or address |

**Conventions for text** (they make the report read well and keep FR-010):
- Names are short nouns for components, as a reader would say them: `Sign-in and sessions`.
- A flow is named for what it carries, from caller to callee, and stands for the request and its
  response: `Browser requests`.
- A tag names a technology (`React`, `Express`, `PostgreSQL`) or a protocol (`HTTPS`). No version, no
  address.
- A description says *what the thing does and why it matters*, never a host, an account or a secret.

## 2. The diagram

Five element types, as the editor offers them. **The four trust boundaries nest** as the constitution's
"Trust boundaries (current)" describes: Internet → proxy → app → database, with the browser as its own
boundary.

### 2.1 Trust boundaries

| Name | Inside it | Parent |
|---|---|---|
| `User device` | `Web app` | none |
| `Deployment network` | `Reverse proxy`, and the two boundaries below | none |
| `Application container` | the eight application processes (§2.3: every process except `Web app` and `Reverse proxy`) | `Deployment network` |
| `Database server` | the two data stores | `Deployment network` |

The pipeline is not a boundary of the diagram (it cannot be drawn with these types). This is the
exception written into spec FR-003: the CI/CD boundary and its assets (the `GITHUB_TOKEN`, third-party
actions, base and service images, the browser binaries the test job downloads) are represented by the
five threats of the whole model in §4 (T10, T11, T12, I4, E5), and the traceability list names them
against that boundary.

### 2.2 External entities (outside every boundary)

| Name | Role | Flags (assess from the evidence; unknown stays unassessed, FR-003) | Evidence |
|---|---|---|---|
| `Signed-in user` | A person using the web app | `authenticated: yes`, `internet_facing: yes` | README, `plan.md` |
| `API client` | A script or integration calling `/api/v1` with a bearer token | `authenticated: yes`, `internet_facing: yes` | `API.md` |
| `Operator` | The person who deploys and configures the install | `authenticated`: assess; `internet_facing: no` | `deployment.md`, `README.md` (environment variables) |
| `Secrets manager` | The optional store the configuration is read from at start | `authenticated: yes`, `internet_facing: no` | `apps/api/src/config.ts` |

### 2.3 Processes

| Name | In | What it is | Evidence |
|---|---|---|---|
| `Web app` | `User device` | The React app running in the browser; holds the access token in memory only | `apps/web/`, constitution Principle I |
| `Reverse proxy` | `Deployment network` | A proxy or load balancer in front of the app; ends TLS in the reference deployment | `deployment.md`, `README.md` (TRUST_PROXY) |
| `Sign-in and sessions` | `Application container` | `/api/login` and `/api/session`: sign-in, renewal, sign out, throttling | `apps/api/src/routes/login.ts`, `session.ts`, `session/` |
| `Accounts API` | `Application container` | `/api/users`: creates accounts | `apps/api/src/routes/users.ts` |
| `Threat model API` | `Application container` | `/api/v1`: projects, threat models, elements, threats, mitigations | `apps/api/src/v1/` |
| `Rule engine` | `Application container` | "Generate threats": applies the shipped rules to a diagram | `apps/api/src/rule-engine/` |
| `Report builder` | `Application container` | Builds Markdown and HTML reports | `apps/api/src/report/` |
| `Import and export` | `Application container` | Reads untrusted files, writes Specter and OTM files | `apps/api/src/exchange/` |
| `Web app server` | `Application container` | Serves the built web app with its security headers | `apps/api/src/web.ts`, `security-headers.ts` |
| `Startup and configuration` | `Application container` | Reads environment and secrets, migrates, seeds the admin | `apps/api/src/config.ts`, `migrate.ts`, `auth.ts` |

Flags for each process come from the code: `internet_facing` (reachable through the proxy),
`requires_authentication` (every route but sign-in), `handles_sensitive_data`, `runs_privileged`.
`Sign-in and sessions` is `requires_authentication: no` for sign-in itself; say so in the model, since
the rules treat it differently from the others.

### 2.4 Data stores (in `Database server`)

| Name | Holds | Flags | Evidence |
|---|---|---|---|
| `Account and session records` | Accounts and password hashes, browser sessions (digests only), sign-in failure counts | `stores_sensitive_data: yes`; `encrypted_at_rest`: assess from `deployment.md`, else unassessed | `packages/db/migrations/` |
| `Threat model records` | Projects, threat models, elements, threats, mitigations | `stores_sensitive_data: yes` (the system's own risks); `encrypted_at_rest`: as above | same |

### 2.5 Data flows

Each flow is drawn between two nodes (never to a boundary), from caller to callee. Flags from the code
and the reference deployment; an unknown stays unassessed.

| Flow | From → To | Notes |
|---|---|---|
| `Use the web app` | `Signed-in user` → `Web app` | |
| `Browser requests` | `Web app` → `Reverse proxy` | HTTPS in the reference deployment |
| `API client requests` | `API client` → `Reverse proxy` | HTTPS in the reference deployment |
| `Sign-in and session requests` | `Reverse proxy` → `Sign-in and sessions` | crosses into the app; the one unauthenticated entry |
| `Account requests` | `Reverse proxy` → `Accounts API` | |
| `Threat model requests` | `Reverse proxy` → `Threat model API` | |
| `Page requests` | `Reverse proxy` → `Web app server` | |
| `Web app code` | `Web app server` → `Web app` | what the browser runs |
| `Account and session queries` | `Sign-in and sessions` → `Account and session records` | |
| `Account queries` | `Accounts API` → `Account and session records` | |
| `Session check` | `Threat model API` → `Account and session records` | each `/api/v1` call is checked against its session |
| `Threat model queries` | `Threat model API` → `Threat model records` | |
| `Generation requests` | `Threat model API` → `Rule engine` | |
| `Generated threats` | `Rule engine` → `Threat model records` | one transaction |
| `Report requests` | `Threat model API` → `Report builder` | |
| `Report reads` | `Report builder` → `Threat model records` | one read-only snapshot |
| `Import and export requests` | `Threat model API` → `Import and export` | up to 64 MiB in |
| `Import and export queries` | `Import and export` → `Threat model records` | import is all or nothing |
| `Environment settings` | `Operator` → `Startup and configuration` | |
| `Secrets` | `Secrets manager` → `Startup and configuration` | |
| `Migrations and seeding` | `Startup and configuration` → `Account and session records` | also creates the schema of both stores |

That is 4 boundaries, 4 external entities, 10 processes, 2 stores and 21 flows: **41 elements**, far
below the limit of 1,000. A flow that the model cannot honestly set a flag for is left unassessed; the
**findings** list says which, because they point at facts the project has not written down.

### 2.6 Layout (FR-004)

- Left to right: `Signed-in user` and `API client` on the left; `User device` next; the deployment
  network, with `Reverse proxy` at its left edge, in the middle; `Application container` and
  `Database server` inside it, the database to the right; `Operator` and `Secrets manager` above the
  application container.
- A node is placed on a 200 by 120 grid; a boundary encloses its contents with 40 px on every side and
  never overlaps a sibling. Positions are relative to the parent boundary, as the editor stores them.
- Flows have no layout. The editor draws them; the report draws its own diagram.
- It is checked in the editor and in the report's diagram (quickstart §3), not only by reading numbers.

## 3. Threats and mitigations: the rules this model follows

**Where threats come from (FR-006)**
1. **Generated**: run "Generate threats" on the finished diagram. Every threat the shipped rules
   propose is kept and triaged (§5). `origin` is `rule`; nothing is deleted to make the model smaller.
2. **Manual**: only for a risk in §4 that no generated threat covers. `origin` is `manual`, created
   through the API, which accepts nothing else.
3. **Model-level** (`element_id` empty): the risks that belong to no single element (§4, group M).

**One risk, one threat.** When a generated threat is the same risk as a row of §4 (for example the rule
for a missing audit log on `Threat model API`), the row's status, reason and mitigations go on the
generated threat. A manual twin is not added (research #10).

**Statuses and what each needs** (the lifecycle the API enforces, Milestone 4):
- `accepted` and `not_applicable` need a reason (at most 10,000 characters) and nothing else.
- `mitigated` needs at least one `implemented` or `verified` mitigation, and a new threat cannot be
  created `mitigated`: create the threat, add the mitigation, then change the status.
- `open` has no reason.

**Mitigations (FR-008)**: the text names the control and where it is documented, in a form a reader can
check: `Dummy password comparison for unknown usernames (apps/api/src/auth.ts, DUMMY_HASH)`. Status
`verified` only where an automated test covers the control, and the text names the test; `implemented`
where the control exists without one; `proposed` for a remedy the plan schedules (`plan.md` Phase 6).
`external_ref` stays empty: no ticket system exists, and a made-up link would be false.

**Likelihood and impact** are set for every threat from what the project knows, using the scale
Low, Medium and High. A generated threat arrives with its rule's defaults; the review confirms or changes
them, and a change is a finding if it contradicts the rule.

## 4. The risk register

Every risk the constitution's Threat Model section records, in the section's order, with the threat
that represents it. **Status** follows research #10. **Target** is the element the threat sits on (`M`
= a threat of the whole model). A "Planned" item is not here by design (spec FR-007), and neither are the
"No widening" notes, which describe no risk.

Where a title is a rule's, the generated threat is used; the title here is the intended meaning.

### Spoofing

| # | Threat | Target | Status | Mitigations, or the reason | Section reference |
|---|---|---|---|---|---|
| S1 | Username enumeration through response timing | `Sign-in and sessions` | mitigated | implemented: dummy bcrypt comparison and identical throttling for unknown names (`apps/api/src/auth.ts`, `session/throttle.ts`) | Spoofing, "Mitigated" |
| S2 | Guessing sign-in credentials | `Sign-in and sessions` | mitigated | implemented: failures throttled per username-and-address and per address, never locking the account, IPv6 counted as /64 (`session/throttle.ts`; Phase 1 M6) | Spoofing, Phase 1 M6 |
| S3 | Guessing spread across many addresses | `Sign-in and sessions` | accepted | Reason: slowed per address, not stopped; spread across many addresses or /64s; general rate limiting is Phase 6. *(residual → accepted, research #10)* | Spoofing, "Residual risks" |
| S4 | Theft of a browser session credential | `Sign-in and sessions` | mitigated | implemented: HttpOnly cookie scripts cannot read, rotation on every renewal, replay after a 30-second grace window ends the session and is logged (`session/`; Phase 1 M6) | Spoofing |
| S5 | Replay of a just-replaced credential inside the grace window | `Sign-in and sessions` | accepted | Reason: gets one 5-minute access token and no new credential. *(residual)* | Spoofing, "Residual risks" |
| S6 | Bearer tokens from `/api/login` outlive "sign out everywhere" | `Sign-in and sessions` | accepted | Reason: they are not revoked and live until they expire. *(residual)* | Spoofing, "Residual risks" |
| S7 | A credential more than one rotation old is answered 401 without reuse detection | `Sign-in and sessions` | accepted | Reason: only the previous credential is stored; the holder gains nothing, so no token-family table is kept. *(residual)* | Spoofing, "Residual risks" |
| S8 | A file claims rule-generated provenance for a threat | `Import and export` | accepted | Reason: Specter cannot check a Specter file's or Specter-marked OTM file's `origin`; generation then treats the threat as its own. An AI-origin threat is refused, other tools' threats import as manual. (Phase 2 M6) | Spoofing, "Accepted risk (Phase 2 Milestone 6)" |

### Tampering

| # | Threat | Target | Status | Mitigations, or the reason | Section reference |
|---|---|---|---|---|---|
| T1 | SQL injection through request input | `Threat model API` | mitigated | implemented: every statement parameterized or built with Kysely (`apps/api/src/v1/`, `routes/`, `auth.ts`; Principle I) | Tampering |
| T2 | Oversized request bodies | `Threat model API` | mitigated | implemented: 100 KiB cap, and 64 MiB only for the two import operations, read only after authentication (`apps/api/src/app.ts`, `v1/router.ts`) | Tampering |
| T3 | Cross-site request forgery | `Sign-in and sessions` | mitigated | implemented: `/api/v1` and `/api/users` authorize only by an explicit bearer; the one cookie is `SameSite=Strict`, scoped to `/api/session`, with an Origin check and a JSON content type (`session/cookie.ts`) | Tampering |
| T4 | Hostile element properties or layout | `Threat model API` | mitigated | implemented: one schema in `packages/core` validates properties and layout on every write, a batch is one transaction, the editor draws names and tags as text (Phase 2 M1) | Tampering, Phase 2 M1 |
| T5 | A structurally inconsistent threat model written by any writer | `Threat model records` | mitigated | implemented: the database enforces references within one model, flow ends, boundary parents, acyclic boundaries, derived risk and immutable origin (`packages/db/migrations/`; Phase 1 M3) | Tampering, Phase 1 M3 |
| T6 | A client fakes rule or AI provenance on a threat | `Threat model API` | mitigated | implemented: `/api/v1` accepts only `origin = manual`; the rule engine alone writes `rule`; a generated threat's element and rule cannot change; `stale` is set only by the engine (`threats_*` constraints; Phase 1 M5, Phase 2 M3) | Tampering |
| T7 | A client bypasses the status rules | `Threat model API` | mitigated | implemented: reasons and the mitigation condition enforced on the server for every client (`apps/api/src/v1/threats.ts`; Phase 2 M4) | Tampering, Phase 2 M4 |
| T8 | Hostile text in a report becomes markup, a link or a script | `Report builder` | mitigated | implemented: one escaper per format, a sandboxed HTML file with a locked-down policy; tested with real Markdown, Mermaid and browser parsers (`apps/api/src/report/escape.ts`; Phase 2 M5) | Tampering, Phase 2 M5 |
| T9 | A hostile, deeply nested or malformed import file | `Import and export` | mitigated | implemented: bounded first by a non-recursive walk (64 levels, 2,000,000 values), parsed by shared schemas, rules across records, all or nothing in one transaction (`apps/api/src/exchange/import/`; Phase 2 M6) | Tampering, Phase 2 M6 |
| T10 | Tampering with third-party actions and images in the pipeline | M | mitigated | implemented: actions pinned to full commit SHAs, base and service images pinned by digest, a 2-day Dependabot cooldown, a required lockfile-format check (`.github/`, `docs/ci.md`; Phase 1 M2) | Tampering, Phase 1 M2 |
| T11 | The test job downloads browser binaries and system packages from outside | M | accepted | Reason: pinned only by the lockfile's `@playwright/test` version, which Dependabot's cooldown and pnpm's `minimumReleaseAge` cover. (Phase 1 M6) | Tampering, "Accepted risk (Phase 1 Milestone 6)" |
| T12 | pnpm does not verify its own version | M | accepted | Reason: `pmOnFail: ignore` keeps the lockfile a single document so GitHub's dependency graph reads it; Corepack and CI's pinned install compensate; revert when dependabot-core#15904 ships | Tampering, "Accepted risk" |

### Repudiation

| # | Threat | Target | Status | Mitigations, or the reason | Section reference |
|---|---|---|---|---|---|
| R1 | No persisted record of who created, changed or deleted a record | `Threat model API` | open | implemented: one stdout line per write with account id, action, record type and id, never values (`v1/write-log.ts`, not persisted or tamper-evident). proposed: a persisted audit log (`plan.md`, Phase 6) | Repudiation, "Open risk" |
| R2 | Sign-in and session events are not persisted | `Sign-in and sessions` | open | implemented: one stdout line per event, ids and an event name only. proposed: audit log (Phase 6) | Repudiation, Phase 1 M6 |
| R3 | A generation run is recorded only as counts | `Rule engine` | open | implemented: one stdout line with account id, model id and counts. proposed: audit log (Phase 6) | Repudiation, Phase 2 M3 |
| R4 | An import is recorded only as ids and counts | `Import and export` | open | implemented: one stdout line with account id, project, model ids and counts, never content. proposed: audit log (Phase 6) | Repudiation, Phase 2 M6 |
| R5 | A risk acceptance or dismissal is not attributed or dated | `Threat model API` | accepted | Reason: the decision carries a reason, but not who made it or when; no history of earlier statuses is kept; any signed-in account may make it; Phase 6's audit log and roles close it (Phase 2 M4) | Repudiation, "Accepted risk (Phase 2 Milestone 4)" |

### Information disclosure

| # | Threat | Target | Status | Mitigations, or the reason | Section reference |
|---|---|---|---|---|---|
| I1 | Error responses and logs reveal stored or submitted values | `Threat model API` | mitigated | implemented: 500s are generic and detailed only in the server log; `/api/v1` errors are fixed messages; the write log carries ids only; status reasons are never repeated or logged; `x-powered-by` is off (`apps/api/src/app.ts`, `v1/errors.ts`; Phase 1 M5, Phase 2 M4) | Information Disclosure |
| I2 | Secrets in committed files, logs or the browser | `Startup and configuration` | mitigated | implemented: secrets only from the environment or a secrets manager, `.env` ignored, the process refuses to start without a required secret, logs hold no secret (`apps/api/src/config.ts`; Principles I and IV) | Information Disclosure |
| I3 | A script injected into the page reads data or credentials | `Web app server` | mitigated | implemented: strict Content-Security-Policy and hardening headers on every response, record text drawn as text, the long-lived credential in an HttpOnly cookie, the access token in memory only, zod in `jitless` mode (`apps/api/src/security-headers.ts`, `apps/web/src/zod-config.ts`; Phase 1 M6) | Information Disclosure, Phase 1 M6 |
| I4 | A pipeline job leaks a repository secret to a fork | M | mitigated | implemented: no job references a secret, every job runs on `pull_request` and never `pull_request_target`, checkouts do not persist credentials (`.github/workflows/`; Phase 1 M2) | Information Disclosure, Phase 1 M2 |
| I5 | A report is a copy of the whole threat model outside the app | `Report builder` | accepted | Reason: made on purpose for people to share; once downloaded Specter cannot protect it. It holds no credential, account name or id, is `no-store`, never logged, read in one snapshot (Phase 2 M5) | Information Disclosure, "Accepted risk (Phase 2 Milestone 5)" |
| I6 | An export is a copy of the whole threat model outside the app, and an import summary shows file text back | `Import and export` | accepted | Reason: the same, as a data file; holds no credential, account name or id; `no-store` with `sandbox; default-src 'none'`; never logged; the summary shows names and places to the user who chose the file, as text (Phase 2 M6) | Information Disclosure, "Accepted risk (Phase 2 Milestone 6)" |

### Denial of service

| # | Threat | Target | Status | Mitigations, or the reason | Section reference |
|---|---|---|---|---|---|
| D1 | A list returns every matching record | `Threat model API` | accepted | Reason: the lists are not paginated; low risk at the expected scale, measured at 1,000 threats and 2,000 mitigations (Phase 1 M5, SC-007). *(research #10)* | Denial of Service |
| D2 | A flood of failed sign-ins | `Sign-in and sessions` | open | implemented: throttling per address, never per account, so it cannot lock a user out. Note: behind a proxy `TRUST_PROXY` must be set or every client shares the proxy's address. proposed: general rate limiting (Phase 6) | Denial of Service, Phase 1 M6 |
| D3 | A very large write to one threat model | `Threat model API` | open | implemented: at most 1,000 elements per model (a database trigger), at most 200 operations per batch, writers to one model queue behind its lock. proposed: rate limiting (Phase 6) | Denial of Service, Phase 2 M1 |
| D4 | A generation run holds a model's lock | `Rule engine` | open | implemented: bounded by the element limit times the library's per-element maximum (about 15,000 threats and 49,000 mitigations), chunked statements in one transaction, measured at about a second. proposed: move to the worker (Phase 3) or limit (Phase 6) | Denial of Service, Phase 2 M3 |
| D5 | A report is built in the API process | `Report builder` | accepted | Reason: one pass over the whole threat model; measured under a second for the largest, 13 MB Markdown and 21 MB HTML; takes no lock; remedy is the worker (Phase 3) or a limit (Phase 6) (Phase 2 M5) | Denial of Service, "Accepted risk (Phase 2 Milestone 5)" |
| D6 | An import or export is built in the API process | `Import and export` | accepted | Reason: up to 64 MiB after authentication, bounded before anything walks it; about 1.4 s to import and 0.7 s to export the largest model; memory peaks near 470 to 760 MB, so the documentation names 2 GiB as the minimum host for large models (Phase 2 M6) | Denial of Service, "Accepted risk (Phase 2 Milestone 6)" |
| D7 | No rate limiting on any other route | `Threat model API` | open | proposed: general rate limiting (`plan.md`, Phase 6) | Denial of Service, "Open risk" |

### Elevation of privilege

| # | Threat | Target | Status | Mitigations, or the reason | Section reference |
|---|---|---|---|---|---|
| E1 | Every signed-in account can read, change and delete every project, threat model and record | `Threat model API` | open | proposed: roles (viewer, contributor, reviewer, admin) and OIDC or SAML single sign-on (Phase 6). By design for now, accepted until then in the milestone specs | Elevation of Privilege, "Open risk" |
| E2 | Every signed-in account can create further accounts | `Accounts API` | open | proposed: roles (Phase 6) | Elevation of Privilege, "Open risk" |
| E3 | A script injected into the page creates accounts | `Web app` | mitigated | implemented: the browser's access token is limited to `/api/v1` and cannot reach `/api/users` (`requireV1Token`) | Elevation of Privilege |
| E4 | An unset admin account leaves the app open | `Startup and configuration` | mitigated | implemented: with `ADMIN_USERNAME` or `ADMIN_PASSWORD` unset no user is seeded and the app is unusable, so it fails closed (`apps/api/src/auth.ts`) | Elevation of Privilege |
| E5 | An over-privileged pipeline token or an admin who can bypass the checks | M | mitigated | implemented: the default `GITHUB_TOKEN` is read-only, only the CodeQL job has `security-events: write`, the ruleset on `main` has no bypass actors (`.github/rulesets/main.json`; Phase 1 M2) | Elevation of Privilege, Phase 1 M2 |

**Count**: 8 + 12 + 5 + 6 + 7 + 5 = **43 rows**. By status: 20 mitigated, 13 accepted, 10 open. Five
are threats of the whole model (T10, T11, T12, I4, E5) and 38 sit on an element. A row can turn out to
be covered by a generated threat (see "One risk, one threat"), so the count of *manual* threats is
lower; the pull request's traceability list is the record. It is built by walking the constitution's
section top to bottom, not by trusting this table.

**Not in the model, on purpose**: the "Planned" notes (indirect prompt injection from ingested
documents, AI-proposed edits, a hosted LLM as a disclosure path, LLM cost caps) and the "Planned" assets
and boundaries of Phases 3 to 5. Phase 3's Milestone 8 updates the model for them (`plan.md`).

## 5. Triage of the generated threats

A generated threat gets exactly one of these dispositions, tried in order. The reviewer can read the
reason or the mitigation and see which branch it took.

| # | Condition | Disposition |
|---|---|---|
| 1 | It is the same risk as a row of §4 | The row's status, reason and mitigations |
| 2 | A control in this system addresses it | `mitigated`, with an implemented or verified mitigation that names the control and where it is documented |
| 3 | It cannot happen because of how this system is built (a rule for a store reachable from the internet, on a store that is not) | `not_applicable`, with a reason that states that fact |
| 4 | It is a real gap the project already knows and has put off | `accepted`, with a reason that says why and until when |
| 5 | It is a real gap nobody had written down | `open`, **and a finding** in the pull request (a gap that dogfooding found) |

Rule 5 is the point of the exercise. A threat in disposition 5 that is an exploitable vulnerability is
not committed until it is reported and fixed (FR-011). A threat left `open` that the project has no
plan for is allowed: an honest open threat is better than a dishonest accepted one.

The triage table is a throwaway working file outside the repository (research #6). Its keys are the
element's name and the rule's `library_ref`, never an id, so it can be re-applied to a regenerated model.

## 6. Invariants of the finished model, and how each is checked

| Invariant | Spec | Checked by |
|---|---|---|
| One project, one threat model, STRIDE, `in_review` or `approved` | FR-001 | check 4 (the header) |
| Element names are unique within a type; threat titles unique within an element and category; mitigation text unique within a threat | FR-004 | check 3 (no ties) |
| Every trust boundary of the constitution is a boundary (the CI/CD boundary by threats of the whole model); every flow joins two nodes | FR-003 | the import's own rules; the reviewer, from the traceability list |
| Every generated threat the library proposes is present, none is stale | FR-006, FR-016 | check 6 (drift) |
| All six STRIDE categories have a threat | FR-006 | check 4 (coverage) |
| Every threat has likelihood and impact | FR-006 | the schema (both are required) |
| Each risk of §4 has its threat with the right status | FR-007 | the traceability list in the pull request; **not automated** (the checks cannot read the prose, spec Assumptions) |
| Accepted and not applicable threats have a reason | FR-009 | the import's lifecycle marker; check 4 fails a threat with a missing reason |
| A mitigated threat has an implemented or verified mitigation | FR-007 | check 4 (the same marker) |
| No secret, personal data or deployment identifier | FR-010 | check 5 (patterns) and the review |
| No AI-origin threat, nothing of a later phase | FR-001 | the import refuses `ai`; the review for the rest |
| The files are what Specter exports | FR-013, FR-014, FR-015 | checks 1, 2, 7 |
| The folder holds the two files and the README, and nothing else | FR-012 | check 4 (`folder`) |

The "missing what its status needs" marker is the import's own: a threat that arrives `mitigated` with no
implemented mitigation, or `accepted` with no reason (Milestone 4, FR-006). A committed model must
have none (check 4), because a threat with its status unsupported is the exact thing a threat model
exists to avoid.
