# Contract: Configuration

Eight new environment variables (research #11). Each goes in the environment-variable table of `docs/install.md`
(FR-081, Principle IV). Both the API and the worker parse all eight at start with `parseJobConfig`
(`apps/api/src/jobs/config.ts`). An unset or empty variable takes its default. Any other bad value stops the process
with `Startup failed: <message>`, where the message names the variable and the rule and never repeats the value
(FR-004, FR-040, SC-009).

| Variable | Default | Accepted | Read for | Spec |
|---|---|---|---|---|
| `JOB_TOKEN_CAP` | `500000` | a whole number from 1 to 1,000,000,000 | copied onto each job when queued | FR-040 |
| `JOB_COST_CAP` | `5` | US dollars: a positive number with up to 6 decimals, at most 10,000 | copied onto each job when queued | FR-040 |
| `JOB_MAX_RUNS` | `3` | a whole number from 1 to 5 | copied onto each job when queued | FR-021 |
| `JOB_TIME_LIMIT` | `60m` | a whole number and `s`, `m` or `h`, from `1m` to `24h` | copied onto each job when queued | FR-022 |
| `JOBS_PER_ACCOUNT` | `3` | a whole number from 1 to 100 | refusing a start beyond it | FR-046 |
| `PROVIDER_CHECK_COOLDOWN` | `5m` | `0` (off), or a whole number and `s`, `m` or `h`, up to `24h` | refusing a provider check inside it | FR-047 |
| `WORKER_CONCURRENCY` | `1` | a whole number from 1 to 32 | the worker: jobs run at once | FR-006 |
| `WORKER_HEALTH_PORT` | `3001` | a whole number from 1 to 65535 | the worker: its `/health` port | FR-010 |

Zero, a negative number, a fraction where a whole number is needed, or a unit outside the list is refused. A cap is
never zero (FR-040). Only the cooldown accepts `0`, to turn it off.

## Changed: the API's provider settings (FR-071)

The API's start-up check uses `parseLlmStatus` ([library-api.md](./library-api.md)), so the API starts with
`LLM_PROVIDER` and `LLM_MODEL` set and no `LLM_API_KEY`. It still reports configured and hosted or local, and a key
that is set is still checked. Every other Milestone 1 rule applies to the API unchanged, the refusal of a vendor
variable included. The worker applies Milestone 1's rules in full, keys required.

## Which process gets what (documented, and in both compose files)

| Setting | API (`app`) | Worker (`worker`) |
|---|---|---|
| `DB_*`, `DB_SECRET_ID` | yes | yes |
| `JWT_SECRET`, `ADMIN_*`, session and sign-in settings, `TRUST_PROXY`, `PORT` | yes | no |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL`, `LLM_LOCAL`, `LLM_REGION`, and the `EMBEDDING_` equivalents | yes, for the status the UI shows | yes |
| `LLM_API_KEY`, `EMBEDDING_API_KEY` | **no** | yes |
| `LLM_TIMEOUT`, `LLM_PRICE_*`, `EMBEDDING_PRICE_INPUT` | yes (validated, as today) | yes (used for costs and caps) |
| `JOB_*`, `JOBS_PER_ACCOUNT`, `PROVIDER_CHECK_COOLDOWN` | yes (used) | yes (validated) |
| `WORKER_CONCURRENCY`, `WORKER_HEALTH_PORT` | yes (validated) | yes (used) |

A key kept in the `DB_SECRET_ID` secret reaches both processes, because both read the secret for the database
credentials. To keep keys from the API, set them in the worker's environment instead (research #11).

The settings that decide what a job does are the worker's (spec edge case "The configuration differs between
processes"). The caps, runs and time limit are the API's, copied onto the job when it is queued, so a change applies to
jobs queued after the API restarts with it.
