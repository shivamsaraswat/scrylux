# Contract: The Worker Process

What an operator, a container platform and the tests can rely on (research #2, #9, #10).

## Command

```sh
node dist/worker.js                         # in the published image (WORKDIR /app/apps/api)
pnpm --filter @scrylux/api worker           # from source (tsx, @scrylux/source condition)
```

The same image as the app, with a different command (FR-001). The worker's entry point imports neither Express nor
any route module; a test holds it to that.

## Start, in order

1. `config.load()`: environment, then the `DB_SECRET_ID` secret if set. On failure it prints the fixed line
   `Startup failed: could not read the secrets-manager secret named by DB_SECRET_ID` and exits 1.
2. The provider configuration, with Milestone 1's `parseLlmConfig`, keys required (FR-004). On failure:
   `Startup failed: invalid AI provider configuration: <message naming the variable>`, exit 1. No provider is
   contacted (M1 FR-007). With no provider configured it starts, and logs `AI providers: generation off, embeddings off`.
3. `parseJobConfig` ([configuration.md](./configuration.md)). On failure: `Startup failed: <message>`, exit 1.
4. `migrate()` under the shared advisory lock, retried while the database starts, as the API does (research #9).
5. Delete `workers` rows not seen for 24 hours, insert its own row, start the health server, start the loop. Log one
   line: `{"event":"worker","action":"start","worker_id":"…","concurrency":1}`.

## Health check

`GET http://<host>:${WORKER_HEALTH_PORT}/health`:

`200 {"status":"ok"}` whenever the process is up: from step 5 of the start until it exits, stopping included. It says
only that the process is alive, as Principle IV requires of `/health` (research #10). No authentication, no database,
no provider (FR-010). Any other path or method: `404`. The compose files run:

```sh
node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
```

## Stop

On `SIGTERM` or `SIGINT`: mark its `workers` row stopping, claim nothing more, let running
jobs go on for up to 30 s, then abort each and hand it back (`queued`, `next_run_at = now()`, its run given back, or `cancelled` if a cancel was asked; one fenced update), delete
its `workers` row, log `{"event":"worker","action":"stop","worker_id":"…","handed_back":0}` and exit 0 (FR-007). A
second signal exits at once; its jobs come back through the lease (≤ 30 s).

## Log lines (stdout only, one JSON object per line, FR-009)

| Event | Fields |
|---|---|
| worker start / stop | `event: "worker"`, `action`, `worker_id`, `concurrency` or `handed_back` |
| job state change | `event: "job"`, `job_id`, `kind`, `state` (`running`, `queued`, `succeeded`, `failed`, `cancelled`), `run`, `failure_category` (if failed), `input_tokens`, `output_tokens`, `cost_usd` (number or null) |
| each model request | Milestone 1's line, unchanged (M1 FR-034) |

No line holds content, a prompt, an answer, a key, a base address or a model's error text. The model id appears only
in Milestone 1's line, as it does today.

## Exit status

`0` after a clean stop. `1` for a start-up failure or an unexpected error, with a fixed line and no error detail, like
the API's catch-all.

## The operator's check command

`node dist/llm-check.js` is unchanged in what it does and prints, but it now shares `apps/api/src/provider-check.ts`
with the job and reads its hints from `apps/api/data/failures.yaml` (research #8, #12). Because the documented setup
gives the keys to the worker only, operators run it in the worker's container:
`docker compose exec worker node dist/llm-check.js`.
