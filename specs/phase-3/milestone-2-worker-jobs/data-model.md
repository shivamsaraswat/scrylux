# Data Model: Worker and Jobs

Phase 1 of the plan. Three tables, created by one forward-only migration, `packages/db/migrations/016_jobs.sql`
(research #3), and the records the API returns. Every time below is the database's `now()` (research #4).

## Table `jobs`

One row per job (spec Key Entities: Job). Kept indefinitely (FR-052).

| Column | Type | Rules | Spec |
|---|---|---|---|
| `id` | `UUID` | primary key, `DEFAULT gen_random_uuid()` | FR-011 |
| `kind` | `TEXT` | `CHECK (kind IN ('provider_check'))`. A later kind widens the check in its own migration | FR-013, FR-090 |
| `input` | `JSONB` | `NOT NULL DEFAULT '{}'`, an object. Checked against the kind's zod schema before insert. Holds identifiers only, never content | FR-013, FR-051 |
| `state` | `TEXT` | `NOT NULL DEFAULT 'queued'`, one of `queued`, `running`, `succeeded`, `failed`, `cancelled` | FR-012 |
| `created_by` | `INTEGER` | `NOT NULL`, references `users (id) ON DELETE RESTRICT`, as `projects.created_by` | FR-011 |
| `queued_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | FR-011, FR-016 |
| `next_run_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()`. Later than now while the job waits for its next run | FR-012, FR-021 |
| `started_at` | `TIMESTAMPTZ` | set by the first claim, never changed after | FR-011 |
| `deadline_at` | `TIMESTAMPTZ` | set by the first claim to `started_at + time_limit_ms` | FR-022 |
| `finished_at` | `TIMESTAMPTZ` | set exactly when the state becomes final | FR-011 |
| `run` | `INTEGER` | `NOT NULL DEFAULT 0`, `CHECK (run BETWEEN 0 AND max_runs)`. Runs that count: lost runs included, a graceful hand-back given back (research #4, #6) | FR-021 |
| `claim` | `BIGINT` | `NOT NULL DEFAULT 0`. Every claim adds one; it never goes down. The fencing number of every worker write | FR-005 |
| `max_runs` | `SMALLINT` | `NOT NULL`, `CHECK (max_runs BETWEEN 1 AND 5)`, from `JOB_MAX_RUNS` when queued | FR-021 |
| `time_limit_ms` | `INTEGER` | `NOT NULL`, `CHECK (time_limit_ms > 0)`, from `JOB_TIME_LIMIT` when queued | FR-022 |
| `token_cap` | `BIGINT` | `NOT NULL`, `CHECK (token_cap > 0)`, from `JOB_TOKEN_CAP` when queued | FR-040, FR-045 |
| `cost_cap_usd` | `NUMERIC(12,6)` | `NOT NULL`, `CHECK (cost_cap_usd > 0)`, from `JOB_COST_CAP` when queued | FR-040, FR-045 |
| `worker_id` | `UUID` | the worker holding the job while `running`; no foreign key, because `workers` rows are deleted | FR-005 |
| `lease_expires_at` | `TIMESTAMPTZ` | while `running`; renewed by the heartbeat | FR-007 |
| `cancel_requested_at` | `TIMESTAMPTZ` | set by a cancel of a running job | FR-030 |
| `cancelled_by` | `INTEGER` | references `users (id) ON DELETE RESTRICT`; set by any cancel | FR-011, US3 |
| `progress` | `JSONB` | `{ "step": <kind's step>, "done"?: int, "total"?: int }`, or null before the first step | FR-015 |
| `failure_category` | `TEXT` | set only when `state = 'failed'`, one of the categories below | FR-011, FR-064 |
| `failure_detail` | `TEXT` | null, or `cap_below_one_request` when `failure_category = 'cap_reached'` and the worst case of one request alone passed a cap. Chooses the message shown | FR-044 |
| `result` | `JSONB` | the kind's result, written in the same fenced update that ends the run. For `provider_check`, see below | FR-091 |

**Checks**:

- `state = 'running'` ⇔ `worker_id` and `lease_expires_at` are set.
- `state IN ('succeeded','failed','cancelled')` ⇔ `finished_at` is set.
- `failure_category` is set ⇔ `state = 'failed'`.
- `cancelled_by` is set ⇒ `state = 'cancelled'` or (`state = 'running'` and `cancel_requested_at` is set).
- `state = 'queued'` ⇒ `run < max_runs`.
- Every write that ends a run turns into `cancelled` when `cancel_requested_at` is set (research #4), so no ending can
  break the rule above.
- `started_at` and `deadline_at` are both set or both null.

**Trigger** `jobs_final_is_final` (`BEFORE UPDATE`): refuses any update of a row whose old state is final (FR-012).
Neither the API nor a stale worker can move a finished job.

**Indexes**:

- `jobs_claim_idx` on `(next_run_at, queued_at, id) WHERE state = 'queued'`, for the claim.
- `jobs_lease_idx` on `(lease_expires_at) WHERE state = 'running'`, for the sweep.
- `jobs_list_idx` on `(queued_at DESC, id DESC)`, for the list.
- `jobs_account_idx` on `(created_by, kind, queued_at DESC)`, for the cooldown and the per-account limit.

### Failure categories

Milestone 1's eleven (`not_configured`, `not_authorized`, `not_available`, `rate_limited`, `provider_unavailable`,
`input_too_large`, `output_limit_reached`, `refused`, `rejected`, `invalid_output`, `cancelled`), except that
`cancelled` never appears here, because a cancel ends the job in the `cancelled` state, plus four of the job's own:

| Category | When | Runs again? |
|---|---|---|
| `cap_reached` | a request's worst case does not fit the caps (FR-042, FR-044) | no |
| `timed_out` | the deadline passed (FR-022) | no |
| `worker_lost` | the last allowed run was lost with its worker (FR-007) | no (it was the last) |
| `job_error` | an error in the job's own work that is no provider failure | no |

`provider_unavailable` and `rate_limited` end a run, not the job, while runs remain (FR-020). A request that the
layer reports as `cancelled` because the deadline aborted it is recorded as `timed_out`.

### `provider_check` result

```json
{
  "generation": { "status": "ok" | "not_configured" | "<failure category>",
                  "provider": "anthropic", "model": "claude-sonnet-5-5", "hosted": true,
                  "usage_id": 123 },
  "embeddings": { "status": "not_configured" }
}
```

`provider`, `model` and `hosted` are absent when the operation is not configured. `usage_id` points at the operation's
`job_usage` row when a request was made. No key and no base address (FR-091). The message and hint are not stored:
the API adds them from `failures.yaml` when it reads the job, so a corrected hint applies to old jobs too.

## Table `job_usage`

One row per model request a job made: Milestone 1's usage record (FR-050). Deleted only with its job.

| Column | Type | Rules |
|---|---|---|
| `id` | `BIGINT` | `GENERATED ALWAYS AS IDENTITY` primary key |
| `job_id` | `UUID` | `NOT NULL`, references `jobs (id) ON DELETE CASCADE` |
| `run` | `INTEGER` | `NOT NULL`, the run that made the request |
| `operation` | `TEXT` | `generate` or `embed` |
| `provider` | `TEXT` | one of Milestone 1's four provider names |
| `model` | `TEXT` | `NOT NULL`, the configured model id |
| `outcome` | `TEXT` | `ok` or one of Milestone 1's categories |
| `attempts` | `SMALLINT` | `CHECK (attempts BETWEEN 0 AND 5)` |
| `input_tokens`, `output_tokens` | `INTEGER` | `NOT NULL`, `>= 0` |
| `tokens_estimated` | `BOOLEAN` | `NOT NULL` |
| `cost_usd` | `NUMERIC(14,8)` | null means unknown, never 0 for an unknown price (M1 FR-033) |
| `cost_estimated` | `BOOLEAN` | `NOT NULL` |
| `price_source` | `TEXT` | `operator`, `list` or `none`; `none` ⇔ `cost_usd IS NULL` |
| `temperature_applied` | `BOOLEAN` | null for `embed` |
| `duration_ms` | `INTEGER` | `NOT NULL`, `>= 0` |
| `recorded_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |

Index `job_usage_job_idx` on `(job_id, id)`. Rows are written without fencing (research #4): a request that was made
counts against its job's caps whichever worker records it.

## Table `workers`

One row per running worker process (spec Key Entities: Worker), for FR-008.

| Column | Type | Rules |
|---|---|---|
| `id` | `UUID` | primary key, chosen by the worker when it starts |
| `started_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
| `last_seen_at` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()`, updated every 10 s |
| `stopping` | `BOOLEAN` | `NOT NULL DEFAULT false` |

A worker is **alive** if `last_seen_at > now() - interval '30 seconds'` and it is not stopping. No host name, address
or process id is stored. A worker deletes its own row when it stops, and rows not seen for 24 hours when it starts.

## State transitions

```text
              claim                     ok
  queued ───────────────▶ running ─────────────▶ succeeded
    ▲  │                   │  │  │
    │  │ cancel            │  │  └─ non-transient failure, cap, deadline ─▶ failed
    │  ▼                   │  │
    │ cancelled ◀── cancel noticed at heartbeat, or lease expired with cancel asked
    │                      │
    └── transient failure or lost run, runs remain (next_run_at = now() + backoff)
        graceful hand-back on stop (next_run_at = now())
```

| From | To | By | Condition |
|---|---|---|---|
| (none) | `queued` | API `POST /jobs` | kind offered, AI configured for a model kind, account under its limit and cooldown |
| `queued` | `running` | worker claim | `next_run_at <= now()`; oldest first; `run` and `claim` each go up by one |
| `queued` | `cancelled` | API cancel | at once |
| `queued` | `failed` (`timed_out`) | sweep | waiting for a next run and `deadline_at` passed |
| `running` | `succeeded` | worker, fenced | the kind's work ended well and no cancel was asked |
| `running` | `failed` | worker, fenced | a non-transient category, `cap_reached`, `timed_out`, `job_error`, or a transient one on the last run |
| `running` | `queued` | worker, fenced | a transient category and `run < max_runs`; `next_run_at` = now + backoff (research #6) |
| `running` | `queued` | worker, fenced | handed back on stop; `next_run_at` = now; `run` goes down by one |
| `running` | `cancelled` | worker, fenced | `cancel_requested_at` seen at a heartbeat or at the gate before a request, or set when any ending is written |
| `running` | `cancelled` | API cancel | the lease has already expired |
| `running` (lease expired) | `queued` / `failed` / `cancelled` | sweep | as research #4 |

## Records the API returns

zod schemas in `packages/core/src/schemas/job.ts`, shared by the API (responses are parsed with them) and the web app.
[contracts/http-api.md](./contracts/http-api.md) has the exact fields.

- **`JobRecord`**: `id`, `kind`, `state`, `started_by` (`{ id, username }`), `cancelled_by` (or null),
  `cancel_requested`, `worker_lost` (`state = 'running'` and `lease_expires_at < now()`, computed on read, FR-062),
  `queued_at`, `started_at`, `finished_at`, `next_run_at` (when waiting for a next run), `run`,
  `max_runs`, `deadline_at`, `caps` (`{ tokens, cost_usd }`), `progress`, `failure` (`{ category, message, hint }` or
  null), `totals`.
- **`JobTotals`**: summed from `job_usage` on read: `requests`, `input_tokens`, `output_tokens`, `tokens_estimated`
  (any), `cost_usd` (null if any request's cost is unknown), `cost_known_usd` (the sum of the known costs),
  `cost_estimated` (any), `cost_cap_applied` (false if any request's price was unknown), `duration_ms`.
- **`JobDetail`**: a `JobRecord` plus `usage` (its `job_usage` rows, oldest first) and `result` (for
  `provider_check`, each operation with its `message` and `hint` added).
- **`JobsStatus`**: `worker_alive`, `ai` (Milestone 1's `LlmStatus`: provider, model and hosted per operation, no key
  and no address), `provider_check` (`{ offered, next_allowed_at }` for the signed-in account).
