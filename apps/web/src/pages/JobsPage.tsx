import type { JobsStatus } from '@scrylux/core';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { isActiveJob, useJobs, useJobsStatus, useStartProviderCheck } from '../api/queries.js';
import { writeErrorMessage } from '../api/errors.js';
import { KIND_LABEL, costText, progressLabel, stateLabel, time, tokenText } from '../components/job-format.js';
import { LoadError } from '../components/LoadError.js';

// The Jobs page (Phase 3 Milestone 2, contracts/ui.md): whether AI is configured and where its data goes, the provider
// check, and every job, newest first (FR-061a). It is the one place the list is read, and it reads again while a job it
// shows is active.

function whereData(op: NonNullable<JobsStatus['ai']['generation']>): string {
  return op.hosted ? 'hosted: data sent to it leaves this install' : 'local: data sent to it stays in this install';
}

function operationLine(label: string, op: JobsStatus['ai']['generation']): string {
  return op === null ? `${label}: not configured` : `${label}: ${op.provider}, model ${op.model}, ${whereData(op)}`;
}

/** The time the account may start its next provider check, while that is still ahead (FR-047). */
function useCooldown(nextAllowedAt: string | null | undefined): Date | null {
  // The time as of the last render or timer, kept in state so a render never reads the clock itself.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!nextAllowedAt) return;
    const wait = new Date(nextAllowedAt).getTime() - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(timer);
  }, [nextAllowedAt]);
  return nextAllowedAt && new Date(nextAllowedAt).getTime() > now ? new Date(nextAllowedAt) : null;
}

export function JobsPage() {
  const jobs = useJobs();
  const shown = jobs.data?.pages.flatMap((page) => page.jobs) ?? [];
  const anyActive = shown.some(isActiveJob);
  const status = useJobsStatus(anyActive);
  const start = useStartProviderCheck();
  const cooldown = useCooldown(status.data?.provider_check.next_allowed_at);

  // A job whose worker was lost is said so whether or not another worker is alive; a queued job is, only when none is (FR-062).
  const noWorker = status.data !== undefined && (shown.some((job) => job.worker_lost) || (!status.data.worker_alive && shown.some((job) => job.state === 'queued')));

  return (
    <div>
      <h1>Jobs</h1>

      {status.data && (
        <section aria-labelledby="ai-heading">
          <h2 id="ai-heading">AI</h2>
          <p>{operationLine('Generation', status.data.ai.generation)}</p>
          <p>{operationLine('Embeddings', status.data.ai.embedding)}</p>
          {status.data.provider_check.offered ? (
            <p>
              <button type="button" className="primary" disabled={cooldown !== null || start.isPending} onClick={() => start.mutate()}>
                Check AI provider
              </button>
            </p>
          ) : (
            <p>AI is not configured on this install. An operator can set it up: see docs/ai-providers.md.</p>
          )}
          {cooldown !== null && <p className="muted">You can start the next provider check at {cooldown.toLocaleTimeString()}.</p>}
          {start.isError && <p role="alert" className="form-error">{writeErrorMessage(start.error)}</p>}
        </section>
      )}
      {status.isError && <LoadError error={status.error} onRetry={() => void status.refetch()} />}

      {noWorker && (
        <p role="status" className="notice">
          No worker is processing jobs. Queued jobs will start when an operator starts one.
        </p>
      )}

      {jobs.isPending && <p>Loading…</p>}
      {jobs.isError && <LoadError error={jobs.error} onRetry={() => void jobs.refetch()} />}
      {jobs.data && shown.length === 0 && <p>No jobs yet.</p>}
      {shown.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">State</th>
                <th scope="col">Started by</th>
                <th scope="col">Queued</th>
                <th scope="col">Progress or usage</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((job) => (
                <tr key={job.id}>
                  <td>
                    <Link to={`/jobs/${job.id}`}>{KIND_LABEL[job.kind]}</Link>
                  </td>
                  <td>{stateLabel(job)}</td>
                  <td>{job.started_by.username}</td>
                  <td>{time(job.queued_at)}</td>
                  <td>
                    {job.state === 'running' && job.progress !== null && !job.worker_lost && <span>{progressLabel(job.progress)}</span>}
                    {job.totals.requests > 0 && !isActiveJob(job) && (
                      <>
                        <span>{tokenText(job.totals)}</span> <span>{costText(job.totals)}</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {jobs.hasNextPage && (
        <p>
          <button type="button" disabled={jobs.isFetchingNextPage} onClick={() => void jobs.fetchNextPage()}>
            Show more
          </button>
        </p>
      )}
    </div>
  );
}
