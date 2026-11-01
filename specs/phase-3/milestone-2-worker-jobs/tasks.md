---

description: "Task list for Worker and Jobs (Phase 3 / Milestone 2)"
---

# Tasks: Worker and Jobs

**Input**: Design documents from `/specs/phase-3/milestone-2-worker-jobs/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/configuration.md,
contracts/http-api.md, contracts/worker.md, contracts/library-api.md, contracts/data-files.md, contracts/ui.md,
quickstart.md

**Tests**: Required. Constitution Principle II requires a failing test before each new behaviour, and the spec's
Success Criteria SC-001 to SC-011 are checked by tests (quickstart §1). In every phase the test tasks come first and
**MUST be run and seen failing** before the implementation tasks that follow them. Two tasks are **guard tests** and
are exempt: T061 (the canary) and T062 (the worker imports no Express, and the API server never reaches a provider
client). Each checks, across the whole worker,
behaviour that earlier test-first tasks already built, so it is written after that code and must pass when written.

**Organization**: by user story, in the spec's priority order: US1 → US2 → US3 (P1), then US4 → US5 → US6 → US7
(P2). Pulled into Foundational because every story needs them: the migration and its types, the shared schemas, the
two `@scrylux/llm` exports, the job settings, the failure messages, and the provider check module shared by the
operator's command and the job.

**Scope guard**:

- No task adds a dependency other than `yaml` to `apps/api` (already locked at 2.9.1 in the workspace).
- No task adds pg-boss or any queue library, `LISTEN`/`NOTIFY`, scheduled or recurring jobs, priorities,
  notifications, an indicator on every page, a retention setting, a `threat_model_id` column, a second job kind, or
  moves a report, import, export or rule generation to the worker (plan.md, Constitution Check III).
- No task changes a prompt, a provider adapter or the price list.
- If a task seems to need one, stop and ask.

**Git**: no task commits, pushes, tags or opens a pull request. The maintainer does that.

**Paths**: relative to the repository root. `API` means `apps/api`, `WEB` means `apps/web`, `LLM` means
`packages/llm`, `DB` means `packages/db`, `CORE` means `packages/core`, `SPEC` means
`specs/phase-3/milestone-2-worker-jobs`.

**SQL**: every statement is parameterized (`pg` placeholders or Kysely), never string-built (Principle I). Every
time is the database's `now()`, never `Date.now()` written into a row (research #4).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story the task belongs to (US1–US7)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: a place for the job tests to run one file at a time, the `worker` script, and a green baseline.

- [X] T001 In `API/vitest.config.ts`, add a third project, `jobs`, with `include: ['test/jobs/**/*.test.ts',
  'test/worker/**/*.test.ts', 'test/contract/v1/jobs*.test.ts']`, `fileParallelism: false` and
  `sequence: { groupOrder: 3 }`, and add the same globs to the `api` project's `exclude`. Reason, in a comment: a
  worker claims any queued job in the shared test database, so job tests must not run beside each other or beside a
  file that queues jobs. Each file in the group starts with `TRUNCATE jobs, job_usage, workers` (added by the tasks
  that create them). Then check that Vitest honours `fileParallelism: false` inside one project, not only at the
  root: run the group with two throwaway files that each hold a shared advisory lock for a second and record their
  start times, see that they did not overlap, and delete the files. If they overlap, give the group its own
  `vitest.jobs.config.ts` run by `pnpm --filter @scrylux/api test` after the main one, and record why in a comment.
- [X] T002 [P] In `API/package.json`, add the script `"worker": "tsx --conditions=@scrylux/source src/worker.ts"` and
  the dependency `"yaml": "^2.9.1"`. Run `pnpm install` and check that the lockfile adds no new version of `yaml`.
  `API/tsconfig.build.json` already includes all of `src`, so `src/worker.ts` builds to `dist/worker.js`.
- [X] T003 Run `pnpm run typecheck`, `pnpm run lint`, `pnpm run test` (with Postgres) and `pnpm run build`. All must
  pass, with nothing new tested yet. This is the green baseline.

**Checkpoint**: the job test group exists and the suite is green.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the tables, the shared record schemas, the provider-layer helpers, the job settings, the failure
messages and the shared provider check. Every story builds on these.

### Tests for Foundational

- [X] T004 [P] Write `DB/test/jobs-schema.test.ts` against `DB`'s own test database (`scrylux_db_test`, through
  `pool()` in `DB/test/helpers.ts`), which `apps/api`'s tests never touch, so `pnpm test` running both packages at
  once cannot interfere. Create its users with `seedUsers` and never claim or truncate. One case per rule of
  SPEC/data-model.md:
  - `jobs` defaults: `state` `'queued'`, `input` `'{}'`, `run` 0, `claim` 0, `queued_at` and `next_run_at` set.
  - Checks, each refused with its constraint name: `kind IN ('provider_check')`; `state` in the five states;
    `run BETWEEN 0 AND max_runs`; `max_runs BETWEEN 1 AND 5`; `time_limit_ms > 0`; `token_cap > 0`;
    `cost_cap_usd > 0`; `input` is an object; "`state = 'running'` ⇔ `worker_id` and `lease_expires_at` are set";
    "`state IN ('succeeded','failed','cancelled')` ⇔ `finished_at` is set"; "`failure_category` is set ⇔
    `state = 'failed'`"; `failure_category` only from the fourteen of SPEC/data-model.md (Milestone 1's eleven
    without `cancelled`, plus `cap_reached`, `timed_out`, `worker_lost`, `job_error`); "`failure_detail` null, or
    `cap_below_one_request` when `failure_category = 'cap_reached'`"; "`cancelled_by` is set ⇒ `state =
    'cancelled'` or (`state = 'running'` and `cancel_requested_at` is set)"; "`state = 'queued'` ⇒ `run <
    max_runs`"; "`started_at` and `deadline_at` are both set or both null".
  - `created_by` and `cancelled_by` reference `users (id) ON DELETE RESTRICT`.
  - The trigger `jobs_final_is_final` refuses any `UPDATE` of a row whose state is `succeeded`, `failed` or
    `cancelled`, including one that changes nothing else.
  - `job_usage`: `attempts BETWEEN 0 AND 5`; tokens and `duration_ms` `>= 0`; `operation IN ('generate','embed')`;
    `price_source IN ('operator','list','none')` with "`none` ⇔ `cost_usd IS NULL`"; `ON DELETE CASCADE` from
    `jobs`.
  - `workers`: defaults `started_at`, `last_seen_at` `now()`, `stopping` false.
  - The five indexes of SPEC/data-model.md exist with their names and predicates.
- [X] T005 [P] Add `jobs`, `job_usage` and `workers` to `COLUMNS` in `DB/test/schema-types.test.ts`, with every column
  of SPEC/data-model.md, so the compile-time and runtime checks cover them.
- [X] T006 [P] Write `LLM/test/status.test.ts`: every case of Milestone 1's configuration table
  (`specs/phase-3/milestone-1-llm-provider-layer/contracts/configuration.md`, already in `LLM/test/config.test.ts`)
  run through `parseLlmConfig` and `parseLlmStatus`. They agree on every result and every error message, except that
  `parseLlmStatus` accepts a missing `LLM_API_KEY` or `EMBEDDING_API_KEY` for `anthropic` and `gemini`. A key set for a
  provider that takes none (Bedrock) is refused by both: the parser has no rule on a key's form. The status never holds
  a key or an address.
- [X] T007 [P] Write `LLM/test/worst-case.test.ts` (SPEC/contracts/library-api.md):
  - generate with defaults: `5 × (estimateTokens(inputChars) + 16000)` tokens; with `attemptLimit: 1` and
    `maxOutputTokens: 1000`: `3 × (… + 1000)`.
  - embed: `3 × estimateTokens(inputChars)`.
  - cost from an operator price, from the list, from a tiered entry's higher tier; null with no price.
  - `requestSize` equals the size of what the client actually sends for a request with and without `content`
    (instructions, content section with preamble and markers, schema), checked against a stub server's recorded
    body length with `createLlmWithEndpoints`.
  - throws `LlmConfigError` for an operation that is not configured.
- [X] T008 [P] Write `API/test/jobs/config.test.ts` for `parseJobConfig` (SPEC/contracts/configuration.md): every
  default; every accepted edge (`JOB_MAX_RUNS=5`, `JOB_TIME_LIMIT=24h`, `PROVIDER_CHECK_COOLDOWN=0`,
  `WORKER_HEALTH_PORT=65535`, `JOB_COST_CAP=0.000001`); every refusal (zero caps, negative, a fraction for a whole
  number, 7 decimals, `JOB_TIME_LIMIT=30s`, `25h`, `1d`, `JOBS_PER_ACCOUNT=101`, `WORKER_CONCURRENCY=33`). Each
  message names the variable and does not contain the value given.
- [X] T009 [P] Write `API/test/jobs/failures.test.ts` for `API/data/failures.yaml` and its loader
  (SPEC/contracts/data-files.md): strict parse (an unknown key is refused); a hint for each of Milestone 1's eleven
  categories; a message and a hint for `cap_reached`, `cap_below_one_request`, `timed_out`, `worker_lost`,
  `job_error`; no other key; `{prefix}` is the only placeholder; `hint(category, 'LLM')` fills it.
- [X] T010 [P] Write `CORE/test/job.test.ts`: `JobRecord`, `JobTotals`, `JobDetail`, `JobsStatus`, `JobCreateInput`
  parse the examples of SPEC/contracts/http-api.md, refuse an extra field (strict objects), refuse an unknown state,
  kind or category, and `JobCreateInput` refuses any `input` for `provider_check` other than `{}`.
- [X] T011 [P] Write `API/test/jobs/log.test.ts`: `logJobState`, `logJobAction` and `logWorker` print one JSON line
  each with exactly the fields of SPEC/contracts/worker.md "Log lines" and SPEC/contracts/http-api.md, and nothing
  else.

### Implementation for Foundational

- [X] T012 Write `DB/migrations/016_jobs.sql` exactly as SPEC/data-model.md: the three tables, every check named as
  T004 expects, the trigger function and `jobs_final_is_final`, and the five indexes. Header comment: what each table
  is for and that the totals are summed on read (research #3). Run T004 until it passes.
- [X] T013 Add `JobsTable`, `JobUsageTable` and `WorkersTable` to `DB/src/schema.ts` and to `Database`, with
  `ColumnType` marking columns the database owns (`id` of `job_usage`, defaults). Run T005.
- [X] T014 [P] Write `CORE/src/schemas/job.ts` (strict zod objects, the fields of SPEC/contracts/http-api.md
  "Records") and export it from `CORE/src/index.ts`. Export the list of job failure categories and the
  `provider_check` steps (`generation`, `embeddings`) from it. Run T010.
- [X] T015 [P] In `LLM/src/config.ts`, give the parser an internal `requireKeys` flag and add `parseLlmStatus(env)`
  returning `llmStatus(parse(env, { requireKeys: false }))`. Export it from `LLM/src/index.ts`. Run T006 and
  Milestone 1's `config.test.ts`.
- [X] T016 [P] Write `LLM/src/worst-case.ts` with `worstCase` and `requestSize` (SPEC/contracts/library-api.md),
  importing the layer's own `estimateTokens`, `findPrice`, transient-retry bound and defaults rather than copying
  them; export the transient-retry bound from `attempts.ts` if it is not already. Export both from
  `LLM/src/index.ts`. Run T007.
- [X] T017 [P] Write `API/src/jobs/config.ts` with `parseJobConfig(env)` (pure, throws `Error` with the messages T008
  expects) and a module-level `jobConfig` read from `process.env` that falls back to defaults on a bad value, as
  `config.ts`'s `sessionConfigFromEnv()` does; `server.ts` and `worker.ts` validate for real. Run T008.
- [X] T018 [P] Write `API/data/failures.yaml` (SPEC/contracts/data-files.md), moving the eleven hints from
  `API/src/llm-check.ts`'s `hint()` unchanged, and `API/src/jobs/failures.ts` that reads it once, relative to the
  module (`new URL('../../data/failures.yaml', import.meta.url)`, which works from `src/` and `dist/`). In the
  `Dockerfile`'s final stage add `COPY --from=builder /app/apps/api/data ./data` after the `dist` copy. Run T009.
- [X] T019 Write `API/src/provider-check.ts`: `runProviderCheck(llm, config, { signal, beforeRequest })` sends what
  `llm-check.ts` sends today (`checkRequest()`) to each configured operation in order (generation, then embeddings)
  and returns per operation `{ status, provider, model, hosted, usage }`, or `{ status: 'not_configured' }`.
  `beforeRequest(operation, worstCase)` is awaited before each request and may throw to stop it (used by the budget
  and the gate, US2 and US3). Rewrite `API/src/llm-check.ts` to call it and format the same text with hints from
  `failures.ts`. Milestone 1's `API/test/llm/check.test.ts` must pass unchanged.
- [X] T020 [P] Write `API/src/jobs/log.ts` with the three functions of T011. Run T011.

**Checkpoint**: migration 016 applies; the shared schemas, settings, messages and helpers exist; the operator's
command prints exactly what it did.

---

## Phase 3: User Story 1 - Start a job and watch it to the end (Priority: P1) 🎯 MVP

**Goal**: a signed-in person starts a provider check, the worker runs it, and the UI shows it move from queued to
running to its end, with progress, usage and, for a failure, the message and hint.

**Independent Test**: the spec's US1 Independent Test, by `API/test/worker/run.test.ts`,
`API/test/contract/v1/jobs.test.ts` and the web tests.

### Tests for User Story 1

- [X] T021 [P] [US1] Write `API/test/jobs/store.test.ts` (part 1; the file starts with the `TRUNCATE` of T001 and
  creates two accounts):
  - `enqueue(db, { kind, input, accountId }, settings)` inserts a `queued` job with `token_cap`, `cost_cap_usd`,
    `max_runs` and `time_limit_ms` copied from `settings`.
  - `list(db, { limit, offset })`: newest first by `queued_at`, ties by `id` descending; `has_more`; starter's
    username.
  - `worker_lost` is true for a `running` job whose `lease_expires_at` has passed (set directly) and false otherwise,
    in `list` and `get` (FR-062).
  - `get(db, id)`: the record with totals summed from `job_usage` (FR-050): `cost_usd` null when any row's cost is
    null, `cost_known_usd` the sum of the known ones, `cost_cap_applied` false then; `tokens_estimated` and
    `cost_estimated` true if any row's is. With 0, 1 and 3 usage rows, the totals equal the sums (SC-006).
  - `claim(db, workerId)`: takes the oldest `queued` job whose `next_run_at <= now()`, skips a later one, skips one
    whose `next_run_at` is in the future; sets `running`, `run` and `claim` up by one, `worker_id`,
    `lease_expires_at` about 30 s ahead, `started_at` and `deadline_at = started_at + time_limit_ms` on the first claim
    only; returns null when nothing is due.
  - Fencing: `writeProgress` and `finishRun` with a stale `claim` number change nothing and report that the job was
    lost (FR-005).
  - `finishRun` to `succeeded` sets `finished_at` and `result`; to `failed` sets `failure_category` (and
    `failure_detail`). `recordUsage` inserts a `job_usage` row without fencing.
- [X] T022 [P] [US1] Write `API/test/worker/run.test.ts`: an in-process worker (`startWorker(options)` of T030 with
  timings shortened to tens of milliseconds) against `startStub` from `@scrylux/llm/testing`, with an
  openai-compatible generation provider declared local:
  - A provider check succeeds: states seen in order `queued`, `running`, `succeeded`; progress `generation` then
    (with embeddings configured) `embeddings`; one `job_usage` row per operation with Milestone 1's fields; the
    result of SPEC/data-model.md "provider_check result" with `usage_id`s; one job log line per state change.
  - The stub rejects the key (401): the job ends `failed` with `not_authorized` after one run (`run` = 1).
  - Embeddings not configured: `embeddings.status` is `not_configured` and the job succeeds (FR-092).
  - The worker registers in `workers` and updates `last_seen_at`; `workerAlive(db)` is true while it runs and false
    after it stops or once its row is older than 30 s (FR-008).
  - Concurrency (FR-006): with `concurrency: 2` and 5 jobs inserted directly against a stub that holds its answers,
    never more than 2 of them are `running` with this worker's `worker_id` at once; releasing the stub lets all 5
    finish. With the default of 1, never more than 1.
  - Progress never goes backwards within a run (FR-015): every value the test reads while polling the row is at or
    after the previous one in the kind's step order.
- [X] T023 [P] [US1] Write `API/test/contract/v1/jobs.test.ts` (in the `jobs` group). Before importing the app, set
  `process.env` for an openai-compatible generation provider declared local and `PROVIDER_CHECK_COOLDOWN=0`
  (Vitest gives each file its own modules). Through the HTTP app with a signed-in token:
  - `GET /api/v1/jobs/status`: `worker_alive` false, `ai` with provider, model and `hosted: false` and no key or
    address anywhere in the body, `provider_check.offered` true.
  - A job in the list and its detail have `worker_lost: false` while queued.
  - `POST /api/v1/jobs` `{ "kind": "provider_check", "input": {} }`: `201`, `state: "queued"`, and one
    `{"event":"job","action":"start",…}` log line.
  - `400` for a missing kind, an unknown kind, and `input: { "x": 1 }`; `401` without a token.
  - `GET /api/v1/jobs` newest first with `has_more`; `limit=0`, `limit=101` and `offset=-1` answer `400`.
  - `GET /api/v1/jobs/:id`: the detail; `404` `Job not found`; `400` `Invalid id`.
  - Every success body parses with the `CORE` schemas.
- [X] T024 [P] [US1] Write `API/test/contract/v1/jobs-off.test.ts` (in the `jobs` group) with no provider settings:
  `GET /jobs/status` has `ai.generation` and `ai.embedding` null and `provider_check.offered` false; `POST /jobs`
  answers `409` `AI is not configured on this install` and queues nothing (FR-063).
- [X] T025 [P] [US1] Write `WEB/src/pages/JobsPage.test.tsx` with mocked API answers: AI status lines (not
  configured; provider, model and "hosted: data sent to it leaves this install" or "local: stays in this install");
  the "Check AI provider" button, which posts and shows the new job; the list with kind, state, starter, queued time,
  progress for a running job and tokens and cost for a finished one, each row linking to `/jobs/:id`; "Show more";
  the no-worker notice exactly when `worker_alive` is false and a job is queued, or when a listed job has
  `worker_lost` (FR-062), and "Worker lost" in that job's row; the "AI is not configured"
  text instead of the button (FR-063). With fake timers: refetches every 2 s while a listed job is queued or running,
  and stops when all are final (FR-061). A value containing `<b>` is shown as text (FR-066).
- [X] T026 [P] [US1] Write `WEB/src/pages/JobPage.test.tsx`: header (kind, state, starter, times, "next run at" while
  waiting); progress step text ("Checking generation", "Checking embeddings") with done of total; the failure
  message and hint for a failed job; the lost-worker text of SPEC/contracts/ui.md while `worker_lost`; refetch every
  2 s while queued or running, none once final; the app's not-found message for a `404`.
- [X] T027 [P] [US1] In `WEB/src/components/AppShell.test.tsx`, add: the header has a **Jobs** link to `/jobs`, and
  rendering the shell makes no request to `/api/v1/jobs` (FR-061a).

### Implementation for User Story 1

- [X] T028 [US1] Write `API/src/jobs/store.ts` part 1, the functions of T021, with Kysely or parameterized `pg`.
  `claim` is one statement: `UPDATE jobs SET … WHERE id = (SELECT id FROM jobs WHERE state = 'queued' AND
  next_run_at <= now() ORDER BY queued_at, id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`. Every worker write has
  `WHERE id = $1 AND claim = $2 AND state = 'running'`. `finishRun` already writes `cancelled` instead of its target
  when `cancel_requested_at` is set (`CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE … END`), and then
  leaves `failure_category` null (research #4). Totals are one aggregate query over `job_usage`. Also `workerAlive`,
  `registerWorker`, `touchWorker`, `removeWorker`, `deleteStaleWorkers` (not seen for 24 hours). Run T021.
- [X] T029 [P] [US1] Write `API/src/worker/timing.ts` with the values of research #5 (poll 2 s, heartbeat 5 s, lease
  30 s, liveness report 10 s, alive within 30 s, grace 30 s) as one exported `defaultTimings` object, which
  `startWorker` accepts overrides of.
- [X] T030 [US1] Write `API/src/worker/kinds.ts` (the registry: for `provider_check`, its input schema from `CORE`, its
  steps, `callsModel: true`, and `run(context)`, which calls `runProviderCheck` with progress written before each
  step and returns the result of SPEC/data-model.md), `API/src/worker/run.ts` (one claimed job: start the heartbeat
  timer, which extends the lease; run the kind with an `AbortController`; record each request's usage with
  `recordUsage`; end with `finishRun`: `succeeded`, or `failed` with the category; a heartbeat that finds the job lost
  aborts and writes nothing more) and `API/src/worker/loop.ts` (`startWorker(options)`: register, report liveness
  every 10 s, poll every 2 s and claim while fewer than `concurrency` jobs run, `stop()`). Log each state change with
  `logJobState`. Map a layer outcome to a job category per SPEC/data-model.md. Run T022.
- [X] T031 [US1] Write `API/src/worker.ts`, the entry point: `config.load()`, `parseLlmConfig` with keys (via
  `llmEnvironment`), `parseJobConfig`, `migrate()` with the API's retry while the database starts, then
  `startWorker` with `createLlm(config, { log })`. Fixed lines on failure, exit 1, as SPEC/contracts/worker.md. (The
  full set of start-up refusals is tested in US5.)
- [X] T032 [US1] Write `API/src/v1/jobs.ts` with four operations through `defineOperation`: `GET /jobs/status`,
  `GET /jobs`, `POST /jobs` (validate, refuse `409` when the kind calls a model and `parseLlmStatus(process.env)` has
  neither operation configured, then `enqueue` with `jobConfig`; log with `logJobAction`), `GET /jobs/:id`. Register
  them in `API/src/v1/operations.ts`. The status endpoint's `ai` comes from `parseLlmStatus` once per process. Run
  T023 and T024.
- [X] T033 [P] [US1] In `WEB/src/api/queries.ts`, add `keys.jobs`, `keys.job(id)`, `keys.jobsStatus` and
  `useJobsStatus`, `useJobs` (with "Show more" by offset), `useJob(id)` and `useStartJob`, each parsing answers with
  the `CORE` schemas. `refetchInterval` is 2000 when a shown job is `queued` or `running`, otherwise false.
- [X] T034 [US1] Write `WEB/src/pages/JobsPage.tsx` and `WEB/src/pages/JobPage.tsx` per SPEC/contracts/ui.md (the parts
  T025 and T026 test), add `/jobs` and `/jobs/:jobId` to `appRoutes` in `WEB/src/App.tsx`, and the **Jobs** link in
  `WEB/src/components/AppShell.tsx`. Run T025–T027.
- [X] T035 [US1] Regenerate `API/openapi.json` with `pnpm --filter @scrylux/api openapi` and run the existing OpenAPI
  contract test until it covers the new operations.

**Checkpoint**: a provider check can be started, runs on a worker, and is watched to its end in the UI.

---

## Phase 4: User Story 2 - A job cannot overspend (Priority: P1)

**Goal**: before each model request the job checks its worst case against its caps, counting every earlier run, and
one account cannot have more than `JOBS_PER_ACCOUNT` jobs active.

**Independent Test**: the spec's US2 Independent Test, by `API/test/worker/budget.test.ts` and the store tests.

### Tests for User Story 2

- [X] T036 [P] [US2] Write `API/test/worker/budget.test.ts`, the worker against stubs that report token counts:
  - With `token_cap` below the generation worst case but above the embedding one, set directly on the job row: the
    job ends `failed`, `cap_reached`, `failure_detail` `cap_below_one_request`, and the stub received no request
    (FR-044).
  - With `job_usage` rows from an earlier run inserted directly so that used + worst case passes `token_cap`: no
    request is sent, `cap_reached` without the detail (FR-041, FR-042).
  - Cost cap with an operator price (`LLM_PRICE_INPUT`, `LLM_PRICE_OUTPUT`): same two cases on cost.
  - Unknown price: the cost cap is not applied, the token cap still is, the job succeeds when tokens fit, and its
    totals show `cost_usd` null and `cost_cap_applied` false (FR-043).
  - Estimated tokens (the stub omits `usage`) count as reported, never 0 (US2 scenario 5).
  - In every case the job's recorded tokens are at or under `token_cap` (SC-004).
- [X] T037 [P] [US2] Add to `API/test/jobs/store.test.ts`: `gate(db, job)` returns the usage so far and `ok` for a
  held job; `lost` with a stale claim; `cancel_requested` when one was asked; `deadline_passed` once `deadline_at` is
  in the past (set directly). And the per-account limit with `settings.jobsPerAccount = 3` and cooldown off: three
  `enqueue`s succeed, the fourth throws the limit error; ten concurrent `enqueue`s for one account leave exactly 3
  active jobs; another account is not affected; a finished job frees a place (FR-046).
- [X] T038 [P] [US2] Add to `API/test/contract/v1/jobs.test.ts`: with `JOBS_PER_ACCOUNT=1` set before import (in a new
  file `jobs-limit.test.ts` if the env differs from the first file's), a second start answers `429`, a `Retry-After`
  of 30, and the fixed message of SPEC/contracts/http-api.md naming 1.
- [X] T039 [P] [US2] Add to `WEB/src/pages/JobPage.test.tsx`: runs used of the maximum; caps; totals with
  "estimated" when any were; "unknown (at least $x)" and "the cost cap could not be applied" for an unknown price; the
  usage table; the `cap_below_one_request` message.

### Implementation for User Story 2

- [X] T040 [US2] Add `gate(db, job)` to `API/src/jobs/store.ts`: one fenced statement that checks `claim`, `state =
  'running'`, `cancel_requested_at IS NULL` and `deadline_at > now()`, and returns the job's `job_usage` sums. Add the
  per-account limit to `enqueue`: one transaction that takes `pg_advisory_xact_lock(<jobs namespace>, account_id)`
  (two-integer form, a named constant namespace, research #12), counts the account's `queued` and `running` jobs, and
  throws the limit error at `jobsPerAccount`. Run T037.
- [X] T041 [US2] Write `API/src/worker/budget.ts`: `checkBudget(gateResult, job, worstCase)` returns `ok`, or
  `cap_reached` with `cap_below_one_request` when the worst case alone passes a cap; the cost cap is checked only when
  `worstCase.costUsd` and every used cost are known. Wire it into `run.ts` as the `beforeRequest` of
  `runProviderCheck`: call `gate`, then `checkBudget`, and end the job as `failed` with the result before anything is
  sent. Run T036.
- [X] T042 [US2] In `API/src/v1/jobs.ts`, answer the limit error with `429`, `Retry-After: 30` and the fixed message;
  add `429` to `STATUS_DESCRIPTIONS` in `API/src/v1/openapi.ts`; regenerate `API/openapi.json`. Run T038.
- [X] T043 [US2] Add the usage section to `WEB/src/pages/JobPage.tsx` per SPEC/contracts/ui.md. Run T039.

**Checkpoint**: no job can pass its caps, and one account cannot fill the queue.

---

## Phase 5: User Story 3 - Cancel a job (Priority: P1)

**Goal**: a queued job never starts; a running job stops within 10 s, sends nothing more, and keeps its usage.

**Independent Test**: the spec's US3 Independent Test, by `API/test/worker/cancel.test.ts` and the contract tests.

### Tests for User Story 3

- [X] T044 [P] [US3] Add to `API/test/jobs/store.test.ts`: `cancel(db, id, accountId)` on a `queued` job →
  `cancelled` at once with `cancelled_by` and `finished_at`; on a `running` job with a live lease →
  `cancel_requested_at` and `cancelled_by` set, still `running`; on a `running` job whose lease expired →
  `cancelled` at once; a cancel asked while the lease was live, then the lease moved into the past directly, then a
  second cancel → `cancelled` at once (FR-030, edge case "A worker that dies holding a job"); on a final job → the
  "already finished" error and no change; twice on a running job with a live lease → no change the second time. And "cancel wins": with a cancel asked, `finishRun` to `succeeded`, to `failed` and to
  `queued` each leave the job `cancelled` with `failure_category` null and the result stored (research #4).
- [X] T045 [P] [US3] Write `API/test/worker/cancel.test.ts`:
  - A stub that holds its answer: cancel through `cancel()` while the request is in flight; the job is `cancelled`
    within 10 s (with default heartbeat timing, measured), the held request was aborted, no request reaches the stub
    after the cancel, and the aborted request's usage row exists as far as Milestone 1 reports it (FR-033, SC-003).
    Give this test an explicit 20-second timeout: it is the one case that measures at the default heartbeat. Every
    other case in the file uses shortened timings.
  - The same, with shortened timings, with the worker in a second `startWorker` instance from the one the test
    cancels through, sharing only the database (SC-003 "another worker process").
  - A cancel asked just after the generation request returns: the embeddings request is never sent (the gate).
  - A cancelled queued job is never claimed by a worker started afterwards.
- [X] T046 [P] [US3] Add to `API/test/contract/v1/jobs.test.ts`: `POST /api/v1/jobs/:id/cancel` on a queued job →
  `200` `cancelled` and one `{"event":"job","action":"cancel",…}` line; on a final job → `409` `The job has already
  finished`; another account can cancel it (FR-065); `404` and `400` as other routes.
- [X] T047 [P] [US3] Add to `WEB/src/pages/JobPage.test.tsx`: the **Cancel** button while queued or running, with the
  confirmation dialog; "Cancelling…" while `cancel_requested`; who cancelled it and when for a cancelled job; no
  button for a final job; a `409` shows its message.

### Implementation for User Story 3

- [X] T048 [US3] Add `cancel` to `API/src/jobs/store.ts` (the cases of T044). Make the heartbeat in `run.ts` read back
  `cancel_requested_at` and abort the run's controller when it is set, and make `run.ts` end an aborted run through
  `finishRun` (which writes `cancelled`). Run T044 and T045.
- [X] T049 [US3] Add `POST /jobs/:id/cancel` to `API/src/v1/jobs.ts`, logged with `logJobAction`; regenerate
  `API/openapi.json`. Run T046.
- [X] T050 [US3] Add the cancel button, confirmation, "Cancelling…" and canceller to `WEB/src/pages/JobPage.tsx`, with
  `useCancelJob` in `WEB/src/api/queries.ts`. Run T047.

**Checkpoint**: US1–US3 together are the MVP: start, watch, cap and cancel.

---

## Phase 6: User Story 4 - Jobs survive failures and restarts (Priority: P2)

**Goal**: transient failures and lost workers run the job again, up to its runs and its deadline; a stopping worker
hands its jobs back; no job runs twice at once.

**Independent Test**: the spec's US4 Independent Test, by `API/test/worker/recovery.test.ts` and the store tests.

### Tests for User Story 4

- [X] T051 [P] [US4] Add to `API/test/jobs/store.test.ts`:
  - `finishRun` with a transient category (`provider_unavailable`, `rate_limited`) and `run < max_runs` → `queued`,
    `next_run_at` between the backoff and a quarter more (30 s for the first, then 2 min, 8 min, 10 min, research #6);
    on the last run → `failed` with that category (FR-020, FR-021).
  - Every other category ends the job at once.
  - `sweep(db)`: a `running` job with an expired lease becomes `cancelled` if a cancel was asked, `failed`
    `timed_out` if its deadline passed, `failed` `worker_lost` if `run = max_runs`, else `queued` with a backoff;
    a `queued` job waiting past its deadline becomes `failed` `timed_out`.
  - `handBack(db, job)`: `queued`, `next_run_at = now()`, `run` one less, `claim` unchanged; `cancelled` if a cancel
    was asked; with `max_runs = 1` the handed-back job is claimable again.
  - Two `claim` loops in parallel over 100 queued jobs, inserted directly into `jobs` (not through `enqueue`, which
    the per-account limit and the cooldown would refuse): every job claimed exactly once (SC-005).
- [X] T052 [P] [US4] Write `API/test/worker/recovery.test.ts` with shortened timings:
  - The stub answers 503 on the first run and well on the second: the job succeeds with `run` = 2 and both runs'
    usage rows (US4 scenario 1).
  - The stub always answers 503 with `max_runs` 3: `failed` `provider_unavailable` after 3 runs (SC-008).
  - A worker stopped hard (its timers cleared without hand-back, simulating a crash) while a stub holds a request: a
    second worker picks the job up after the lease, `run` up by one, and it finishes; the first worker's late
    `finishRun` changes nothing (FR-005, FR-007).
  - `stop()` with a job held past the grace period: the job is handed back, run given back, and finishes on another
    worker; the stop log line has `handed_back: 1`.
  - A deadline that passes during a held request: `failed` `timed_out` within one heartbeat plus 1 s of `deadline_at`,
    with shortened timings; one case at the default heartbeat checks the 10-second bound, with an explicit 20-second
    timeout (SC-008).
  - Two workers and 100 jobs, inserted directly into `jobs`, against a fast stub: every job `succeeded`, each run once
    (SC-005).

### Implementation for User Story 4

- [X] T053 [US4] Add to `API/src/jobs/store.ts`: the transient path of `finishRun` with the backoff and jitter in SQL
  (`now() + interval`), `sweep` and `handBack`. Run T051.
- [X] T054 [US4] In `API/src/worker/run.ts`, have the heartbeat also read whether `deadline_at` has passed and abort
  with `timed_out`; map a run aborted by the deadline to `timed_out`. In `API/src/worker/loop.ts`, call `sweep` before
  each claim; on `stop()`, mark the worker stopping, stop claiming, wait up to the grace period, abort the rest and
  `handBack` each, remove the `workers` row, log the stop line. In `API/src/worker.ts`, call `stop()` on `SIGTERM` and
  `SIGINT`, and exit at once on a second signal. Run T052.

**Checkpoint**: restarts, crashes and outages no longer lose or duplicate jobs.

---

## Phase 7: User Story 5 - An operator runs the worker (Priority: P2)

**Goal**: the worker ships in the image and both compose files, refuses a bad configuration, has a health check, and
holds the keys; the API runs without them; v0.1 works with no worker.

**Independent Test**: the spec's US5 Independent Test, by `API/test/worker/startup.test.ts`,
`API/test/worker/health.test.ts`, `API/test/llm/startup.test.ts` and `scripts/compose.test.ts`.

### Tests for User Story 5

- [X] T055 [P] [US5] Write `API/test/worker/startup.test.ts` against `checkWorkerStartup(env, keys)`, the function
  `worker.ts` uses, which returns `{ ok, line }` like `checkLlmConfig`:
  no provider → ok, `AI providers: generation off, embeddings off`; Anthropic without a key → refused naming
  `LLM_API_KEY` (the worker keeps Milestone 1's rule); a vendor variable (`OPENAI_API_KEY`) → refused naming it; each
  bad job setting → refused naming it. No line holds a value (SC-009).
- [X] T056 [P] [US5] Write `API/test/worker/health.test.ts`: `startHealthServer(port)` answers `GET /health` with
  `200 {"status":"ok"}` from the moment it starts, and still `200` after the worker's `stop()` begins and until the
  server closes (Principle IV: `/health` returns 200, research #10); `404` for another path or method; it never
  touches the database (run with the pool unreachable).
- [X] T057 [P] [US5] Change `API/test/llm/startup.test.ts` for FR-071: Anthropic with `LLM_PROVIDER` and `LLM_MODEL`
  and no key is now `ok` with `generation anthropic (hosted)`; a key set for Bedrock, which takes none, is still refused;
  a vendor variable is still refused. Add: the server's start-up also refuses a bad job setting with its name.
- [X] T058 [P] [US5] Write `scripts/compose.test.ts` (root `yaml` devDependency): in `docker-compose.yml` and
  `docker-compose.release.yml`, a `worker` service exists with the same `build` or `image` as `app`, `command:
  ["node", "dist/worker.js"]`, the `DB_*` settings, every `LLM_*` and `EMBEDDING_*` setting including the keys, the
  job settings, a health check calling `/health` on 3001, and `depends_on` the database being healthy; the `app`
  service has no `LLM_API_KEY` and no `EMBEDDING_API_KEY`, but keeps the other provider settings; the worker publishes
  no port.

### Implementation for User Story 5

- [X] T059 [US5] Write `API/src/worker/health.ts` (`node:http`, the answers of T056). Move the start-up checks of
  `worker.ts` into `checkWorkerStartup`; start the health server before the loop and close it as the process exits.
  Run T055 and T056.
- [X] T060 [US5] In `API/src/llm-startup.ts`, make `checkLlmConfig` use `parseLlmStatus` (FR-071), keeping its line
  format. In `API/src/server.ts`, validate `parseJobConfig(process.env)` at start with a fixed `Startup failed:` line
  naming the variable. Add the `worker` service to `docker-compose.yml` and `docker-compose.release.yml` per T058,
  move `LLM_API_KEY` and `EMBEDDING_API_KEY` from `app` to `worker` with a comment saying why (FR-071), and pass the
  eight job settings to both services. In `docker-compose.release.yml`, leave `SCRYLUX_VERSION`'s default as it is
  and add a comment on the `worker` service: the image has `dist/worker.js` from the next release on, and the release
  checklist (`docs/releasing.md`) sets the default to that release's version, so the attached file always names an
  image that has the worker. Run T057 and T058.
- [X] T061 [US5] Guard test. Write `API/test/worker/canary.test.ts`: with `LLM_API_KEY=sk-canary-7f3e…` (a
  recognizable fake) and fake content text `CANARY-CONTENT-91b2` put in the stub's answers and in a provider error
  body, run a check through each outcome (success, `not_authorized`, `provider_unavailable` to the last run,
  `cap_reached`, `cancelled`, `timed_out`); capture stdout and stderr; read every `jobs` and `job_usage` row and every
  API answer for those jobs. Neither string appears anywhere (FR-051, SC-007). The pages render only these API
  answers, as text (FR-066), so the API answers stand for the pages in SC-007; say so in a comment. Must pass when
  written.
- [X] T062 [US5] Guard test. Write `API/test/worker/imports.test.ts`, walking static imports transitively within
  `API/src`:
  - from `API/src/worker.ts`: fail if it reaches `express`, `app.ts`, `routes/` or `v1/` (research #2);
  - from `API/src/server.ts`: fail if it reaches `provider-check.ts`, `worker/`, or an import of `createLlm` from
    `@scrylux/llm`, so the API process can never send a provider request (FR-070).

  Must pass when written.
- [X] T063 [US5] In `docs/install.md`: the eight variables in the environment-variable table (FR-081, the wording of
  SPEC/contracts/configuration.md); a "Running the worker" section (the command, the compose service, scaling with
  `--scale worker=N`, the health check, that v0.1 features need no worker); and "which process gets what", saying that
  provider keys go to the worker only and that a key in the `DB_SECRET_ID` secret reaches both processes (research
  #11).

**Checkpoint**: an operator can run, scale and health-check the worker; the API holds no key.

---

## Phase 8: User Story 6 - Check the AI provider from the UI (Priority: P2)

**Goal**: the provider check's per-operation result on the job page, the per-account cooldown, and the operator's
command kept identical and runnable in the worker's container.

**Independent Test**: the spec's US6 Independent Test, by the tests below and `WEB/e2e/jobs.spec.ts`.

### Tests for User Story 6

- [X] T064 [P] [US6] Add to `API/test/jobs/store.test.ts`: with `providerCheckCooldownMs = 300000`, a second
  `enqueue` of `provider_check` by the same account throws the cooldown error with the time remaining; after
  cancelling the first, still refused (FR-047); another account is not affected; with the first's `queued_at` moved
  back 301 s directly, accepted; with cooldown `0`, never refused; concurrent starts let exactly one through (SC-011).
- [X] T065 [P] [US6] Add a contract file `API/test/contract/v1/jobs-cooldown.test.ts` (default cooldown):
  `GET /jobs/status` gives `provider_check.next_allowed_at` null, then after a start a time about 5 min ahead; a second
  start answers `429`, `Retry-After` in whole seconds, and `You can start the next provider check in 5 minutes`.
- [X] T066 [P] [US6] Add to `API/test/worker/run.test.ts`: one operation `ok` and one failing (`not_available`) →
  the job `failed` with `not_available`, and the result still shows the `ok` operation with its usage (FR-092); the
  generation request body the stub received equals the one `llm-check.ts` sends (FR-093).
- [X] T067 [P] [US6] Add to `WEB/src/pages/JobPage.test.tsx` and `JobsPage.test.tsx`: one result block per operation
  with provider, model, hosted or local, outcome with message and hint, and its usage; the button disabled with the
  time of the next allowed check while `next_allowed_at` is in the future; a `429` shows its message.
- [X] T068 [P] [US6] Write `WEB/e2e/jobs.spec.ts` (`test.describe.configure({ mode: 'serial' })`). In `beforeAll`:
  start a small `node:http` stub on a free port that answers `POST /v1/chat/completions` with a completion whose
  content is `{"<field>":"ok"}`, the field read from `packages/llm/prompts/check.yaml`; start `node ../api/dist/server.js`
  on port 3101 and `node ../api/dist/worker.js` with `WORKER_HEALTH_PORT` 3102, both with the test database env plus
  `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL=http://127.0.0.1:<stub>/v1`, `LLM_LOCAL=true`, `LLM_MODEL=stub`,
  `PROVIDER_CHECK_COOLDOWN=0`; wait for both `/health`. Stop all three in `afterAll`. Steps: sign in on 3101, open
  **Jobs**, see "local: stays in this install", start a check, see it reach "Succeeded" without a reload within 5 s of
  each change (SC-002), open it and see the generation result. Then stop the worker, start a check, and see the
  no-worker notice within 30 s; cancel it.

### Implementation for User Story 6

- [X] T069 [US6] Add the cooldown to `enqueue` in `API/src/jobs/store.ts`, inside the same locked transaction as the
  limit, from the account's latest `provider_check` `queued_at`, whatever its outcome; add `nextAllowedAt(db,
  accountId, settings)`. In `API/src/v1/jobs.ts`, answer the cooldown error with `429`, `Retry-After` and the fixed
  message, and fill `provider_check.next_allowed_at` in the status. Run T064 and T065.
- [X] T070 [US6] In `API/src/v1/jobs.ts`'s detail answer, add each operation's `message` (Milestone 1's
  `FAILURE_MESSAGES`) and `hint` (from `failures.ts`, with `LLM` or `EMBEDDING`) to the result; the job-level
  `failure` takes the failing operation's prefix. Make `kinds.ts` end a check whose operation failed with that
  operation's category while keeping the other's result. Run T066.
- [X] T071 [US6] Add the result blocks and the cooldown state of the button to `WEB/src/pages/JobPage.tsx` and
  `WEB/src/pages/JobsPage.tsx`. Run T067, then build and run T068.
- [X] T072 [US6] In `docs/ai-providers.md`: the check from the Jobs page and the cooldown; the check command now runs
  in the worker's container (`docker compose exec worker node dist/llm-check.js`); the job caps, their defaults, and
  that a model priced above about $60 per million output tokens needs a larger `JOB_COST_CAP` for the check
  (research #7); that the UI shows each provider as hosted or local.

**Checkpoint**: every story works on its own and together.

---

## Phase 9: User Story 7 - The worker and its jobs are in Scrylux's own threat model (Priority: P2)

**Goal**: the constitution's Threat Model section and `docs/threat-model/` record the worker, its entry points, its
records and the risks of FR-080.

**Independent Test**: the spec's US7 Independent Test; `pnpm --filter @scrylux/api exec vitest run test/dogfood`
passes.

- [X] T073 [US7] Amend `.specify/memory/constitution.md` to **1.15.0** (MINOR):
  - **Sync Impact Report**: a new report at the top, the 1.14.0 report summarised below it as in earlier reports.
    `Last Amended` becomes the day of the change.
  - **Principle III**: the target layout drops `apps/worker`; the worker is a second entry point of `apps/api`
    (research #2).
  - **Assets (current)**: job records and their usage records, which hold no content (FR-051); the provider keys are
    now held by the worker process, and the API process needs none (FR-071).
  - **Trust boundaries (current)**: the worker as a process inside the deployment, the only process that sends
    requests to a provider apart from the operator's check command; its health port, which serves no data.
  - **Entry points**: the five job routes. Any signed-in account can see and cancel every job and start a provider
    check, which makes the provider spend (FR-065), called out as a broadening until Phase 6.
  - **Denial of Service**: the planned per-job caps become *partially mitigated (Phase 3 Milestone 2)*: caps checked
    against each request's worst case before it is sent, retries counted against the same caps, the job time limit,
    `JOBS_PER_ACCOUNT` and the provider-check cooldown. Still open: many accounts, and one request a crashed worker
    may leave uncounted.
  - **Tampering**: a job run twice by a slow and a fast worker (*mitigated*: fencing by claim counter,
    `store.test.ts`, `recovery.test.ts`).
  - **Information Disclosure**: a key kept in the shared secret reaches the API process (*accepted*, research #11);
    the canary (`API/test/worker/canary.test.ts`).
- [X] T074 [US7] Update `docs/threat-model/` by the procedure in its README's "Updating the model", in a running
  Scrylux, never by hand-editing the files:
  1. Import `threat-model.scrylux.json` into project `Scrylux`.
  2. Add a process `Worker` inside the deployment's trust boundary; data flows `Job claims and results` between it
     and the database and `Model requests` from it to `LLM provider (hosted)`; keep the check command's flow; add the
     job routes to the API's description. Set flags as for the existing flows (encrypted in transit, sensitive data:
     the provider key on `Model requests`).
  3. Run **Generate threats** and decide every new threat by the README's status table, using T073's bullets.
  4. Add any FR-080 risk the rules did not derive as a threat of the model as a whole (the many-accounts spend, the
     shared secret).
  5. Download the Scrylux file and the Markdown report back to back, and replace the committed files.
  6. Run `pnpm --filter @scrylux/api exec vitest run test/dogfood` until it passes.
- [X] T075 [US7] In `docs/threat-model/README.md`: the model covers the system through Phase 3 Milestone 2, including
  the worker; leave the approval paragraph's dates unchanged and add that the Milestone 2 additions await the
  maintainer's approval.

**Checkpoint**: Principle V is satisfied in the same change.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [X] T076 [P] In `plan.md`: the tech-stack row "Job queue" becomes a Scrylux `jobs` table in Postgres, claimed with
  `FOR UPDATE SKIP LOCKED` (no extra service, no queue library); the repository layout drops `apps/worker` and says
  the worker is `apps/api`'s second entry point; Phase 3 Milestone 2's text drops pg-boss and `apps/worker`. Make the
  same change in `docs/roadmap.md`.
- [X] T077 [P] Add an Unreleased entry to `CHANGELOG.md` for operators: the worker service, the Jobs page and the
  provider check, the eight variables, that provider keys now go to the worker only, and that the check command runs
  in the worker's container.
- [X] T078 [P] If `README.md`'s quickstart or deployment section names the compose services or the AWS guide's single
  container (`step6-ec2-guide.md`), add the worker in one sentence each, linking `docs/install.md`.
- [X] T079 Full verification: `pnpm run typecheck`, `pnpm run lint` (the license check included), `pnpm run test`
  (with Postgres, as CI), `pnpm run build`, `pnpm run test:e2e`, `docker build .`. Fix anything red. No `TODO`, no
  commented-out code, no unused export.
- [X] T080 Run quickstart §2–§4 by hand (Ollama declared local; one hosted provider with the key on the worker only,
  including the `JOB_COST_CAP=0.0001` refusal; two workers, a hard kill and a stop). Record the date, provider, model,
  outcome and timings for the PR description. The maintainer supplies the hosted key: never write it to a file.
- [X] T081 Write `SPEC/pr-description.md` in the style of earlier milestones'. It must call out:
  - the security implications (Development Workflow: configuration and secrets handling, new routes);
  - the two maintainer decisions (own queue, worker in `apps/api`) and the `plan.md` and Principle III changes;
  - the spec changes made during planning (FR-042's billed calls, SC-008's wording, the caps edge case);
  - the change to Milestone 1's start-up rule for the API (FR-071) and the keys moving to the worker;
  - the broadening of FR-065;
  - that the committed `docker-compose.release.yml`'s `worker` service needs the next release's image, which the
    release checklist's version bump supplies (the file still defaults to `0.1.0` until then);
  - the constitution amendment to 1.15.0;
  - that the eval gate does not apply (no prompt or adapter change);
  - the record from T080.

  No AI attribution, no co-author line. Do not commit, push or open the PR.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: none.
- **Foundational (Phase 2)**: needs Setup. Blocks every story. T012 before T013; T019 needs T017 and T018.
- **US1 (Phase 3)**: needs Foundational.
- **US2 (Phase 4)**: needs US1 (`store.ts`, `run.ts`).
- **US3 (Phase 5)**: needs US1; T045's gate case needs T040 (US2).
- **US4 (Phase 6)**: needs US1; T052's crash and stop cases need US3's abort path (T048).
- **US5 (Phase 7)**: needs US1 (`worker.ts`). T061 needs US2–US4 (it runs every outcome). T062 any time after T031.
- **US6 (Phase 8)**: needs US1 and US2 (the locked `enqueue`). T068 needs the built app and the worker's
  entry point with its health server (T031, T059).
- **US7 (Phase 9)**: T073 after US5 (it describes the keys' move); T074 after T073.
- **Polish (Phase 10)**: needs all stories. T080 needs T079; T081 needs T080.

### Within each phase

- Tests are written and **seen failing** first; implementation follows.
- Files edited by more than one task, never by two at once: `API/src/jobs/store.ts` (T028, T040, T048, T053, T069);
  `API/test/jobs/store.test.ts` (T021, T037, T044, T051, T064); `API/src/worker/run.ts` (T030, T041, T048, T054);
  `API/src/v1/jobs.ts` (T032, T042, T049, T069, T070); `API/src/worker.ts` (T031, T054, T059);
  `API/test/contract/v1/jobs.test.ts` (T023, T046); `WEB/src/pages/JobPage.tsx` (T034, T043, T050, T071) and its
  test (T026, T039, T047, T067); `API/openapi.json` (T035, T042, T049).

## Parallel Opportunities

- **Setup**: T002 alongside T001.
- **Foundational tests**: T004–T011 together. **Foundational implementation**: T014, T015, T016, T017, T018, T020
  together after T012–T013; then T019.
- **US1 tests**: T021–T027 together. Then T029 and T033 alongside T028.
- **US2 tests**: T036–T039 together. **US3 tests**: T044–T047 together. **US4 tests**: T051, T052 together.
- **US5 tests**: T055–T058 together.
- **US6 tests**: T064–T068 together.
- **Polish**: T076, T077, T078 together.

### Example: the US1 tests at once

```text
T021 [US1] API/test/jobs/store.test.ts            storage, claim, fencing, totals
T022 [US1] API/test/worker/run.test.ts            the worker against stubs
T023 [US1] API/test/contract/v1/jobs.test.ts      the routes with AI configured
T024 [US1] API/test/contract/v1/jobs-off.test.ts  the routes with AI off
T025 [US1] WEB/src/pages/JobsPage.test.tsx        the Jobs page
T026 [US1] WEB/src/pages/JobPage.test.tsx         the job page
T027 [US1] WEB/src/components/AppShell.test.tsx   the header link, no polling
→ then T028 (store), T030 (worker), T032 (routes), T034 (pages)
```

## Implementation Strategy

### MVP first (User Stories 1–3)

Setup, Foundational, then US1, US2 and US3. That gives a provider check started from the UI, run by a worker,
watched to its end, held under its caps and cancellable: everything a person sees in this milestone. Stop and check
the three independent tests.

### Incremental delivery

1. **US4**: retries, recovery, the deadline and graceful stop, so restarts and outages lose nothing.
2. **US5**: start-up refusals, the health check, the compose services, the keys moved to the worker, the guards.
3. **US6**: the per-operation result, the cooldown, the end-to-end browser test.
4. **US7**: the constitution and the threat model.
5. **Polish**: `plan.md` and the roadmap, the changelog, full verification, live runs, PR description.

Each step leaves `pnpm run test` green.

---

## Phase 11: Convergence

- [X] T082 Show a provider-check operation that a cancel stopped as cancelled, not as failed, with a hint that fits a cancel: in `apps/web/src/pages/JobPage.tsx` `OperationResult` render status `cancelled` as "Cancelled" rather than "Failed: cancelled", and give `cancelled` its own hint in `apps/api/data/failures.yaml` (today it shares "Check {prefix}_PROVIDER." with `not_configured`, carried over from Milestone 1's `llm-check.ts`), updating `apps/api/test/jobs/failures.test.ts` and `apps/web/src/pages/JobPage.test.tsx` first; the operator command's output for a cancelled operation may keep its wording only if the test says why per FR-064, US3/AC5 (partial)
- [X] T083 Start the worker's health server before the loop claims anything, as `contracts/worker.md` "Start, in order" step 5 says: in `apps/api/src/worker.ts` call `startHealthServer` before `startWorker`, so a `WORKER_HEALTH_PORT` already in use stops the worker before it registers or claims a job (today the loop may claim a job, then the failed listen exits the process and the job loses a run to the lease); add a test in `apps/api/test/worker/startup.test.ts` or `health.test.ts` that a taken port leaves no `workers` row and no claimed job per plan: contracts/worker.md (contradicts)
- [X] T084 Show the no-worker notice whenever a listed job has `worker_lost`, even while another worker is alive, as FR-062 and `contracts/ui.md` item 3 say: in `apps/web/src/pages/JobsPage.tsx` change `noWorker` to `(!worker_alive && any queued) || any worker_lost`, and add the case "a worker is alive and a listed job has lost its worker" to `apps/web/src/pages/JobsPage.test.tsx` per FR-062 (partial)
