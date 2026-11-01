# Quickstart: Worker and Jobs

How to show that the milestone works. §1 runs in CI with no provider and no secret (FR-082). §2 to §4 are run by hand
before the milestone closes.

## 1. Automated suites

From the repository root, with the test database running (`docker compose up -d db`):

```sh
pnpm typecheck && pnpm lint
pnpm test                 # all packages, including the db, jobs and worker suites
pnpm build && pnpm test:e2e
```

| What | Where | Spec |
|---|---|---|
| Migration 016, checks, the final-state trigger, Kysely types | `packages/db/test/jobs-schema.test.ts`, `schema-types.test.ts` | FR-003, FR-012 |
| `parseLlmStatus` agrees with `parseLlmConfig` apart from keys; `worstCase` and `requestSize` | `packages/llm/test/` | FR-071, FR-042 |
| Job settings: defaults, every refusal names the variable and not the value | `apps/api/test/jobs/config.test.ts` | FR-004, FR-040, SC-009 |
| Storage: claim order, two claimers × 100 jobs, fencing, the sweep, cancel in each state, limit and cooldown under concurrent starts, totals | `apps/api/test/jobs/store.test.ts` | FR-005, FR-007, FR-016, FR-030–FR-032, FR-046, FR-047, SC-005, SC-006, SC-011 |
| The worker against stub providers: success, transient retry, no retry, caps (token, cost, unknown price, below one request), cancel within 10 s, deadline, lost run, graceful stop, health check | `apps/api/test/worker/` | US1–US4, FR-020–FR-022, FR-040–FR-044, SC-003, SC-004, SC-008 |
| Canary: a fake key and fake content in no log, row or answer | `apps/api/test/worker/canary.test.ts` | FR-051, SC-007 |
| Start-up: worker refusals; API starts without keys; the worker imports no Express | `apps/api/test/worker/startup.test.ts`, `apps/api/test/llm/` | FR-004, FR-071 |
| Routes, errors, `openapi.json` | `apps/api/test/contract/jobs.test.ts` | FR-060 |
| `failures.yaml` rules; check command output unchanged | `apps/api/test/jobs/failures.test.ts`, `apps/api/test/llm/` | FR-064 |
| Jobs page and job page | `apps/web/src/pages/Jobs*.test.tsx` | FR-061–FR-063, FR-066 |
| End to end in the built app, with its own API, worker and stub provider | `apps/web/e2e/jobs.spec.ts` | SC-002, US6 |
| The rest of the browser suite, unchanged, with no provider and no worker | `apps/web/e2e/` | FR-072, SC-001 |
| The threat model's checks | `apps/api/test/dogfood/` | FR-080, SC-010 |

## 2. With compose and a local model

```sh
# Ollama on the host, with a small model pulled: ollama pull llama3.2
export LLM_PROVIDER=openai-compatible LLM_MODEL=llama3.2 LLM_LOCAL=true \
       LLM_BASE_URL=http://host.docker.internal:11434/v1
docker compose up --build
```

1. Sign in, open **Jobs**. The status says generation is local, embeddings not configured. **Check AI provider** is
   offered.
2. Start a check. It shows queued, then running with "Checking generation", then succeeded, without a reload (SC-002).
   The job page shows the result, the usage, and cost "unknown" unless a price is set.
3. Start another at once: refused, with the time of the next allowed check (FR-047).
4. `docker compose stop worker`, start a check (after the cooldown, or with `PROVIDER_CHECK_COOLDOWN=0`): it stays
   queued and the page says no worker is processing jobs within 30 s (FR-062). Cancel it: it ends as cancelled.
   `docker compose start worker`: the cancelled job never runs (US3).
5. Stop Ollama, start a check: it fails a run as provider unavailable, waits, runs again, and ends failed after 3 runs
   (FR-020, FR-021). Restart Ollama.
6. `docker compose exec worker node dist/llm-check.js` prints the same report as in Milestone 1.

## 3. With a hosted provider

Repeat §2 steps 1, 2 and 6 with `LLM_PROVIDER=anthropic`, `LLM_MODEL=claude-haiku-5-5` and `LLM_API_KEY` set for the
`worker` service only. The status says hosted. The job shows a cost from the price list. The app still starts
without the key (FR-071), and `docker compose exec app node dist/llm-check.js` refuses with `LLM_API_KEY must be set
when LLM_PROVIDER is anthropic`, which shows that the app holds no key. Set `JOB_COST_CAP=0.0001` for
the app and restart it: a new check ends as "cap reached" with the "lower than one request" message, and nothing was
sent (the provider's console shows no request) (FR-044).

## 4. Crash and scale

1. `docker compose up --scale worker=2`, start checks from three accounts: each runs once (FR-005).
2. With a slow model, start a check and `docker compose kill worker` (one of them) while it runs: within about 30 s
   the job runs again on the other worker, with its run count up by one (FR-007).
3. `docker compose stop worker` during a run: the log shows the job handed back, and it finishes on the next worker.
