# Contract: `apps/api/data/failures.yaml`

The message and hint for every failure category a job can show, and the hints the operator's check command prints
(FR-064, Principle IV). One file, read by the API (to add messages and hints to job records) and by `llm-check.ts`. The worker
stores only the category. It replaces the `switch` in `llm-check.ts`. The image copies it to `/app/apps/api/data/`.

```yaml
# Messages and hints for job failures (FR-064). Fixed text only: no value from a request, a provider or a setting
# except the settings' names. {prefix} becomes LLM or EMBEDDING, for the operation that failed.
provider:                       # Milestone 1's categories: the message is FAILURE_MESSAGES[category]; only the hint is here
  not_authorized: "Check {prefix}_API_KEY, and that the key may use this model. For Bedrock, check the role's permissions."
  not_available: "Check {prefix}_MODEL. …"
  # … one entry for each of Milestone 1's eleven categories, as llm-check.ts has them today
job:                            # the job's own categories: message and hint
  cap_reached:
    message: "The job stopped before a request that could have taken it past its token or cost cap."
    hint: "An operator can raise JOB_TOKEN_CAP or JOB_COST_CAP. A model with high prices may need a higher JOB_COST_CAP."
  cap_below_one_request:
    message: "The job's cap is lower than one request to this model needs, so nothing was sent."
    hint: "An operator can raise JOB_TOKEN_CAP or JOB_COST_CAP, or choose a model with lower prices."
  timed_out:
    message: "The job ran out of time."
    hint: "An operator can raise JOB_TIME_LIMIT. A slow local model may need a larger LLM_TIMEOUT too."
  worker_lost:
    message: "The worker running the job stopped, and the job had no runs left."
    hint: "Check the worker's logs and restart it. Start the job again."
  job_error:
    message: "The job failed because of an error in Scrylux."
    hint: "Check the worker's logs, and report it if it happens again."
```

`cap_below_one_request` is shown for a `cap_reached` job whose cap was lower than one request (FR-044); the category
stored is still `cap_reached`.

**Rules, held by a test**:

- Parsed strictly (unknown keys refused), like Milestone 1's data files.
- Every one of Milestone 1's eleven categories has a hint, and every job category has a message and a hint. No other
  key.
- The only placeholder is `{prefix}`. No text names a value, a URL other than documentation, or a provider's error.
- The hints the check command printed in Milestone 1 move here unchanged, so its output does not change (its existing
  tests keep passing).
