# Research: Worker and Jobs

Phase 0 of the plan. Each decision says what was chosen, why, and what else was weighed. Numbers in brackets (#n) are
used by [plan.md](./plan.md), [data-model.md](./data-model.md) and the contracts.

## 1. The queue: a Scrylux `jobs` table, not pg-boss

**Decision**: jobs live in Scrylux's own `jobs` table, created by a forward-only migration. Workers claim them with
`SELECT … FOR UPDATE SKIP LOCKED`. No queue library is added. `plan.md`'s tech-stack row, its repository layout and
Phase 3 Milestone 2's text change in this milestone's change, and so does `docs/roadmap.md`. The maintainer chose this
during planning (spec Clarifications, session 2026-10-31, planning).

**Rationale**:

- **The record has to exist anyway.** FR-011 and FR-052 need a permanent table with state, progress, caps, usage, the
  starter and the canceller, kept forever. pg-boss archives and then deletes finished jobs, so its table can never be
  that record. With pg-boss there would be two state machines, kept in step after every crash, retry and cancel.
- **Its features do not fit the rules.** pg-boss retries any failure up to `retryLimit`, while FR-020 retries only
  three categories. Its `cancel()` changes a row but does not reach a running handler, so a cancel has to be polled
  from our table all the same (FR-030). It does not stop a stale worker from writing to our table, so every write
  needs our own fencing in any case (FR-005).
- **Upgrades fight FR-003.** pg-boss 12.38.0 (checked 2026-10-31) can run without creating or migrating its schema
  (`migrate: false`, `createSchema: false`), and `getConstructionPlans()` gives SQL that could be committed as our
  migration. But its `check()` throws `pg-boss database requires migrations` whenever its schema version differs from
  the database's (`dist/contractor.js`). It shipped five releases between 2026-09-23 and 2026-10-13, so a Dependabot
  bump could stop the worker from starting until someone writes a migration.
- **What we need is small and well known**: claim in order with `SKIP LOCKED`, a lease renewed by a heartbeat, a fencing
  number in every worker write, a cancel flag read at each heartbeat, and a table of live workers. All of it runs on
  the Postgres that CI's `test` job already starts.
- **One less dependency** (Principle III): pg-boss brings `cron-parser`, `rrule-temporal` and `serialize-error` for
  scheduling and features this milestone excludes (spec FR-016: no scheduled or recurring jobs).

**Alternatives considered**:

- **pg-boss 12**, as `plan.md` named. Its heartbeat recovery, backoff and instance registry are written and tested,
  which is a real advantage. Rejected for the reasons above. Its OpenTelemetry support is opt-in and makes no network
  call by itself, so telemetry was not a reason.
- **Graphile Worker**, which shares the schema problem and needs its own migrations too.
- **`LISTEN`/`NOTIFY` to wake workers.** Not needed: a 2-second poll meets every target (#5), and it would add a
  connection held open per worker. A later milestone can add it if the poll becomes a cost.

## 2. Where the worker lives: an entry point in `apps/api`

**Decision**: the worker is `apps/api/src/worker.ts`, built to `dist/worker.js` and started from the same image with
`node dist/worker.js`, like the check command (`dist/llm-check.js`). Its modules are in `apps/api/src/worker/`. Job
storage, shared by the API routes and the worker, is in `apps/api/src/jobs/`. No new workspace package. The
constitution's Principle III and `plan.md` drop `apps/worker` from the target layout. The maintainer chose this during
planning.

**Rationale**:

- **The image does not grow.** The API's production deploy measured 237 MB of `node_modules` (2026-10-31, `pnpm
  deploy --prod`), most of it the provider SDKs, the AWS clients, `pg`, `kysely` and `zod`. A separate `apps/worker`
  needs nearly all of it, and a second `pnpm deploy` would copy it again: about 200 MB more.
- **The configuration loader is shared, not copied.** `config.load()` reads the database settings, the secrets-manager
  secret and the AI keys. The worker imports the same module, so the secret is parsed in one place.
- **The separation still holds.** The worker's entry point imports `config`, `db`, `jobs/`, `worker/` and
  `@scrylux/llm`, never `app.ts` or the routes. A test checks that it does not import Express (#13).

**Alternatives considered**: a separate `apps/worker` package (rejected for the image size and the shared loader it
would need), and a `packages/jobs` package (not needed once both users of job storage are in `apps/api`).

## 3. The tables

**Decision**: one migration, `016_jobs.sql`, creates three tables. [data-model.md](./data-model.md) has every column.

- **`jobs`**: one row per job. It holds its state machine, the claim counter that fences writes, the lease, the caps and
  limits copied when it was queued, its progress, its failure and its result.
- **`job_usage`**: one row per model request a job made, holding Milestone 1's usage record (FR-050).
- **`workers`**: one row per worker process, with the last time it reported. "Is any worker alive" (FR-008) is a
  query on this table, so the answer is right even when no job is running.

The totals a job shows are summed from `job_usage` when it is read, never stored, so they always equal the sum of its
records (FR-050, SC-006). Kysely types are added to `packages/db/src/schema.ts`, and `schema-types.test.ts` checks
them against the real columns, as for every other table.

**Rationale**: a column for each fact the spec names, and checks in the database for the rules that must never break
(states, final states never change back, caps positive). A trigger refuses any change to a row in a final state, so
neither the API nor a stale worker can move a finished job (FR-012).

**Alternatives considered**: storing usage as a JSON array on the job (harder to sum and to check), and a
`threat_model_id` column on `jobs` for Milestone 3 (left out: no job kind of this milestone belongs to a threat model,
so Milestone 3 adds it with its `ON DELETE CASCADE`, FR-052).

## 4. Claiming, leases, fencing and recovery

**Decision**:

- **Claim** (one statement): take the oldest job that is `queued`, whose `next_run_at` has come, ordered by
  `queued_at, id`, `FOR UPDATE SKIP LOCKED LIMIT 1`. Set it `running`, add one to `run` and to `claim`, set
  `worker_id`, set `lease_expires_at = now() + 30 s`, and set `started_at` and `deadline_at` on its first run only.
- **Two counters**: `run` counts the runs that count against `max_runs` (#6). `claim` counts every claim, never goes
  down, and is the fencing number. They differ only after a graceful hand-back, which gives its run back (#9) but
  can never reuse a fencing number.
- **Heartbeat** (every 5 s per running job): extend the lease, and read back `cancel_requested_at` and whether
  `deadline_at` has passed, in one fenced `UPDATE … RETURNING`. A heartbeat that updates no row means the job was
  taken away: the run is abandoned at once and writes nothing more.
- **Fencing**: every write a worker makes to a job (progress, result, state) has `WHERE id = $1 AND claim = $2 AND
  state = 'running'`. A worker that lost its lease, however slow, cannot write after another worker
  has claimed the job (FR-005). Usage rows are not fenced: a request that was made was made, and its usage counts
  against the caps whoever records it (FR-041).
- **A gate before each model request**: one fenced statement that confirms the job is still held, that no cancel was
  asked and that the deadline has not passed, and returns the job's usage so far for the budget (#7). A cancel or
  deadline reached between two heartbeats therefore stops the next request from going out (FR-030, FR-042, SC-003).
  The heartbeat still matters for a request already in progress, which it aborts.
- **A cancel wins over every ending**: every write that ends a run (success, failure, a transient failure that would
  queue it again, a hand-back) sets the state to `cancelled` instead when `cancel_requested_at` is set, in the same
  statement (`CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE … END`). A provider check whose work
  finished after a cancel was asked ends as `cancelled`; its result and usage are still stored and shown.
- **Recovery** (a sweep each worker runs before it claims): a `running` job whose lease has expired is a lost run
  (FR-007). It becomes `cancelled` if a cancel was asked, `failed` with `timed_out` if its deadline has passed,
  `failed` with `worker_lost` if it has used all its runs, and otherwise `queued` with a backoff wait (#6). The same
  sweep fails a `queued` job whose deadline has passed while it waited for its next run.
- **A lost worker as the UI sees it**: a `running` job whose `lease_expires_at` has passed is shown with
  `worker_lost: true`, computed on read. The no-worker notice covers it (FR-062). A cancel then ends it at once, because
  the API cancels a lease-expired job directly. During the lease (at most 30 s after the worker's last heartbeat), a dead
  worker cannot be told from a slow one, so a cancel is recorded as asked and takes effect at the lease's end, through a
  live worker's sweep or a second cancel (spec FR-030, edge case "A worker that dies holding a job").
- **Every time comes from the database's `now()`**, never a host's clock, so workers on hosts whose clocks disagree
  still agree on leases, deadlines and backoff (spec edge case "Clock differences").

**Rationale**: a 30-second lease renewed every 5 seconds survives five missed heartbeats (a garbage-collection pause, a
slow query) and still returns a crashed worker's job in at most 30 s plus one poll, well inside FR-007's 2 minutes.

**Alternatives considered**: advisory locks held for a job's life (a lost connection drops the lock, but a worker that
is alive and stuck keeps it forever, and nothing records who held it), and a lease of 2 minutes (slower recovery and
slower cancel of a job whose worker died, for no gain).

## 5. Timings

**Decision**, as constants in `apps/api/src/worker/timing.ts`, which tests may shorten through the worker's options
(never through the environment):

| What | Value | Bound it serves |
|---|---|---|
| Poll for a job when a slot is free | 2 s | a queued job starts within about 2 s |
| Heartbeat (lease, cancel, deadline) | 5 s | cancel within 10 s (FR-030): ≤ 5 s to notice, ≤ 1 s for the layer to stop (M1 SC-007) |
| Lease | 30 s | recovery within 2 min (FR-007) |
| Worker liveness report | 10 s | "no worker" shown within 30 s (FR-008) |
| A worker counts as alive | reported in the last 30 s | |
| Grace period on stop | 30 s | FR-007 |
| UI refresh while a shown job is active | 2 s | 5 s (FR-061) |

**Rationale**: each value sits well inside the bound it serves. The poll is two small indexed queries per worker
every 2 seconds, which an idle install does not notice.

## 6. Retries, the job time limit and backoff

**Decision**:

- **Which failures run again (FR-020)**: a run that ends with Milestone 1's `provider_unavailable` or `rate_limited`,
  or a run lost with its worker. Every other category ends the job at once.
- **Runs**: `JOB_MAX_RUNS` (default 3, from 1 to 5) is copied onto the job when it is queued. `run` counts every run
  that started, lost runs included. A run handed back when a worker stops (#9) does not count: the hand-back takes one
  off `run`, so a rolling restart never uses up a job's runs, even with `JOB_MAX_RUNS=1`. A queued job therefore always
  has `run < max_runs`: a transient failure on the last run fails the job instead of queueing it.
- **Waits before the next run**: 30 s, then 2 min, then 8 min, then 10 min (the last also for a fifth run), with up to
  a quarter more at random so that jobs failed by one outage do not all come back together.
- **The job time limit**: `JOB_TIME_LIMIT` (default `60m`) is copied when queued. `deadline_at` is set when the job first
  starts and covers every run and wait (FR-022). The heartbeat notices it (#4), aborts the request in progress and ends
  the job as `timed_out`. While a worker runs, a job never lives past its deadline by more than a heartbeat plus the
  layer's 1-second stop: under 10 s (SC-008). A job waiting for its next run is failed by the sweep, which only a
  running worker performs; with no worker alive it stays queued past its deadline, and the next worker to start fails
  it at once. The UI says that no worker is running (FR-062).

**Rationale**: Milestone 1 already retries a request twice within seconds (M1 FR-022). A job-level retry is for an
outage that lasts longer, so its waits are minutes.

## 7. Caps: the worst case before each request

**Decision**:

- **A budget per job**: before each model request the job asks its budget whether the request's worst case fits.
  Used = the sum of the job's `job_usage` rows, from every run (FR-041). Worst case = **billed calls × (estimated input
  tokens + output limit)** for generation, and **billed calls × estimated input tokens** for embeddings. If used plus
  worst case passes the token cap, or, where the price is known, the cost cap, the request is not sent and the job ends
  as `cap_reached` (FR-042). If the worst case alone passes a cap, the message says that the cap is lower than one
  request needs (FR-044).
- **Billed calls are the attempts Milestone 1 can make, not its free resends**: up to the request's schema attempts
  plus 2 transient retries (5 at the defaults). A free resend follows a 400 answer that comes before any generation
  (M1 research #4 and #9), so it spends nothing. This is a planning-time change to FR-042 (spec Clarifications,
  planning), which first counted every call, resends included. Counting them would raise the provider check's worst
  case from 5 × 16,300 to 9 × 16,300 tokens for calls that cost nothing.
- **`@scrylux/llm` exports the arithmetic**: `worstCase(config, request)` returns `{ tokens, costUsd }`, with `costUsd`
  null when the price is unknown. It uses the layer's own constants, estimate and price lookup, so the worker never
  copies them. A tiered price uses the higher tier. Embedding batches are counted at 3 tries each, which over-counts
  (M1's 2 retries are per request), on the safe side.
- **Unknown price (FR-043)**: the token cap still applies. A job with any unpriced request shows its cost as unknown,
  with the priced part as the least it cost, and says that the cost cap was not applied to every request.
- **Defaults**: `JOB_TOKEN_CAP` 500,000 tokens and `JOB_COST_CAP` 5.00 US dollars, copied onto each job when it is
  queued (FR-040, FR-045).

**The provider check's worst case at those defaults**: the check's fixed request is under 1,200 characters, so about
300 input tokens, with Milestone 1's default output limit of 16,000. Generation: 5 × (300 + 16,000) = 81,500 tokens.
Embeddings: 3 × about 10. Both fit 500,000. Cost at the generation model's price:

| Output price per million (examples from `prices.yaml`, checked 2026-10-21) | Worst case | Fits $5? |
|---|---|---|
| $20 (claude-opus-5-5) | about $1.61 | yes |
| $50 (claude-fable-5-1, gpt-6-astra) | about $4.02 | yes |
| $270 to $600 (the most expensive entries) | $22 to $48 | no: the check ends as "cap reached" before sending, and the message says the cap is lower than one request needs |

The documentation says that a model priced above about $60 per million output tokens needs a larger `JOB_COST_CAP`.
The check keeps Milestone 1's output limit, because a model that always reasons counts its reasoning against it (M1
research #7), and the UI check must behave like the operator's command.

**Rationale**: checking before sending makes the cap a ceiling rather than an alarm (spec US2). The only overrun left
is the error of a character-based input estimate, which the spec accepts.

**Alternatives considered**: checking after each request (lets a job pass its cap by a whole request), and a smaller
output limit for the check (a reasoning model would be cut off, and the check would report a failure that the real
features would not have).

## 8. The provider check job

**Decision**: kind `provider_check`, with input `{}` (FR-093). Its steps are `generation` and `embeddings`. For each
configured operation it sends exactly what `llm-check.ts` sends today (`checkRequest()`, M1 FR-047), through the
budget (#7), and stores a result per operation: provider, model, hosted or local, outcome, the hint for a failure and
the usage. An operation not configured is stored as `not_configured` and does not fail the job (FR-092). If an
operation fails, the job fails with that operation's category. If that category is transient, the whole check runs
again later, both operations, so a run never leaves a half result that looks complete (FR-014).

The operator's command and the job share one module, `apps/api/src/provider-check.ts`, that runs the operations and
returns results, so the two cannot drift. The command formats them as text; the job stores them.

## 9. The worker's life

**Decision**:

1. **Start**: `config.load()`, then the full Milestone 1 check of the provider configuration, keys required (FR-004),
   then the job settings (#11). A failure prints the setting's name, never its value, and exits with status 1.
2. **Migrations**: the worker runs the same `migrate()` as the API, under the same advisory lock, with the API's retry
   while the database starts. Whichever process starts first applies them, and the other waits on the lock. A compose
   `depends_on` cannot promise that the API has migrated before the worker claims.
3. **Register** in `workers`, start the health server (#10), start the loop. While starting, it deletes `workers` rows
   not seen for 24 hours, so the table does not grow with restarts.
4. **Loop**: sweep (#4), then claim while a slot is free (`WORKER_CONCURRENCY`, default 1, FR-006).
5. **Stop** (`SIGTERM`, `SIGINT`): stop claiming and mark itself stopping, let running jobs go on for up to 30 s, then
   abort them and hand each back with one fenced update (`queued`, `next_run_at = now()`, `run = run - 1`, or
   `cancelled` if a cancel was asked), so another worker takes it without waiting for the lease (FR-007). Then delete its `workers` row and exit.

## 10. The worker's health check

**Decision**: the worker serves `GET /health` on `WORKER_HEALTH_PORT` (default `3001`), answering `200 {"status":"ok"}`
whenever the process is up, from before the loop starts until it exits. No authentication, no database, no provider
(FR-010). Principle IV requires `/health` to return 200 with no dependency, as the API's does, so it reports only that
the process is alive. Draining on stop is handled by the platform's stop signal and the hand-back (#9), not by the
health answer. It listens on all addresses, like the API, and serves nothing else. The compose
files give the worker a health check that calls it with Node's `fetch`, because the image has no `curl`.

**Alternatives considered**: a health command that reads the `workers` table (needs the database, which Principle IV
keeps out of health checks); answering `503` while starting or stopping (Principle IV says `/health` returns 200; found
by the cross-artifact analysis, 2026-11-01); and no health check (FR-010 requires one).

## 11. Configuration

**Decision**: eight new environment variables, documented in `docs/install.md` (FR-081). Both processes parse all of
them with one function, `parseJobConfig`, at start, so a bad value stops either process with the variable's name
(FR-004, FR-040). The API uses the caps, runs, time limit, per-account limit and cooldown when it queues a job, and
copies them onto it. The worker uses its concurrency and port.
[contracts/configuration.md](./contracts/configuration.md) has the table.

**The API's provider settings without keys (FR-071)**: `@scrylux/llm` gains `parseLlmStatus(env)`, which applies every
rule of `parseLlmConfig` except that a missing key is allowed. A key that is set is still checked. The API's start-up
check uses it and logs the same line as today. The documented compose files give `LLM_API_KEY` and `EMBEDDING_API_KEY`
to the worker only. This replaces, for the API process only, Milestone 1's rule that a missing key stops start-up
(spec FR-071). The worker keeps it.

**The secret**: the worker reads the secrets-manager secret through the same `config.load()`. Both processes need the
database credentials, which live in that secret, so both read it whole. A key kept in the secret therefore still
reaches the API process, even though the API never uses it. Keeping keys from the API is possible only by setting them
in the worker's environment rather than in the secret, and the documentation says so. A separate secret for the worker
would close the gap, and is left for a later milestone. The threat model records this as an accepted limit (#14).

## 12. The HTTP API and the UI

**Decision**:

- **Routes** under `/api/v1`, through the existing operation table, so they are mounted and documented together
  ([contracts/http-api.md](./contracts/http-api.md)): `GET /jobs/status`, `GET /jobs`, `POST /jobs`, `GET /jobs/:id`,
  `POST /jobs/:id/cancel`.
- **The per-account limit and the cooldown** are checked in one transaction that first takes a transaction-scoped
  advisory lock on the account, so two starts at once cannot both pass (FR-046, FR-047). The lock uses the
  two-integer form, `pg_advisory_xact_lock(<jobs namespace>, account_id)`, whose key space Postgres keeps apart from the
  one-integer form the migrator uses (`pg_advisory_lock(727274)`), so no account id can collide with it. A refusal answers `429` with
  `Retry-After` and the usual `{ error }`.
- **Cancel**: a queued job is cancelled at once. A running job gets `cancel_requested_at`, and the worker ends it at its
  next heartbeat. A running job whose lease has already expired is cancelled at once. A final job answers `409` "The job
  has already finished" (FR-032).
- **Messages and hints** for every failure category are versioned data, `apps/api/data/failures.yaml` (FR-064). It holds
  the hints that `llm-check.ts` keeps in a `switch` today, which move there, and the four job categories' messages and
  hints. The operator's command and the API read the same file.
- **The UI**: a Jobs page at `/jobs`, linked from the header, and a job page at `/jobs/:jobId` (FR-061a). TanStack
  Query refetches every 2 s while a shown job is queued or running, and not otherwise, so no other page asks. All
  text is rendered by React as text (FR-066).

## 13. Testing

**Decision**, all in CI's required `test` check, with no provider and no secret (FR-082):

- **`packages/db`**: the migration, its checks and the final-state trigger; Kysely types against the columns.
- **`apps/api/test/jobs/`**: storage against Postgres. Claim order, two claimers on 100 jobs (each runs once, SC-005),
  fencing after a lease is taken, the sweep's four outcomes, cancel in each state, a cancel asked just before a run
  ends (it ends as cancelled), a hand-back on the last run with `JOB_MAX_RUNS=1` (the job runs again), the limit and the cooldown under
  concurrent starts, totals equal to the records (SC-006).
- **`apps/api/test/worker/`**: the worker in-process against `startStub` from `@scrylux/llm/testing`, with short timings
  (#5): a check that succeeds, a transient failure that runs again, a key rejection that does not, caps (token, cost,
  unknown price, a cap below one request), cancel while waiting on a held stub answer (within 10 s, no request after
  it, SC-003), the deadline (SC-008), a lost run picked up by a second worker, a graceful stop handing back, and a
  canary: a recognizable fake key and fake content appear in no log line, row or answer (SC-007).
- **Start-up**: the worker refuses each misconfiguration (SC-009). The API starts without keys (FR-071). The worker's
  entry point imports no Express (#2).
- **Contract**: the routes, their errors and the regenerated `openapi.json`.
- **Web**: Vitest for the Jobs page and job page (notices, polling stops when final, refusal messages).
- **Browser**: one Playwright spec, `jobs.spec.ts`, starts its own API, worker and stub provider on separate ports, so
  the rest of the suite still runs with no provider and no worker (SC-001), and checks the provider check end to end
  in the built app (SC-002).

## 14. Threat model and documentation

**Decision**: the constitution goes to **1.15.0** (MINOR), and `docs/threat-model/` is rebuilt by its documented
procedure in the same change (Principle V, FR-080):

- **Assets**: job and usage records (no content, FR-051). The provider keys now held by the worker only.
- **Process and flows**: the worker as a process inside the deployment, with flows to the database and to the hosted
  provider. The outbound flow moves from the check command alone to the worker and the command.
- **Entry points**: the five job routes. Any signed-in account can see and cancel every job, and start a provider
  check (FR-065), called out as a broadening.
- **Risks**: runaway spend (Denial of Service, partially mitigated: caps before each request, the per-account limit,
  the cooldown; open: many accounts, a crash's uncounted request); a job run twice (Tampering, mitigated by fencing);
  a job that never ends (mitigated by the deadline); the worker's health port (no data, no auth needed); the secret read
  whole by both processes (accepted, #11).
- **Principle III's layout** drops `apps/worker` (#2). `plan.md` and `docs/roadmap.md` change the queue and layout
  (#1, #2).
- **Docs**: `docs/install.md` (variables, running the worker, keys to the worker only), `docs/ai-providers.md` (the
  check command runs in the worker's container, the UI check, the caps and the price note of #7), both compose files,
  `README.md`'s quickstart if it names the services, `CHANGELOG.md`.
