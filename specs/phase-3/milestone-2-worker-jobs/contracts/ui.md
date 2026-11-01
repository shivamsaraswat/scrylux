# Contract: The Jobs Pages

Two routes inside the signed-in shell (FR-061, FR-061a), and one header link. Every value from the API is rendered
as text by React, never as markup (FR-066).

## Header

A **Jobs** link next to the Scrylux link, on every signed-in page. It is a plain link: no count, no badge, and no
request for job data from any page but the two below (FR-061a, clarified 2026-10-31).

## `/jobs`: the Jobs page

From top to bottom:

1. **AI status** (from `GET /jobs/status`): for generation and for embeddings, "not configured", or the provider, the
   model, and "hosted: data sent to it leaves this install" or "local: stays in this install".
2. **Check AI provider** button, shown only when `provider_check.offered` (FR-063). When AI is not configured, the page
   says so instead: "AI is not configured on this install. An operator can set it up: see docs/ai-providers.md."
   While the cooldown runs, the button is disabled and says when the next check is allowed (FR-047). A `429` or `409`
   from `POST /jobs` shows the answer's message.
3. **No worker notice**, when `worker_alive` is false and at least one job is queued, or when any listed job has
   `worker_lost`: "No worker is processing jobs. Queued jobs will start when an operator starts one." (FR-062). A row
   whose job has `worker_lost` shows "Worker lost" instead of its progress.
4. **The list** (`GET /jobs`), newest first, 25 at a time with "Show more": kind ("Provider check"), state (with
   "cancelling" while a cancel is asked), who started it, when it was queued, progress for a running job, tokens and
   cost for a finished one. Each row links to its job page.

**Refreshing**: the list and the status are fetched again every 2 s while any listed job is queued or running, and
not otherwise (FR-061). Starting a job fetches them at once.

## `/jobs/:jobId`: a job

- **Header**: kind, state, who started it, and the times (queued, started, finished, and "next run at" while waiting
  for one). A **Cancel** button while queued or running, which asks for confirmation (the existing `ConfirmDialog`).
  "Cancelling…" while a cancel is asked and the job still runs. "Its worker was lost. It will run again when a worker
  picks it up, or cancel it to end it now." while `worker_lost`; Cancel then ends it at once. Who cancelled it and when, for a cancelled job.
- **Progress**: the step ("Checking generation", "Checking embeddings") and, where known, done of total.
- **Failure**: the message and the hint, for a failed job (FR-064).
- **Result** (provider check): one block per operation, with provider, model, hosted or local, outcome with its
  message and hint, and that operation's usage.
- **Usage**: runs used of the maximum; caps; totals (tokens, "estimated" where any were, cost or "unknown (at least
  $x)", and "the cost cap could not be applied" when a price was unknown, FR-043); and a table of the usage records.

**Refreshing**: every 2 s while the job is queued or running; stops once it is final (FR-061).

A job that does not exist shows the app's usual "not found" message.
