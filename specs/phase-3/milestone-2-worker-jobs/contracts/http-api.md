# Contract: HTTP API

Five operations under `/api/v1`, added to the operation table (`apps/api/src/v1/jobs.ts`), so the router mounts them
and `openapi.json` documents them from one definition (FR-060). All need a signed-in account (a v1 token), parse their
input with the shared zod schemas in `packages/core/src/schemas/job.ts`, parse every success body with its record
schema before sending it, and answer errors as `{ "error": "<fixed text>" }`. No answer holds a key, a base address, a
prompt, an answer or a raw provider error (FR-051, SC-007).

Any signed-in account may use all five on every job (FR-065).

## `GET /api/v1/jobs/status`

What the Jobs page needs besides the list.

`200`:

```json
{
  "worker_alive": true,
  "ai": {
    "generation": { "provider": "openai-compatible", "model": "llama3.2", "hosted": false },
    "embedding": null
  },
  "provider_check": { "offered": true, "next_allowed_at": null }
}
```

- `worker_alive`: a worker reported within the last 30 s and is not stopping (FR-008).
- `ai`: Milestone 1's `LlmStatus` from the API's own settings: provider, model and hosted per operation, never a key
  or an address (M1 FR-045).
- `provider_check.offered`: false when neither generation nor embeddings is configured (FR-063).
- `provider_check.next_allowed_at`: when the signed-in account may start its next check, or null if it may now
  (FR-047).

## `GET /api/v1/jobs?limit=&offset=`

Every job, newest first by `queued_at`, ties broken by `id` descending. `limit` 1 to 100 (default 25), `offset` ≥ 0
(default 0). `200`: `{ "jobs": JobRecord[], "has_more": boolean }`. Errors: `400` for a bad query.

## `POST /api/v1/jobs`

Body: `{ "kind": "provider_check", "input": {} }` (FR-013, FR-093). The kind must be one the UI offers; the input must
match the kind's schema (for `provider_check`, the empty object).

`201`: the new `JobRecord`, in state `queued` (US1 scenario 1). One log line:
`{"event":"job","action":"start","account_id":7,"job_id":"…","kind":"provider_check"}`.

The checks, in this order, inside one transaction holding a transaction-scoped advisory lock on the account
(research #12):

| Answer | When | `error` |
|---|---|---|
| `400` | body not valid, unknown kind, input does not match | the validation message, as other v1 routes |
| `409` | a model-calling kind while no provider is configured | `AI is not configured on this install` |
| `429` + `Retry-After` | the account already has `JOBS_PER_ACCOUNT` jobs queued or running | `You already have 3 jobs queued or running. Wait for one to finish, or cancel one.` |
| `429` + `Retry-After` | a provider check inside the cooldown | `You can start the next provider check in 4 minutes` |

The numbers in the two `429` messages come from the settings and the database, never from the request. `Retry-After`
is in whole seconds: the cooldown's remaining time, or 30 for the per-account limit.

## `GET /api/v1/jobs/:id`

`200`: a `JobDetail`. `404` `Job not found`. `400` `Invalid id`.

## `POST /api/v1/jobs/:id/cancel`

No body. `200`: the `JobRecord` after the cancel. One log line:
`{"event":"job","action":"cancel","account_id":7,"job_id":"…"}`.

| State | Effect |
|---|---|
| `queued` | `cancelled` at once, `cancelled_by` and `finished_at` set (FR-030) |
| `running`, lease live | `cancel_requested_at` and `cancelled_by` set; the worker ends it within 10 s; the record shows `cancel_requested: true` |
| `running`, lease expired (`worker_lost: true`) | `cancelled` at once (its worker is gone) |
| final | `409` `The job has already finished`, nothing changes (FR-032) |

`404` and `400` as above. A second cancel of a running job with a cancel already asked answers `200` and changes
nothing.

## Records

```text
JobRecord {
  id: uuid
  kind: "provider_check"
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled"
  started_by: { id: int, username: string }
  cancelled_by: { id: int, username: string } | null
  cancel_requested: boolean
  worker_lost: boolean            // state running and lease_expires_at < now(), computed on read (FR-062)
  queued_at, started_at|null, finished_at|null, next_run_at|null, deadline_at|null: ISO 8601
  run: int, max_runs: int
  caps: { tokens: int, cost_usd: number }
  progress: { step: "generation" | "embeddings", done?: int, total?: int } | null
  failure: { category: string, message: string, hint: string } | null
  totals: JobTotals
}

JobTotals {
  requests: int, input_tokens: int, output_tokens: int, tokens_estimated: boolean,
  cost_usd: number | null, cost_known_usd: number, cost_estimated: boolean, cost_cap_applied: boolean,
  duration_ms: int
}

JobDetail = JobRecord & {
  usage: UsageRecord[]            // oldest first; Milestone 1's record plus id, run, recorded_at
  result: ProviderCheckResult | null
}

ProviderCheckResult {
  generation, embeddings: {
    status: "ok" | "not_configured" | <failure category>,
    provider?, model?, hosted?,
    message?, hint?,              // for a failure, from failures.yaml
    usage_id?: int
  }
}
```

`next_run_at` is null unless the job is `queued` and waiting for a next run. `started_by.username` and
`cancelled_by.username` are account names, already shown elsewhere in the UI.

## OpenAPI

`openapi.json` is regenerated (`pnpm --filter @scrylux/api openapi`) and committed. `429` is added to the document's
status descriptions ("Too many jobs, or too soon after the last provider check"). The contract test checks that the
document describes exactly these five operations' answers.
