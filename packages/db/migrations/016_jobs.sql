-- Background jobs (Phase 3 / Milestone 2, specs/phase-3/milestone-2-worker-jobs/data-model.md).
--
-- jobs is the queue and the permanent record in one table (research #1, #3): a worker claims a queued row with
-- FOR UPDATE SKIP LOCKED, holds it on a lease it renews, and every write it makes is fenced by `claim`, a counter that
-- only goes up, so a worker that lost its lease cannot write after another has taken the job over. job_usage holds
-- Milestone 1's usage record of every model request a job made, and a job's totals are summed from it when read, never
-- stored, so they always equal their records. workers lists the worker processes so the UI can say when none is alive.
--
-- Every time is the database's now(): workers on hosts whose clocks disagree still agree on leases and deadlines.
-- The failure categories are Milestone 1's, without `cancelled` (a cancel ends the job in the `cancelled` state), and
-- the job's own four. No row holds a prompt, an answer, a key or a base address (FR-051).

CREATE TABLE jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                TEXT NOT NULL,
  -- Identifiers only, never content (FR-051). Checked against the kind's schema before it is inserted.
  input               JSONB NOT NULL DEFAULT '{}',
  state               TEXT NOT NULL DEFAULT 'queued',
  created_by          INTEGER NOT NULL,
  queued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Later than now() while the job waits for its next run (FR-012, FR-021).
  next_run_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  deadline_at         TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  -- Runs that count against max_runs: a lost run counts, a run handed back by a stopping worker does not (research #6).
  run                 INTEGER NOT NULL DEFAULT 0,
  -- Every claim adds one and it never goes down: the fencing number of every worker write (research #4).
  claim               BIGINT NOT NULL DEFAULT 0,
  -- Copied from the operator's settings when the API queues the job (FR-040, FR-045).
  max_runs            SMALLINT NOT NULL,
  time_limit_ms       INTEGER NOT NULL,
  token_cap           BIGINT NOT NULL,
  cost_cap_usd        NUMERIC(12, 6) NOT NULL,
  worker_id           UUID,
  lease_expires_at    TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  cancelled_by        INTEGER,
  progress            JSONB,
  failure_category    TEXT,
  -- cap_below_one_request chooses the message of a cap_reached failure (FR-044).
  failure_detail      TEXT,
  result              JSONB,
  CONSTRAINT jobs_kind_check CHECK (kind IN ('provider_check')),
  CONSTRAINT jobs_state_check CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT jobs_input_check CHECK (jsonb_typeof(input) = 'object'),
  CONSTRAINT jobs_max_runs_check CHECK (max_runs BETWEEN 1 AND 5),
  CONSTRAINT jobs_time_limit_check CHECK (time_limit_ms > 0),
  CONSTRAINT jobs_token_cap_check CHECK (token_cap > 0),
  CONSTRAINT jobs_cost_cap_check CHECK (cost_cap_usd > 0),
  CONSTRAINT jobs_run_check CHECK (run BETWEEN 0 AND max_runs),
  -- A queued job always has a run left: a transient failure on the last run fails the job instead of queueing it.
  CONSTRAINT jobs_queued_runs_check CHECK (state <> 'queued' OR run < max_runs),
  CONSTRAINT jobs_running_check CHECK (
    (state = 'running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'running' AND worker_id IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT jobs_finished_check CHECK ((state IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CONSTRAINT jobs_started_deadline_check CHECK ((started_at IS NULL) = (deadline_at IS NULL)),
  CONSTRAINT jobs_failure_check CHECK ((state = 'failed') = (failure_category IS NOT NULL)),
  CONSTRAINT jobs_failure_category_check CHECK (
    failure_category IS NULL OR failure_category IN (
      'not_configured', 'not_authorized', 'not_available', 'rate_limited', 'provider_unavailable',
      'input_too_large', 'output_limit_reached', 'refused', 'rejected', 'invalid_output',
      'cap_reached', 'timed_out', 'worker_lost', 'job_error'
    )
  ),
  CONSTRAINT jobs_failure_detail_check CHECK (
    failure_detail IS NULL OR (failure_detail = 'cap_below_one_request' AND failure_category = 'cap_reached')
  ),
  -- A cancel wins over every way a run can end (research #4), so a cancel asked is never left on a job that goes on to
  -- succeed, fail or be queued again.
  CONSTRAINT jobs_cancel_requested_check CHECK (cancel_requested_at IS NULL OR state IN ('running', 'cancelled')),
  CONSTRAINT jobs_cancelled_by_check CHECK (
    cancelled_by IS NULL OR state = 'cancelled' OR (state = 'running' AND cancel_requested_at IS NOT NULL)
  ),
  -- RESTRICT: an account that started or cancelled a job cannot be deleted from under it, as for projects.
  CONSTRAINT jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT jobs_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES users (id) ON DELETE RESTRICT
);

-- A job that has ended never changes again (FR-012): neither the API nor a worker that lost its lease can move it.
CREATE FUNCTION jobs_final_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('succeeded', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'a job that has ended cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'jobs_final_is_final';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER jobs_final_is_final BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_final_is_final();

-- The claim: the oldest queued job that is due.
CREATE INDEX jobs_claim_idx ON jobs (next_run_at, queued_at, id) WHERE state = 'queued';
-- The sweep: running jobs whose lease may have expired.
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at) WHERE state = 'running';
-- The list, newest first.
CREATE INDEX jobs_list_idx ON jobs (queued_at DESC, id DESC);
-- The limit on an account's active jobs and the cooldown between its provider checks (FR-046, FR-047). It also serves
-- the RESTRICT check of created_by; cancelled_by is rare enough to go without an index of its own.
CREATE INDEX jobs_account_idx ON jobs (created_by, kind, queued_at DESC);

-- One row per model request a job made: Milestone 1's usage record (FR-050). A request that was made counts against
-- its job's caps whichever worker records it, so these rows are not fenced.
CREATE TABLE job_usage (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id              UUID NOT NULL,
  run                 INTEGER NOT NULL,
  operation           TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  outcome             TEXT NOT NULL,
  attempts            SMALLINT NOT NULL,
  input_tokens        INTEGER NOT NULL,
  output_tokens       INTEGER NOT NULL,
  tokens_estimated    BOOLEAN NOT NULL,
  -- NULL means the price is unknown. It is never 0 for an unknown price (Milestone 1, FR-033).
  cost_usd            NUMERIC(14, 8),
  cost_estimated      BOOLEAN NOT NULL,
  price_source        TEXT NOT NULL,
  -- NULL for an embedding, which has no temperature.
  temperature_applied BOOLEAN,
  duration_ms         INTEGER NOT NULL,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT job_usage_run_check CHECK (run >= 1),
  CONSTRAINT job_usage_operation_check CHECK (operation IN ('generate', 'embed')),
  CONSTRAINT job_usage_provider_check CHECK (provider IN ('anthropic', 'openai-compatible', 'bedrock', 'gemini')),
  CONSTRAINT job_usage_model_check CHECK (length(btrim(model)) > 0),
  CONSTRAINT job_usage_outcome_check CHECK (
    outcome IN (
      'ok', 'not_configured', 'not_authorized', 'not_available', 'rate_limited', 'provider_unavailable',
      'input_too_large', 'output_limit_reached', 'refused', 'rejected', 'invalid_output', 'cancelled'
    )
  ),
  CONSTRAINT job_usage_attempts_check CHECK (attempts BETWEEN 0 AND 5),
  CONSTRAINT job_usage_tokens_check CHECK (input_tokens >= 0 AND output_tokens >= 0),
  CONSTRAINT job_usage_duration_check CHECK (duration_ms >= 0),
  CONSTRAINT job_usage_price_source_check CHECK (price_source IN ('operator', 'list', 'none')),
  CONSTRAINT job_usage_cost_check CHECK ((price_source = 'none') = (cost_usd IS NULL) AND (cost_usd IS NULL OR cost_usd >= 0)),
  CONSTRAINT job_usage_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
);

CREATE INDEX job_usage_job_idx ON job_usage (job_id, id);

-- One row per running worker process, so "is any worker alive" is a query even when no job is running (FR-008). No host
-- name, address or process id is kept. A worker deletes its own row when it stops.
CREATE TABLE workers (
  id           UUID PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopping     BOOLEAN NOT NULL DEFAULT false
);
