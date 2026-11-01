# Phase 3 Milestone 2: the worker and its jobs

A worker (a second entry point of `apps/api`, same image, `node dist/worker.js`) runs jobs from a Postgres `jobs` table. The first job kind is a provider check that any signed-in account starts from the new **Jobs** page. Jobs show progress, can be cancelled, run again after failures that may pass, survive worker crashes and stops, and carry token and cost caps checked before every request. Only the worker holds a provider key and talks to a provider.

## Security implications (Development Workflow: configuration/secrets, new routes)

- Five authenticated routes under `/api/v1` (`GET /jobs/status`, `GET /jobs`, `POST /jobs`, `GET /jobs/{id}`, `POST /jobs/{id}/cancel`). A request cannot set caps, runs or time limit.
- **Broadening (FR-065):** any signed-in account can see and cancel every job and start a provider check, which spends on the provider. Bounded by the caps, `JOBS_PER_ACCOUNT` and `PROVIDER_CHECK_COOLDOWN`; open until Phase 6 (many accounts).
- Provider keys go to the worker only. The API now starts without them (**changes Milestone 1's rule for the API only**). A key kept in the shared `DB_SECRET_ID` secret still reaches the API; accepted and documented.
- Constitution **1.15.0**; `docs/threat-model/` rebuilt by its procedure (49 elements, 310 threats), marked **approved** by the maintainer on 2026-11-01 for the Milestone 2 additions (the worker, job records, four flows, 34 rule-derived threats and five model-level threats).

## Decisions to review

- **Own `jobs` table instead of pg-boss**, and **the worker inside `apps/api` instead of `apps/worker`** (maintainer decisions at planning). `plan.md` and Principle III's layout list changed with them. `docs/roadmap.md` needed no change.
- Planning-time spec changes: FR-042 counts billable calls only; SC-008's 10 s bound holds while a worker runs; changed caps apply to jobs queued after the API restarts.
- Implementation deviations: the cost cap is checked against the known part of the cost when only some prices are known; `worstCase` has no `texts` argument and `requestSize` adds an 8,000-character retry allowance; the 429 message pluralises ("1 job"); `ProviderCheckStatus` adds `not_run`; migration adds `jobs_cancel_requested_check`; the key-format check mentioned in tasks T006/T057 does not exist (tests use "key set for Bedrock" instead).
- `docker-compose.release.yml`'s `worker` needs the next release's image; the release checklist's version bump supplies it. README still says "one container" (accurate for the linked v0.1.0 quickstart).
- The eval gate does not apply: no prompt or adapter changed.

## Verification

Typecheck, lint (license check), build, `pnpm test` (1540 API, 725 web, 632 llm, 408 core, 286 db, 275 scripts), `pnpm test:e2e` (62) and `docker build .` all pass with exit 0. The global teardown now deletes job-owning test accounts (found and fixed during verification).

Real-container runs (isolated compose project, stand-in provider): job ran once and succeeded; account limit refused the 4th start (429); worker SIGKILLed mid-request showed "worker lost", was requeued by a restarted worker and succeeded as run 2; with Anthropic selected the app started without a key, the key existed only in the worker, and the check inside the app reported the missing key (exit 2).

A final convergence pass found three small gaps, fixed before this PR (T082 to T084): a cancelled provider-check operation reads "Cancelled" with its own hint instead of "Failed"; the worker starts its health server before it registers or claims a job; the Jobs page shows the no-worker notice for a job whose worker was lost even while another worker is alive. After them, typecheck, lint and the full API and web suites pass (the e2e suite and `docker build .` were last run before these three changes).

## Live runs (T080)

- **2026-11-01, local Ollama, `llama3.2` (generation) and `nomic-embed-text` (embeddings), declared local, two workers** (`--scale worker=2`): four provider checks from the API all succeeded on run 1 (claim 1), 89 tokens in and 7 out each, cost unknown (local, unpriced), 0.2 to 0.9 s, each run exactly once, both workers healthy.
- **2026-11-01, hosted Gemini, `gemini-3.6-flash`, embeddings off, the key given to the `worker` service only** (exported in the maintainer's shell, never written to a file; `PROVIDER_CHECK_COOLDOWN=0`): the check started from the Jobs page ran once and succeeded on run 1 (queued 11:44:21, started 11:44:22, finished 11:44:25 local time); the page showed "Hosted: data sent to it leaves this install", 47 tokens in and 167 out, cost $0.000662 from the price list, request time 2.9 s. `docker compose exec app env | grep LLM_API_KEY` printed nothing (the app holds no key). The operator's check run in the worker (`node dist/llm-check.js`) reported OK in 1.6 s, 47 in and 102 out, $0.000418 (price list).
- **2026-11-01, hosted Gemini, `gemini-3.6-flash`, `JOB_COST_CAP=0.0001` on the app:** a new check from the Jobs page ended **Failed** at once (queued 11:58:07, started and finished 11:58:08 local time, run 1 of 3), with caps shown as "Up to 500000 tokens and $0.0001", the message "The job's cap is lower than one request to this model needs, so nothing was sent", the reason "cap reached", and generation and embeddings both "Not run: the job stopped before this step". The job page lists no request and no usage. (The provider's own console was not checked.)
