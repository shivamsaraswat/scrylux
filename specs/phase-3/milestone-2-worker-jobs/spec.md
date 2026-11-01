# Feature Specification: Worker and Jobs

**Feature Branch**: not yet created (spec directory `phase-3/milestone-2-worker-jobs`; work is on `feat/phase-3`)

**Created**: 2026-10-31

**Status**: Draft

**Input**: User description: "let's start on milestone 2 of phase 3". This covers Phase 3 / Milestone 2 of `plan.md`,
the worker and its jobs. Scrylux gets a second process, the **worker**, that runs long work in the background, off
the request path. Work is queued as **jobs**, kept in the existing database with no new service. Each job reports
its progress, is retried when it fails for a reason that may pass, can be cancelled by a person, and carries a
**token cap and a cost cap**, so one job cannot spend past a limit the operator set. Every model request a job makes
is recorded with the usage record that Milestone 1's provider layer returns, which Milestone 1 left for this
milestone to keep. The UI shows each job's status. This milestone also moves Scrylux's model requests out of the API
process: from now on only the worker talks to a model provider. It ships one job kind, the **provider check**: a
signed-in person starts it from the UI, and it sends Milestone 1's fixed check request, with no user content, to the
configured provider through the worker (US6). Ingestion (Milestone 3) is the first milestone whose jobs send user
content to a provider. System extraction and threat generation, which run as jobs too, are Milestones 4 and 6.

## Clarifications

### Session 2026-10-31

- Q: Which job kind does Milestone 2 ship? → A: A provider check that any signed-in person starts from the UI. It
  sends Milestone 1's fixed check request (Milestone 1, FR-047) to each configured operation through the worker and
  reports, per operation, the same facts as the operator's check command. It is the only job kind, and it sends no
  user content. Because it lets any signed-in account, not only an operator with a shell, make the provider spend,
  the per-account limit on active jobs (FR-046) and the caps bound it, and the threat model records it (US6, FR-090
  to FR-093, FR-080).
- Q: Should Scrylux limit how often one account can start a provider check, beyond the cap of 3 active jobs per
  account? → A: Yes, with a per-account cooldown between provider checks: one check per account every 5 minutes by
  default, which the operator can change. A refused start says when the next check is allowed (FR-047).
- Q: How long should finished jobs and their usage records be kept? → A: Indefinitely in this milestone. A job that
  belongs to a threat model (from Milestone 3) is deleted with it. A provider check belongs to none and is kept. No
  automatic clean-up; storage growth is the operator's to watch, as for other records (FR-052).
- Q: Where in the UI should people see jobs and start a provider check? → A: On a Jobs page in the main navigation.
  It shows whether AI is configured and whether each operation is hosted or local, offers "Check AI provider", and
  lists every job newest first, each row opening that job's details. No indicator on every page (FR-061a).

### Session 2026-10-31 (during planning)

