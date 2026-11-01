# Implementation Plan: Worker and Jobs

**Branch**: not yet created (spec directory `phase-3/milestone-2-worker-jobs`; work is on `feat/phase-3`; the setup
script inferred `milestone-2-worker-jobs` as the branch name, but no branch by that name was created) |
**Date**: 2026-10-31 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/phase-3/milestone-2-worker-jobs/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Phase 3 / Milestone 2 adds the worker: a second process, started from the same image, that runs jobs off the request
path. Jobs live in a Scrylux `jobs` table. Each job reports progress, runs again only after a transient failure,
can be cancelled from the UI, and stops before any model request whose worst case would pass its token or cost cap.
Every model request a job makes is stored with Milestone 1's usage record. The only job kind is the **provider check**,
which a signed-in person starts from a new Jobs page. From now on only the worker holds the provider keys and talks to
a provider.

At planning the maintainer made two decisions that change `plan.md` and the constitution, and the spec changed in
four places (spec Clarifications, session 2026-10-31, during planning):

- **Our own `jobs` table instead of pg-boss** (research #1). `plan.md`'s tech-stack row, layout and milestone text
  change to match, and so does `docs/roadmap.md`.
- **The worker is an entry point in `apps/api`** (`dist/worker.js`), not an `apps/worker` package, so the image does
  not grow by about 200 MB (research #2). Principle III's layout list and `plan.md` drop `apps/worker`.
- **FR-042's worst case counts billed calls** (attempts and transient retries), not the free resends that follow a 400
  before any generation (research #7).
- **The spec's Assumptions** no longer say the plan confirms pg-boss, and the edge case on changed caps says they apply
  to jobs queued after the API restarts, because the API copies them when it queues.
- **SC-008's 10-second bound** holds while a worker runs; with none alive, a job past its deadline is failed by the
  next worker to start (research #6).

**1. Storage** (`packages/db/migrations/016_jobs.sql`): `jobs`, `job_usage` and `workers`, with checks, a trigger that
keeps final states final, and Kysely types ([data-model.md](./data-model.md)).

**2. Job storage** (`apps/api/src/jobs/`): queue, list, read and cancel for the API; claim, heartbeat, fenced writes,
sweep and hand-back for the worker; the per-account limit and cooldown under an advisory lock; totals summed on read;
`parseJobConfig`; the failure messages from `apps/api/data/failures.yaml` (research #3, #4, #6, #11, #12).

**3. The worker** (`apps/api/src/worker.ts` and `src/worker/`): start-up checks, migrations, the loop with its slots,
heartbeats, the budget that checks each request's worst case, the provider check kind, the health server, graceful stop
(research #5, #7, #8, #9, #10; [contracts/worker.md](./contracts/worker.md)).

**4. The provider layer** (`packages/llm`): `parseLlmStatus` and `worstCase` with `requestSize`
([contracts/library-api.md](./contracts/library-api.md)). `apps/api/src/provider-check.ts` is shared by the job and
the operator's command, which keeps its output.

**5. The API** (`apps/api/src/v1/jobs.ts`): five routes ([contracts/http-api.md](./contracts/http-api.md)); the start-up
check without keys (FR-071); job settings validated at start.

**6. The web app** (`apps/web`): a Jobs link in the header, `/jobs` and `/jobs/:jobId`
([contracts/ui.md](./contracts/ui.md)).

**7. Packaging, docs and the threat model**: the Dockerfile copies `data/`; both compose files gain a `worker` service
with the keys, a health check and the job settings, and the `app` service loses the keys; `docs/install.md`,
`docs/ai-providers.md`, `plan.md`, `docs/roadmap.md`, `CHANGELOG.md`; constitution 1.15.0 and `docs/threat-model/`
rebuilt (research #14).

## Technical Context

**Language/Version**: TypeScript 6.0.x, strict, on Node 22 (unchanged). SQL for the migration. YAML for
`failures.yaml`.

**Primary Dependencies**: none added. The worker uses what the API already has: `pg`, `kysely`, `zod`, `yaml`,
`@scrylux/llm` and `@scrylux/db`, plus `node:http` for its health server. pg-boss is not added (research #1). The web
app uses its existing React Router and TanStack Query.

**Storage**: PostgreSQL 16 (unchanged). One migration, `016_jobs.sql`: three tables, one trigger, five indexes.
`job_usage` grows by one or two rows per provider check; with the 5-minute cooldown, at most 288 checks per account per
day.

**Testing**:

- **Vitest** with the Postgres service container, as today: `packages/db/test/`, `packages/llm/test/`,
  `apps/api/test/jobs/`, `apps/api/test/worker/`, `apps/api/test/contract/`, and the web unit tests.
- **The worker is tested in-process** against `startStub` from `@scrylux/llm/testing`, with shortened timings passed
  as options (research #5, #13).
- **One Playwright spec** starts its own API, worker and stub provider, so the rest of the browser suite still runs with
  no provider and no worker (SC-001).
- **No secret, no provider network** (FR-082). The live runs of [quickstart §2–§4](./quickstart.md) are by hand.

**Target Platform**: Node 22 in the published image. Two processes from one image: `node dist/server.js` and
`node dist/worker.js`.

**Project Type**: the existing web service (`apps/api`, `apps/web`) and its packages, with a second entry point.

**Performance Goals**:

- A queued job starts within about 2 s when a worker slot is free (poll interval).
- State and progress reach the UI within 5 s (FR-061): the UI refetches every 2 s while a shown job is active.
- Cancel takes effect within 10 s (FR-030): heartbeat every 5 s, plus the layer's 1-second stop.
- A crashed worker's job is back in the queue within 30 s of its last heartbeat (FR-007 allows 2 minutes).
- An idle worker costs two small indexed queries every 2 s and a liveness update every 10 s.

**Constraints**:

- Every worker write to a job is fenced by its claim counter and state (FR-005). Every time is the database's.
- No content, prompt, answer, key or base address in any job row, usage row, log line or API answer (FR-051, SC-007).
- Only the worker sends requests to a provider (FR-070). The API needs no key (FR-071).
- Every v0.1 flow works with no worker and no provider (FR-072).

**Scale/Scope**:

- About 12 new source files in `apps/api/src` (`jobs/` 4, `worker/` 6, `worker.ts`, `provider-check.ts`, `v1/jobs.ts`),
  2 changed (`server.ts`, `llm-check.ts`), 1 data file.
- 2 new exports in `packages/llm`. One migration and its types in `packages/db`. One schema file in `packages/core`.
- 2 pages, 1 header link and their queries in `apps/web`.
- About 12 test files. Docs, compose files, the Dockerfile, the constitution and the threat model.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| **I. Secure coding** | Parameterized SQL only; secrets from env or the secrets manager, never logged, stored or sent to the browser; input validated; consistent errors. | ✅ All job SQL goes through Kysely or parameterized `pg` calls; the claim, sweep and heartbeat statements are parameterized, never string-built. Keys reach only the worker (FR-071), are never written to a job row, usage row or log (FR-051), and the canary test proves it (SC-007). Every route validates its input with the shared zod schemas and answers fixed `{ error }` text, including the two `429` refusals, whose numbers come from settings and the database (contracts/http-api.md). The worker's `/health` has no auth and no data, like the API's. |
| **II. Test-first** | A failing test before each behavior; the suite green; eval gate. | ✅ Every FR maps to a test in [quickstart §1](./quickstart.md#1-automated-suites), written first. **The eval gate** does not apply: no prompt, adapter or extraction pipeline changes. The provider check sends Milestone 1's fixed request unchanged, and `worstCase` and `parseLlmStatus` are pure functions with their own tests. The PR says so (Development Workflow). |
| **III. Simplicity / YAGNI** | No later phase's scope; no premature dependencies; no dead code; layout. | ✅ **No dependency added**: the queue is about 200 lines on our own table rather than pg-boss (research #1). **Not added**: scheduled or recurring jobs, priorities, notifications, `LISTEN`/`NOTIFY`, an indicator on every page, a retention setting, a `threat_model_id` column, other job kinds, moving reports or imports to the worker. **Layout**: the worker lives in `apps/api` (research #2). Principle III names `apps/worker` in its target layout, so the 1.15.0 amendment drops it, and `plan.md` changes with it, at the maintainer's decision. One route file for jobs (`v1/jobs.ts`), as for every resource. |
| **IV. Maintainability** | Env-only config, documented; stdout logs without LLM payloads; forward-only migrations; stateless processes; `/health`; prompts and rules as data. | ✅ Eight variables, all in `docs/install.md` (FR-081). JSON log lines with ids and counts only (FR-009). One forward-only migration in `schema_migrations`; nothing creates tables at start (FR-003). The worker keeps no state between jobs; all state is in Postgres, so any number of workers can run (FR-005). `/health` on both processes, no DB. Failure messages and hints are a versioned data file (FR-064), and the hints move out of `llm-check.ts`'s code into it. |
| **V. Least privilege / threat-aware** | Threat Model updated for new assets, entry points and boundaries in the same change; broader grants called out. | ✅ **The section changes (FR-080)**: the worker as a process, job and usage records as assets, five routes as entry points, the outbound provider flow from the worker, and the risks of research #14. Constitution 1.15.0; `docs/threat-model/` rebuilt by its procedure. **Least privilege**: the API loses the provider keys (FR-071). **Called out as broadening (FR-065)**: any signed-in account can now see and cancel every job and make the provider spend through a check, bounded by the caps, the per-account limit and the cooldown. **Accepted limit**: a key kept in the shared secret still reaches the API process (research #11). |
| **VI. AI output is a draft** | Provider-agnostic; output validated; untrusted input delimited; no tool calls; local model supported; hosted disclosure. | ✅ The job calls only `@scrylux/llm` (FR-016 of M1). It sends Milestone 1's fixed request, so no user content and no untrusted input. Its output is validated by the layer and only its outcome is stored. No tools. A local model is fully supported, with an unknown cost unless priced. **Hosted disclosure**: the Jobs page shows for each operation whether data sent to it leaves the install. No user content is sent, so the full notice of Principle VI stays Milestone 3's. |

**Post-design re-check (after Phase 1)**: still passing.

- The design adds five authenticated routes, three tables, eight variables, a second process and a health port. Each
  is in the threat model update (research #14).
- The contracts expose no key, address or provider text. Totals are computed, never stored, so they cannot drift.
- The PR must call out: the two maintainer decisions (own queue, layout) with their `plan.md` and Principle III
  changes; the broadening of FR-065; the change of Milestone 1's start-up rule for the API (FR-071); and the eval gate
  not applying.

## Project Structure

### Documentation (this feature)

```text
specs/phase-3/milestone-2-worker-jobs/
├── plan.md              # This file
├── research.md          # Phase 0: decisions 1–14
├── data-model.md        # Phase 1: the three tables, transitions, API records
├── quickstart.md        # Phase 1: automated suites and manual runs
├── contracts/
│   ├── configuration.md # the eight variables, and which process gets what
│   ├── http-api.md      # the five routes and their records
│   ├── worker.md        # the worker process: command, start, health, stop, logs
│   ├── library-api.md   # parseLlmStatus and worstCase in @scrylux/llm
│   ├── data-files.md    # apps/api/data/failures.yaml
│   └── ui.md            # the Jobs page and the job page
├── checklists/
│   └── requirements.md  # spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks; not created here)
```

### Source Code (repository root)

```text
packages/db/
├── migrations/016_jobs.sql          # new: jobs, job_usage, workers
└── src/schema.ts                    # + JobsTable, JobUsageTable, WorkersTable

packages/core/src/schemas/job.ts     # new: JobRecord, JobDetail, JobsStatus, JobCreateInput, categories

packages/llm/src/
├── config.ts                        # + parseLlmStatus (requireKeys flag)
├── worst-case.ts                    # new: worstCase, requestSize
└── index.ts                         # + the two exports

apps/api/
├── data/failures.yaml               # new: messages and hints (FR-064)
├── package.json                     # + "worker" script
└── src/
    ├── worker.ts                    # new: the worker's entry point → dist/worker.js
    ├── worker/
    │   ├── loop.ts                  # sweep, claim, slots, stop
    │   ├── run.ts                   # one run: heartbeat, fencing, outcome → state
    │   ├── budget.ts                # caps against worst case (FR-042–FR-044)
    │   ├── kinds.ts                 # the kind registry: provider_check
    │   ├── health.ts                # GET /health on WORKER_HEALTH_PORT
    │   └── timing.ts                # the intervals of research #5
    ├── jobs/
    │   ├── store.ts                 # queue, list, read, cancel, claim, heartbeat, finish, sweep, hand back
    │   ├── config.ts                # parseJobConfig
    │   ├── failures.ts              # reads data/failures.yaml
    │   └── log.ts                   # the job and worker log lines
    ├── provider-check.ts            # new: shared by the job and llm-check.ts
    ├── llm-check.ts                 # uses provider-check.ts and failures.yaml; output unchanged
    ├── llm-startup.ts               # uses parseLlmStatus (FR-071)
    ├── server.ts                    # + parseJobConfig at start
    └── v1/
        ├── jobs.ts                  # new: the five operations
        └── operations.ts, openapi.ts, write-log.ts   # register, 429, job log line

apps/api/test/
├── jobs/                            # config, store, failures
├── worker/                          # loop, budget, cancel, deadline, recovery, health, startup, canary
└── contract/jobs.test.ts

apps/web/src/
├── components/AppShell.tsx          # + Jobs link
├── App.tsx                          # + /jobs, /jobs/:jobId
├── api/queries.ts                   # + job queries and mutations
└── pages/JobsPage.tsx, JobPage.tsx  # new, with tests
apps/web/e2e/jobs.spec.ts            # new

Dockerfile                           # + COPY data/
docker-compose.yml, docker-compose.release.yml   # + worker service; keys move to it
docs/install.md, docs/ai-providers.md, plan.md, docs/roadmap.md, CHANGELOG.md
.specify/memory/constitution.md      # 1.15.0
docs/threat-model/                   # rebuilt
```

**Structure Decision**: the existing monorepo. The worker is a second entry point of `apps/api`, sharing its config,
database and job storage modules (research #2). No new workspace package.

## Complexity Tracking

| Departure | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| `plan.md` names pg-boss; we write our own queue | The spec's permanent job record, category-specific retries, cross-process cancel and fencing need our own table anyway (research #1) | pg-boss would add a second state machine and a migration whenever its schema version changes |
| Principle III's layout names `apps/worker`; the worker lives in `apps/api` | One image without a second copy of the dependencies, and one configuration loader (research #2) | A separate package adds about 200 MB to the image and a shared loader to extract |