- Q: Which queue should the worker use, given that plan.md names pg-boss? → A: A Scrylux jobs table in the existing
  database, claimed with row locks that skip rows other workers hold. The job record the spec needs is that table, so
  there is one state machine and every table is created by Scrylux's migrations (FR-002, FR-003). plan.md and
  docs/roadmap.md change to match (research #1).
- Q: Where does the worker's code live? → A: As a second entry point of the API application, in the same image, rather
  than a separate application, so the image does not carry a second copy of the dependencies and the configuration
  loader is shared. The constitution's layout list and plan.md drop the separate worker application (FR-001,
  research #2).
- FR-042's worst case counts the calls a provider can bill (schema attempts and transient retries). Milestone 1's free
  resends follow a refusal that comes before any generation, so they spend nothing and are not counted (research #7).
- SC-008's 10-second bound holds while a worker is running. A job waiting for its next run with no worker alive is
  failed as "timed out" by the next worker that starts (research #6).
- The caps, runs and time limit are copied onto a job by the API when it queues it, so a changed setting applies to
  jobs queued after the API restarts with it (edge case "Caps changed by the operator").

### Session 2026-11-01 (after cross-artifact analysis)

The maintainer asked for the analysis findings to be resolved. No new decision was asked of anyone; these record what
the spec now says and why:

- A running job whose worker died is shown as having lost its worker once the recovery time has passed, the UI's
  no-worker notice covers it, and cancelling it then ends it at once. The 10-second cancel applies while the job's
  worker is alive (FR-030, FR-062, edge case "A worker that dies holding a job").
- FR-021 counts runs: a run handed back by a stopping worker does not count.
- FR-004's list of the worker's own settings includes the health port (FR-010) and the cooldown (FR-047).

## User Scenarios & Testing *(mandatory)*

This milestone has three kinds of user. People signed in to Scrylux start jobs, watch them and cancel them in the
UI. Operators who self-host Scrylux run the worker and set its limits. The parts of Scrylux that later milestones
build (ingestion, system extraction, threat generation) define their work as job kinds and rely on the guarantees
below. The stories are written from their side.

### User Story 1 - Start a job and watch it to the end (Priority: P1)

A signed-in person starts a piece of background work from the UI. Scrylux answers at once that the work is queued,
and the person can keep using Scrylux. The UI shows the job's state (queued, running, then succeeded, failed or
cancelled), its progress while it runs, and, when it ends, how it ended, what it used and, if it failed, why, in
words the person can act on. The status updates on its own, with no reload.

**Why this priority**: Every AI feature in Phase 3 takes seconds to minutes. Holding a web request open that long
fails on any proxy with a time limit, and gives the person no way to see what is happening or to stop it. Showing
status is the part of this milestone a person sees, and plan.md names it.

**Independent Test**: With a worker running, start a job of the shipped kind (US6) against simulated provider
responses. Check that the start answers at once with a queued job, that the UI shows it move from queued to running
to succeeded without a reload, that its progress advances while it runs, and that the finished job shows its usage.
Then start one against a simulated provider that rejects the key, and check that the job ends as failed with the
"not authorized" message and its hint.

**Acceptance Scenarios**:

1. **Given** a signed-in person, **When** they start a job, **Then** Scrylux answers at once with the job in the
   queued state, without waiting for the work, and the job appears in the list on the Jobs page (FR-061a).
2. **Given** a job that is queued or running, **When** its state or progress changes, **Then** the UI shows the
   change within 5 seconds, without a reload (FR-061).
3. **Given** a running job, **When** its progress is read, **Then** it names the step it is on, from a fixed list for
   its kind, and, where the step has a known size, how much of it is done.
4. **Given** a finished job, **When** it is opened, **Then** it shows how it ended, when it was queued, started and
   finished, who started it, how many times it ran, its caps and what it used (FR-050).
5. **Given** a job that failed, **When** it is opened, **Then** it shows the failure category and its fixed message
   with a hint (FR-064), and never a raw provider error, a key, a base address or any content.
6. **Given** jobs waiting in the queue, **When** no worker is running, **Then** the UI says that no worker is
   processing jobs, instead of showing them queued with no explanation (FR-008, FR-062).

---

### User Story 2 - A job cannot overspend (Priority: P1)

Every job that can call a model has a token cap and a cost cap that the operator set. Before each model request, the
job checks that the most the request could use still fits under both caps. If it does not, the request is not sent,
and the job ends as "cap reached", keeping what it recorded. Retries count against the same caps, so retrying a job
never gives it a fresh budget.

**Why this priority**: plan.md requires per-job caps, and the constitution lists them as the planned answer to
runaway spend (Threat Model, Denial of Service). Milestone 1 bounds one request. A job can make many, and from
Milestone 3 it can make them on a document of any size. Without a cap that holds across retries, one large upload or
one misbehaving model could spend an install's whole provider budget.

**Independent Test**: Set a small token cap. Run a job against simulated responses with known token counts that
would need more than the cap. Check that the job stops before the request that would pass the cap, that no request
past it was sent, that it ends as "cap reached", and that its recorded usage is at or under the cap. Repeat with a
cost cap and a model with a known price. Then use a model with no known price, and check that the token cap still
stops the job and that the job says its cost is unknown and the cost cap was not applied.

**Acceptance Scenarios**:

1. **Given** a job whose next model request could, at its most, pass the token cap, **When** it is about to send it,
   **Then** the request is not sent and the job ends as "cap reached" (FR-042).
2. **Given** a model with a known price, **When** a job's next request could, at its most, pass the cost cap,
   **Then** the request is not sent and the job ends as "cap reached".
3. **Given** a job that ran, failed for a transient reason and runs again, **When** its usage is checked against
   its caps, **Then** the usage of every earlier run counts (FR-041).
4. **Given** a model with no known price (Milestone 1, FR-033), **When** a job uses it, **Then** the token cap still
   applies, and the job records its cost as unknown and that the cost cap could not be applied (FR-043).
5. **Given** a provider that does not report token counts, **When** a job's usage is checked against its cap,
   **Then** the estimated counts that Milestone 1 reports are used, never zero.
6. **Given** a signed-in person starting a job, **When** they start it, **Then** they cannot raise its caps. Only the
   operator's settings set them (FR-045).

---

### User Story 3 - Cancel a job (Priority: P1)

A signed-in person who started the wrong job, or sees one running too long, cancels it from the UI. A queued job
never starts. A running job stops, the model request it is waiting on is abandoned, no further request is sent, and
the job ends as cancelled with what it used up to then.

**Why this priority**: A job spends money and worker time. A person who cannot stop a mistake has to wait for it to
fail or ask the operator to restart the worker. plan.md names cancellation for this milestone.

**Independent Test**: Start a job against a simulated provider that holds its answer. Cancel it, and check that the
job ends as cancelled within 10 seconds, that the held request was abandoned, that no other request was sent after
the cancel, and that its usage up to then is recorded. Queue a job with no worker running, cancel it, start a worker,
and check that the job never runs.

**Acceptance Scenarios**:

1. **Given** a queued job, **When** a signed-in person cancels it, **Then** it ends as cancelled and never starts.
2. **Given** a running job, **When** a signed-in person cancels it, **Then** it ends as cancelled within 10 seconds,
   even when the worker running it is another process or another host (FR-030), and no model request is sent after
   that.
3. **Given** a job waiting before its next run (FR-021), **When** it is cancelled, **Then** it ends as cancelled and
   does not run again.
4. **Given** a job that has already finished, **When** someone tries to cancel it, **Then** nothing changes, and the
   answer says the job has already finished.
5. **Given** a cancelled job, **When** it is opened, **Then** it shows who cancelled it and when, and its usage up to
   the cancel.

---

### User Story 4 - Jobs survive failures and restarts (Priority: P2)

A job that fails for a reason that may pass (the provider is down or rate limiting after the layer's own retries,
or the worker running it stops) runs again after a growing wait, up to a limit. A job that fails for a reason that
will not pass (a wrong key, an unknown model, invalid output, a cap) ends at once. A worker that is stopped or
crashes does not lose the jobs it held: they go back to the queue and another worker, or the same one when it comes
back, picks them up. No job is ever run by two workers at once.

**Why this priority**: Long work on a self-hosted install meets restarts, upgrades and flaky providers. Without
recovery, a job held by a crashed worker would stay "running" forever. It is P2 because a single run that ends
cleanly already delivers US1 to US3.

**Independent Test**: Run a job against a simulated provider that is unavailable for the first run and answers on
the second, and check that it succeeds after two runs, with both runs' usage recorded. Run one against a provider
that rejects the key, and check that it fails after one run. Stop a worker hard while it holds a running job, and
check that the job is picked up again within the recovery time (FR-007) and finishes. Run two workers against 100
queued jobs, and check that each job ran exactly once.

**Acceptance Scenarios**:

1. **Given** a job whose run failed as "provider unavailable" or "rate limited", **When** runs remain, **Then** it
   runs again after a growing wait (FR-020, FR-021).
2. **Given** a job whose run failed in any other category (FR-020), **When** it fails, **Then** it ends as failed at
   once and does not run again.
3. **Given** a job that has used all its runs, **When** the last one fails for a transient reason, **Then** it ends as
   failed with that category.
4. **Given** a worker that is stopped or crashes while running a job, **When** the recovery time passes, **Then** the
   job goes back to the queue, counts the lost run as one of its runs, and is picked up again (FR-007).
5. **Given** a worker asked to stop (an upgrade or a scale-down), **When** it stops, **Then** it takes no new job,
   lets running jobs finish within a grace period, and hands back the ones that did not, so they run again elsewhere.
6. **Given** several workers, **When** jobs are queued, **Then** each job is run by at most one worker at a time.
7. **Given** a job that has run longer than the job time limit in all, counting its runs and waits, **When** the
   limit passes, **Then** it ends as failed with "timed out" (FR-022).

---

### User Story 5 - An operator runs the worker (Priority: P2)

An operator who upgrades a v0.1 install adds the worker, from the same published image, next to the app, with the
same database and provider settings. The worker checks its configuration when it starts, as the API does, and refuses
to start with a message that names any bad setting. The operator can run as many workers as they like, and set how
many jobs each runs at once, the default caps, the number of runs and the job time limit. An operator who does not
configure a provider, or does not run a worker, keeps every v0.1 flow working.

**Why this priority**: Scrylux is self-hosted first, and plan.md promises that API and worker processes stay
stateless and can be scaled. A worker that is hard to run, or that starts with a broken configuration and fails every
job, would make every Phase 3 feature hard to try.

**Independent Test**: Start the worker with no provider settings, and check that it starts. Start it with a provider
selected and a required setting missing, and check that it refuses to start and names the setting, never its value.
Start the API without provider keys but with the provider and model set, and check that it starts and reports AI as
configured. Run the v0.1 browser tests with no worker running, and check that they pass.

**Acceptance Scenarios**:

1. **Given** the published image, **When** the operator starts the worker from it with a different command, **Then**
   it starts, and the shipped compose files run it as a separate service next to the app.
2. **Given** a provider selected with a setting missing or malformed, or a vendor variable left in the environment,
   **When** the worker starts, **Then** it refuses to start, under the same rules as the API (Milestone 1, FR-006
   and FR-043a), and contacts no provider.
3. **Given** the API process with the provider and model set but no provider key, **When** it starts, **Then** it
   starts, and reports generation and embeddings as configured or not and as hosted or local (FR-071).
4. **Given** two workers and one API on the same database, **When** jobs are queued, **Then** all of them are run,
   each by one worker (FR-005).
5. **Given** no worker running, **When** a person uses Scrylux's v0.1 features, **Then** every one of them works as in
   v0.1 (FR-072).
6. **Given** any job, **When** it changes state, **Then** the worker writes one log line with the job's identifier,
   kind, state and usage, and no content, prompt, answer, key or base address (FR-009).

---

### User Story 6 - Check the AI provider from the UI (Priority: P2)

A signed-in person who wants to know whether AI works on this install starts a provider check from the Jobs page. It runs
as a job. The worker sends Milestone 1's fixed check request, with no user content, to the configured generation
provider and, if one is configured, to the embedding provider. When the job ends, the person sees, for each
operation: the provider, the model, whether data sent to it leaves the install, whether it worked or how it failed,
with a hint, and what it used. Until now only an operator with a shell could run this check.

**Why this priority**: It is the one job kind this milestone ships, so that the queue, the caps, cancellation,
retries and the status UI are used end to end against a real provider before Milestone 3 depends on them. It also
lets a person tell a working setup from a wrong key or model name without shell access. It is P2 because US1 to US4
can be built and tested against any job kind.

**Independent Test**: With a simulated provider, start a provider check from the UI, and check that it runs through
the worker, that its progress names the operation it is on, and that the finished job shows, for each configured
operation, the provider, model, hosted or local, outcome and usage. Configure only generation, and check that the
job reports embeddings as not configured, without failing for it. Simulate a provider that rejects the key, and check
that the job fails as "not authorized", runs once, and still shows the result for each operation it tried. With no
provider configured, check that the UI does not offer the check and says that AI is not configured.

**Acceptance Scenarios**:

1. **Given** a configured provider and a running worker, **When** a signed-in person starts a provider check,
   **Then** it is queued at once and runs through the worker, and the API process sends no request to the provider
   (FR-070).
2. **Given** a provider check that has finished, **When** it is opened, **Then** it shows, for each configured
   operation, the provider, the model, whether data sent to it leaves the install, success or the failure category
   with its hint, and its usage, including where the price came from or that it is unknown (FR-091).
3. **Given** generation configured and embeddings not, **When** the check runs, **Then** it checks generation only,
   shows embeddings as not configured, and succeeds if generation works.
4. **Given** one operation that works and one that fails, **When** the check ends, **Then** the job ends as failed
   with the failing operation's category, and still shows the result of the operation that worked (FR-092).
5. **Given** a provider check, **When** it runs, **Then** it sends only the fixed check request that ships with
   Scrylux, and nothing a person typed or uploaded (FR-093).
6. **Given** no provider configured, **When** a person looks for the check, **Then** the UI does not offer it and
   says that AI is not configured (FR-063).
7. **Given** a provider check that is running, **When** it is cancelled, **Then** it behaves as US3 says.
8. **Given** an account that queued a provider check less than the cooldown period ago (5 minutes by default),
   **When** it starts another, **Then** the start is refused, no job is queued, and the answer and the UI say when the
   next check is allowed. Cancelling the first check does not shorten the wait (FR-047).

---

### User Story 7 - The worker and its jobs are in Scrylux's own threat model (Priority: P2)

A reviewer reads Scrylux's threat model and finds the worker as a current process, what it holds (the database
credentials and the provider keys), the new entry points (starting, cancelling and listing jobs), the new records
(jobs and their usage), and how the per-job caps now answer the runaway-spend risk that was planned for this milestone.

**Why this priority**: Principle V requires the Threat Model section, and `docs/threat-model/`, to be updated in the
same change that adds a process, an entry point or stored data. This milestone adds all three.

**Independent Test**: Read the Threat Model section and the committed threat model after the change, check that each
item of FR-080 is there, and that the threat model's checks pass on the pull request.

**Acceptance Scenarios**:

1. **Given** the change, **When** the constitution's Threat Model section is read, **Then** it lists the items of
   FR-080.
2. **Given** the change, **When** `docs/threat-model/` is checked on the pull request, **Then** it matches the section
   and its checks pass.

---

### Edge Cases

- **No worker running.** Jobs wait in the queue. The UI says no worker is processing jobs (FR-062), and a queued job
  can still be cancelled. Nothing else in Scrylux waits on the worker (FR-072).
- **A worker that dies holding a job.** Until its recovery time passes (FR-007), Scrylux cannot tell a dead worker
  from a slow one, so the job still shows as running and a cancel is recorded as asked. Once the recovery time has
  passed, the job is shown as having lost its worker. A live worker then runs it again or, if a cancel was asked,
  ends it as cancelled. With no worker alive, it stays that way until one starts, and cancelling it ends it at once
  (FR-030, FR-062).
- **No provider configured.** The worker starts and runs any job kind that does not call a model. A job kind that
  calls a model is not offered, and the UI says that AI is not configured (FR-063). If one is queued anyway, for
  example because the configuration changed between queueing and running, it fails as "not configured" and is not
  run again.
- **The configuration differs between processes.** The API and the worker read their settings separately, and an
  operator may set them differently. What a job does follows the worker's settings, because the worker makes the
  requests. A worker whose settings are invalid does not start (US5).
- **A worker crashes mid-request.** The request is lost and its usage may be unknown to Scrylux, though the provider
  may still charge for it. The lost run counts as one of the job's runs. The usage the job did record still counts
  against its caps. The threat model records that a crash can spend up to one request's worth that Scrylux did not
  count.
- **A job that would run twice.** A job held by a worker that seemed dead but was only slow could be picked up by
  another. Scrylux must keep the first from writing after the second has taken the job over (FR-005, FR-007), and job
  kinds must be written so that running again after a lost run does not duplicate what they write (FR-014).
- **A cap smaller than one request.** If the most a single request could use is more than a job's whole cap, the job
  ends as "cap reached" before sending anything, and the message says the cap is lower than one request needs.
- **Unknown cost partway through.** A job may mix requests with and without a known price, for example generation
  priced and a local embedding model unpriced. Its cost is then shown as unknown, with the known part named as the
  least it cost (FR-043).
- **Caps changed by the operator.** A job keeps the caps it had when it was queued. A changed setting applies to jobs
  queued after the API process, which copies them onto each job it queues, restarts with it.
- **The job time limit and a long request.** A request already running when the job time limit passes is abandoned,
  like a cancel, and the job fails as "timed out".
- **Many jobs from one account.** With no role model, any signed-in account can start jobs. A limit on how many
  jobs one account can have queued or running at once keeps one account from filling the queue (FR-046), and a
  cooldown between one account's provider checks keeps it from starting them one after another (FR-047).
- **Several accounts, one person.** Any signed-in account can create more accounts, so the per-account limits slow
  one person down without stopping them. The cooldown bounds each account, not the install. The threat model records
  what remains (FR-080).
- **A person who is not the starter.** Any signed-in person can see and cancel any job, as any signed-in person can
  change any threat model today. This broadens what an account can do, and the threat model says so (FR-065, FR-080).
- **Clock differences.** Several workers on several hosts may have slightly different clocks. Recovery and time
  limits must not depend on two hosts agreeing to the second.
- **Records that grow.** Job and usage records are small, but every job adds some. They are kept indefinitely (FR-052),
  and the storage growth is treated like that of other records: the operator watches it. The cooldown (FR-047) limits
  how fast provider checks add to it. Automatic clean-up is left for later, with Phase 6's audit and retention work.

## Requirements *(mandatory)*

### Functional Requirements

**The worker**

- **FR-001**: Scrylux MUST have a worker process that runs jobs off the request path. It MUST ship in the same
  published image as the app, started with a different command, and the shipped compose files (development and
  release) MUST run it as a separate service.
- **FR-002**: Jobs MUST be kept in Scrylux's existing database. This milestone MUST NOT add a service for the
  queue (plan.md).
- **FR-003**: Every table that job storage uses MUST be created and changed only by forward-only SQL migrations
  tracked in `schema_migrations` (Principle IV). Nothing may create or change tables when a process starts.
- **FR-004**: The worker MUST check the provider configuration when it starts, under the same rules as the API
  (Milestone 1, FR-006, FR-043a and FR-044a), and MUST refuse to start with a message that names the setting and
  never its value. It MUST NOT contact a provider when it starts. Its own settings (FR-006, FR-010, FR-021, FR-022,
  FR-040, FR-046, FR-047) are checked the same way.
- **FR-005**: Any number of workers MUST be able to run against one database at once. A job MUST be run by at most
  one worker at a time, and a worker that has lost a job (FR-007) MUST NOT write that job's state, progress or
  results after it was taken from it. The worker MUST keep no state of its own between jobs (Principle IV).
- **FR-006**: The operator MUST be able to set how many jobs one worker runs at once. The default is 1, so a
  worker fits the small hosts the deployment guide names.
- **FR-007**: A job whose worker has stopped reporting that it is alive MUST go back to the queue within a recovery
  time of no more than 2 minutes after its last report. The lost run counts as one of the job's runs (FR-021).
  When asked to stop, a worker MUST take no new job, let its running jobs go on for a grace period of no more than 30
  seconds, and then hand back the ones still running, so they run again elsewhere without waiting for the recovery
  time.
- **FR-008**: Scrylux MUST be able to tell whether at least one worker is alive, so the UI can say when none is
  (FR-062).
- **FR-009**: The worker MUST log to stdout only: one line when it starts (with its settings' safe facts, as the API's
  start-up line), one line when it stops, one line per job state change with the job's identifier, kind, new state and
  usage totals, and Milestone 1's line per model request. No line may hold content, a prompt, an answer, a key or a
  base address (Principle IV).
- **FR-010**: The worker MUST offer a health check that a container platform can use, which needs no
  authentication and does not contact a provider.

**Jobs**

- **FR-011**: A job MUST record: its identifier, its kind, its input, its state, who started it, when it was queued,
  started and finished, its progress, how many times it has run, its caps, its usage totals (FR-050), and, when it
  ended other than in success, its failure category and fixed message, and who cancelled it if someone did.
- **FR-012**: A job's state MUST be one of: queued, running, succeeded, failed, cancelled. A job waiting before its
  next run is queued, with the time it will run next. Succeeded, failed and cancelled are final: a job in one of them
  never changes state again.
- **FR-013**: Job kinds MUST be a fixed list that ships with Scrylux. Each kind declares the shape of its input, which
  is checked before the job is queued. An unknown kind, or input that does not match, MUST be refused with the API's
  usual error answer, and no job is queued.
- **FR-014**: Every job kind MUST be safe to run again after a lost or failed run: a run that starts over MUST NOT
  duplicate what an earlier run wrote, and a job that does not succeed MUST NOT leave a partial result that looks
  complete.
- **FR-015**: A job's progress MUST name its current step, from a fixed list for its kind, and, where the step has a
  known size, how much of it is done. Within one run, progress MUST NOT go backwards.
- **FR-016**: Jobs MUST be taken from the queue in the order they were queued, apart from jobs waiting before their
  next run. This milestone has no priorities and no scheduled or recurring jobs (plan.md excludes autonomous
  triggers from Phase 3).

**Retries and time limits**

- **FR-020**: A job MUST run again only when its run failed as "provider unavailable" or "rate limited" (after the
  provider layer's own retries, Milestone 1 FR-021 and FR-022), or because its worker was lost (FR-007). In every
  other case (not configured, not authorized, not available, input too large, output limit reached, refused,
  rejected, invalid output, cap reached, timed out, cancelled, or an error in the job's own work) it MUST end at once.
- **FR-021**: A job MUST have at most 3 counted runs by default, with a growing wait before each new run. The operator
  MAY set a number from 1 to 5. A lost run counts (FR-007). A run that a stopping worker hands back (FR-007) does not
  count, so restarting or scaling down workers never uses up a job's runs.
- **FR-022**: Every job MUST have a time limit for its whole life once it first starts, counting its runs and the
  waits between them: 60 minutes by default, which the operator can change. A job that passes it MUST end as failed
  with "timed out", abandoning any request in progress. The limit bounds the job no matter how many requests it
  makes, on top of Milestone 1's bound on each request.

**Cancellation**

- **FR-030**: Any signed-in person MUST be able to cancel a queued or running job. A cancelled queued job MUST never
  start. A cancelled running job MUST abandon its request in progress, send no further request, and end as cancelled
  within 10 seconds of the cancel, whichever process or host runs it, as long as its worker is alive. A running job
  whose worker has been lost (FR-007) ends as cancelled as soon as its loss is known: at once if it is already known
  when the cancel arrives, otherwise once the recovery time has passed, by a live worker or by cancelling it again.
- **FR-031**: A job cancelled while waiting before its next run MUST end as cancelled without running again.
- **FR-032**: Cancelling a job in a final state MUST change nothing, and the answer MUST say that the job has already
  finished.
- **FR-033**: A cancelled job MUST record the usage of every request it made up to the cancel, including the one it
  abandoned, as far as Milestone 1 reports it.

**Caps**

- **FR-040**: Every job that can call a model MUST have a token cap and a cost cap, set from the operator's settings
  when it is queued. Both MUST have a documented default, so no job runs uncapped. The operator MAY change them. A
  negative, zero or malformed cap MUST stop the worker and the API from starting.
- **FR-041**: A job's usage against its caps MUST count every model request it made, every attempt within each
  request (Milestone 1, FR-031), and every run of the job. Estimated token counts count as reported.
- **FR-042**: Before each model request, a job MUST work out the most that request could use: its input size and its
  output limit, times every call the provider layer can make for one request that a provider can bill (Milestone 1,
  FR-010: its schema attempts and its transient retries). A resend for a refused setting follows a refusal that comes
  before any generation, so it is not counted (clarified at planning). If that would take the job's tokens past the
  token cap, or, where the price is known, its cost past the cost cap, the request MUST NOT be sent, and the job MUST end as failed with
  "cap reached". So a job's recorded usage never goes past its caps, except by the error of an estimated input size.
- **FR-043**: When a request's price is unknown (Milestone 1, FR-033), the cost cap cannot be checked for it. The token
  cap MUST still apply. The job MUST record that its cost is unknown, with the known part as the least it cost, and
  that the cost cap was not applied to every request.
- **FR-044**: A job whose cap is lower than the most a single request could use MUST end as "cap reached" before it
  sends anything, and its message MUST say that the cap is lower than one request needs.
- **FR-045**: A person starting a job MUST NOT be able to set or raise its caps. Only the operator's settings set them
  in this milestone.
- **FR-046**: One account MUST be able to have at most a set number of jobs queued or running at once: 3 by default,
  which the operator can change. A job beyond it MUST be refused with an answer that says why.
- **FR-047**: One account MUST be able to start at most one provider check per cooldown period: 5 minutes by default,
  which the operator can change, and 0 turns the cooldown off. The period runs from when the account's last provider
  check was queued, whatever its outcome, so cancelling a check does not let the account start another one sooner. A
  start inside the period MUST be refused, no job is queued, and the answer MUST say when the account can start the
  next check. The UI MUST show the same. The API MUST check this setting when it starts, like the other settings
  (FR-040): a negative or malformed value stops it from starting.

**Usage records**

- **FR-050**: The usage record of every model request a job makes (Milestone 1, FR-030) MUST be stored with the job.
  A job MUST show its totals: input and output tokens, whether any were estimated, cost or unknown (FR-043), the
  number of requests and the time it ran. The totals MUST equal the sum of its stored records.
- **FR-051**: Stored job inputs, progress, usage records and failure messages MUST NOT hold a prompt, an answer, a key
  or a base address. A job input MAY refer to user content by its identifier, never by holding the content itself.
- **FR-052**: Job records and their usage records MUST be kept indefinitely. A job that belongs to a threat model
  (from Milestone 3) MUST be deleted, with its usage records, when that threat model is deleted. A provider check
  belongs to no threat model and is kept. This milestone has no automatic clean-up and no retention setting, so the
  full spend history stays available to the operator.

**API and UI**

- **FR-060**: A signed-in person MUST be able to start a job of a kind the UI offers, list jobs newest first a page at
  a time, open one job with its usage records, and cancel one. These MUST be routes under `/api/v1`, need sign-in,
  check their input with the shared schemas, answer errors in the API's usual form, and appear in the generated OpenAPI
  document. Each start and each cancel MUST log one line (who, what, which job).
- **FR-061**: The UI MUST show every job's state, kind, who started it, progress, usage, caps and, for a job that did
  not succeed, its failure message with its hint. While a job shown on screen is queued or running, the UI MUST show its
  changes within 5 seconds, without a reload. Once it is in a final state, the UI MUST stop asking for its changes.
- **FR-061a**: Jobs MUST be shown on a Jobs page reached from the main navigation. The page MUST show whether
  generation and embeddings are configured and whether each is hosted or local (Milestone 1, FR-045), offer "Check AI
  provider" (FR-090), and list every job newest first, a page at a time, each row opening that job's details (FR-061).
  The notices of FR-047, FR-062 and FR-063 appear on this page. No other page shows jobs in this milestone, and
  no indicator of active jobs appears on every page, so pages other than the Jobs page never ask for job changes.
- **FR-062**: When no worker is alive (FR-008) and a job is queued, or a running job's worker has been lost (FR-007),
  the UI MUST say that no worker is processing jobs. A running job whose worker has been lost MUST be shown as such,
  not as running normally, and cancelling it MUST end it at once.
- **FR-063**: When no provider is configured, the UI MUST NOT offer a job kind that calls a model, and MUST say that
  AI is not configured.
- **FR-064**: Every failure category MUST have a fixed message and a hint that tells the person what to do, kept as
  versioned data in the repository (Principle IV). A message MUST NOT include a raw provider error, a key, a base
  address or any content. The categories are Milestone 1's (FR-020), plus "cap reached", "timed out" and "worker
  lost", plus an error in the job's own work.
- **FR-065**: Any signed-in person MUST be able to see and cancel every job, not only their own. This broadens what an
  account can do (Principle V), until Phase 6 brings roles, and the threat model MUST say so (FR-080).
- **FR-066**: Job identifiers, kinds, states, progress and failure messages shown in the UI MUST be rendered as text,
  never as markup (Principle VI).

**Who makes model requests**

- **FR-070**: Only the worker MUST send requests to a model provider. The API process MUST NOT send any. The
  operator's check command from Milestone 1 stays a separate command an operator runs.
- **FR-071**: The API process MUST start without any provider key when the other provider settings are valid, and
  MUST still report whether generation and embeddings are configured and whether each is hosted or local (Milestone 1,
  FR-045). If a key is given to it, it MUST still check it as in Milestone 1. The documented configuration MUST give
  the provider keys to the worker only (Principle V). This replaces, for the API process only, Milestone 1's rule that
  a missing key stops start-up (Milestone 1, FR-006 and US2's independent test). The worker keeps that rule (FR-004).
- **FR-072**: Every v0.1 flow MUST keep working with no worker running and with no provider configured.

**Threat model and documentation**

- **FR-080**: The constitution's Threat Model section and `docs/threat-model/` MUST be updated in the same change
  (Principle V) to list: the worker as a current process, with what it holds (the database credentials and the
  provider keys) and that it is now the only process that sends requests to a provider; the new entry points
  (starting, listing, opening and cancelling jobs); the new records (jobs and their usage records, and that they hold
  no content); that any signed-in account can see and cancel every job (FR-065); that any signed-in account, not only
  an operator with a shell, can now make the provider spend, through the provider check (FR-090), bounded by the
  caps, the limit on jobs per account (FR-046) and the cooldown between one account's provider checks (FR-047); and
  the risks with their handling: runaway spend (the per-job caps, which move from planned to partially mitigated, and
  the one request a crash can leave uncounted; spend over time is bounded per account by the cooldown, and what remains
  open, that any account can create more accounts, stays until Phase 6's roles and rate limiting), a job that runs twice (FR-005, FR-014), and a job that never ends
  (FR-022).
- **FR-081**: Every setting the worker reads MUST be documented in the environment-variable table in
  `docs/install.md`, and the documentation MUST show how to run the worker with the published image and with the
  compose files, and how to give the provider keys to it alone (FR-071).
- **FR-082**: The tests MUST run without any real provider and without any repository secret, using simulated
  provider responses, so that pull requests from forks get the same results (constitution, Information Disclosure).

**The first job kind**

- **FR-090**: This milestone MUST ship one job kind, the provider check, which any signed-in person can start from the
  UI when a provider is configured. It MUST satisfy FR-011 to FR-066 like any other kind. Its progress steps are
  generation and embeddings.
- **FR-091**: A finished provider check MUST show, for each operation (generation and embeddings): the provider, the
  model, hosted or local, success, "not configured", or the failure category with its hint, and its usage record,
  including where the price came from or that it is unknown. These are the facts the operator's check command reports
  (Milestone 1, FR-046), and they are stored with the job. They hold no key and no base address.
- **FR-092**: A provider check MUST succeed only if every configured operation succeeds. An operation that is not
  configured does not fail it. If an operation fails, the job MUST end with that operation's category, retried only
  as FR-020 allows, and MUST still show the result of each operation it tried.
- **FR-093**: A provider check MUST send only the fixed check request that ships as versioned data with Scrylux
  (Milestone 1, FR-047). It MUST take no input from the person who starts it beyond the choice to start it.

### Key Entities *(include if feature involves data)*

- **Job**: one piece of background work. Its kind, input, state, starter, times, progress, runs, caps, usage totals,
  and failure category and message or canceller. Kept in the database indefinitely, or until the threat model it belongs to, if any, is deleted.
- **Job kind**: a fixed, shipped definition of a kind of work: the shape of its input, its list of progress steps,
  and whether it calls a model.
- **Progress**: the current step, from the kind's list, and, where the step has a known size, how much is done.
- **Caps**: a token cap and a cost cap, copied onto a job from the operator's settings when it is queued.
- **Usage record**: Milestone 1's record of one model request (provider, model, operation, tokens, estimated or
  reported, cost or unknown, price source, temperature applied, attempts, duration, outcome), now stored with the job
  that made the request.
- **Provider check result**: for one provider check job, per operation, the provider, model, hosted or local, outcome
  with its hint, and usage record. Stored with the job, with no key and no base address.
- **Worker**: a process that takes jobs from the queue and runs them, reports that it is alive, and holds no state of
  its own between jobs.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With no provider configured and no worker running, the full v0.1 test suite, including the browser
  tests, passes unchanged, and `/health` answers as before.
- **SC-002**: A job's change of state or progress appears in the UI within 5 seconds, without a reload, in 100% of
  the browser tests that watch a job.
- **SC-003**: A cancelled queued job never runs. A cancelled running job ends as cancelled within 10 seconds, and no
  model request is sent after the cancel, in 100% of tests, including with the job on another worker process.
- **SC-004**: Against simulated responses with known token counts and prices, 0 jobs record usage past their token
  cap, and 0 jobs whose every price is known record cost past their cost cap, across retries and lost runs.
- **SC-005**: With two workers and 100 queued jobs, every job runs exactly once when none fails. A worker stopped hard
  while running a job has that job picked up again within 2 minutes plus one wait before the next run, and the job
  finishes.
- **SC-006**: For 100% of finished jobs, the totals shown equal the sum of their stored usage records.
- **SC-007**: A recognizable fake key and recognizable fake content, run through every job outcome, appear in 0 log
  lines, job records, usage records, API answers or pages.
- **SC-008**: A job against a provider that keeps failing for a transient reason ends after at most 3 runs by
  default, and, while a worker is running, no job lives past its time limit by more than 10 seconds.
- **SC-009**: Every worker misconfiguration listed in US5 stops the worker from starting, with a message that names
  the setting and holds 0 setting values.
- **SC-010**: The updated threat model passes its pull-request checks, and a reviewer can find the worker, its
  entry points, its records and the per-job caps in both the constitution and `docs/threat-model/`.
- **SC-011**: In 100% of tests, a second provider check from the same account inside the cooldown period is refused
  with no job queued, and one started after the period is accepted.

## Assumptions

- **The queue is Scrylux's own.** plan.md chose a Postgres-backed queue (pg-boss) so that self-hosters run no extra
  service. At planning the maintainer chose a Scrylux jobs table in the same database instead, which keeps that goal
  and lets every table follow FR-003 (clarified at planning). The worker is a second entry point of the existing API
  application, started from the same image (FR-001).
- **No user content is sent in this milestone.** Ingestion (Milestone 3) is the first milestone to send user content
  to a provider and owns the notice that data leaves the install (Principle VI). The provider check sends only fixed
  text that ships with Scrylux, which the constitution says holds no user content. Its result already shows whether
  each provider is hosted or local.
- **The worker is optional for v0.1 features.** Manual modeling stays first-class (plan.md, principle 1). An install
  that does not want AI does not have to run a worker (FR-072).
- **Caps come from the operator.** Each job copies the operator's caps when it is queued. Per-person or per-project
  budgets, and a total spend limit for the whole install, are not part of this milestone. The operator's provider
  account is the place for an install-wide limit, and the documentation says so.
- **The defaults chosen here** are adjustable in the plan if research shows a reason: 1 job at a time per worker,
  3 runs per job, a 60-minute job time limit, 3 active jobs per account, recovery within 2 minutes, a 30-second grace
  period on stop, and a cancel that takes effect within 10 seconds. The default token and cost caps are set in the
  plan, sized for Milestone 3's ingestion of a typical design document, and documented. They MUST at least fit one
  provider check, both operations at their most (FR-042), or FR-044 would end every check before it sends anything.
- **Caps bound one job; the cooldown bounds spend over time per account.** Per-job caps and the limit on active jobs
  per account bound what is in flight at once. The cooldown (FR-047, clarified 2026-10-31) bounds how often one account
  can start a provider check. Nothing bounds the install as a whole across many accounts until Phase 6 adds roles and
  rate limiting, and the threat model says so (FR-080). Later job kinds (Milestone 3 onward) decide whether they need a
  cooldown of their own.
- **Status updates without a reload.** The UI checks for changes often enough to meet the 5-second target. A push
  channel to the browser is not required by this milestone.
- **Jobs are visible to everyone signed in.** Scrylux has no roles before Phase 6, so a job is not private to its
  starter (FR-065).
- **No notifications.** A person learns that a job ended by looking at it. Email or other notifications are not part
  of this milestone.
- **Moving heavy v0.1 operations to the worker.** The threat model names moving reports, import and export, and rule
  generation to the worker as a later remedy. This milestone moves none of them (clarified 2026-10-31).
- **The operator's check command stays.** The command from Milestone 1 still works from a shell, without a running
  worker job, but it needs the provider keys. Since the documented configuration gives them to the worker only
  (FR-071), the documentation tells operators to run it with the worker's environment, for example inside the worker's
  container. The provider check job is a second way to run the same fixed request, from the UI.
